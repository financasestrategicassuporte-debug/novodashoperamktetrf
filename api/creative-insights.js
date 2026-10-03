// api/creative-insights.js — Vercel Serverless Function
// POST /api/creative-insights   { range, creatives: [...], force? }
//
// Análise por IA (Claude) dos criativos que mais trouxeram LEADS QUALIFICADOS
// (faturamento >= R$50k, mesma régua do card Top Criativos). O frontend manda
// a lista que já tem (apiData.creativesList: nome, campanha, leads, qualif,
// investido, CPL, CPL qualif, CTR); aqui buscamos no Meta Ads o texto e a
// imagem de cada anúncio e pedimos ao Claude o PORQUÊ dos melhores terem dado
// certo, comparando com os que não trouxeram lead qualificado.
//
// Env: ANTHROPIC_API_KEY (obrigatório p/ a IA), META_ACCESS_TOKEN / META_AD_ACCOUNT_ID

import Anthropic from '@anthropic-ai/sdk';

export const config = { maxDuration: 120 };

const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN || '';
const META_AD_ACCOUNT_ID = process.env.META_AD_ACCOUNT_ID || '';
const META_API_VERSION = process.env.META_API_VERSION || 'v20.0';
const MODEL = 'claude-opus-5-5';

// ---------- casamento criativo (utm_content) × nome do anúncio — mesma régua do /api/data ----------
function normTag(s) {
  return (s || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Z0-9]+/g, ' ').trim();
}
function tagsMatch(a, b) {
  const na = normTag(a), nb = normTag(b);
  if (!na || !nb) return false;
  if (na === nb || na.includes(nb) || nb.includes(na)) return true;
  const A = na.split(' '), B = nb.split(' ');
  const [S, L] = A.length <= B.length ? [A, B] : [B, A];
  if (L.length - S.length > 1) return false;
  const eqSeq = (x, y) => x.length === y.length && x.every((t, i) => t === y[i]);
  if (eqSeq(S, L)) return true;
  for (let i = 0; i < L.length; i++) {
    const t = L[i];
    if (!(t.length <= 2 || /^\d+$/.test(t))) continue;
    if (eqSeq(S, L.slice(0, i).concat(L.slice(i + 1)))) return true;
  }
  return false;
}

// ---------- Meta Ads: texto + imagem dos anúncios ----------
async function fetchAdCreatives() {
  if (!META_ACCESS_TOKEN || !META_AD_ACCOUNT_ID) return [];
  const acct = META_AD_ACCOUNT_ID.startsWith('act_') ? META_AD_ACCOUNT_ID : `act_${META_AD_ACCOUNT_ID}`;
  const fields = 'name,creative.thumbnail_width(600).thumbnail_height(600){title,body,image_url,thumbnail_url,video_id,object_story_spec{link_data{message,name,description},video_data{message,title}},asset_feed_spec{bodies,titles}}';
  let url = `https://graph.facebook.com/${META_API_VERSION}/${acct}/ads?${new URLSearchParams({ fields, limit: '200', access_token: META_ACCESS_TOKEN })}`;
  const out = [];
  for (let page = 0; page < 4 && url; page++) {
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 9000);
      let json;
      try {
        const r = await fetch(url, { signal: controller.signal });
        json = await r.json();
        if (!r.ok || json.error) break;
      } finally { clearTimeout(t); }
      out.push(...(json.data || []));
      url = json.paging && json.paging.next ? json.paging.next : null;
    } catch (e) { break; }
  }
  return out;
}
function creativeText(ad) {
  const c = ad.creative || {};
  const oss = c.object_story_spec || {};
  const ld = oss.link_data || {}, vd = oss.video_data || {};
  const afs = c.asset_feed_spec || {};
  const bodies = [c.body, ld.message, vd.message, ...((afs.bodies || []).map((b) => b && b.text))].filter(Boolean);
  const titles = [c.title, ld.name, vd.title, ...((afs.titles || []).map((b) => b && b.text))].filter(Boolean);
  const uniq = (arr) => Array.from(new Set(arr.map((s) => String(s).trim()))).filter(Boolean);
  return {
    texto: uniq(bodies).slice(0, 3).join('\n---\n').slice(0, 2500),
    titulo: uniq(titles).slice(0, 3).join(' | ').slice(0, 300),
    descricao: (ld.description || '').slice(0, 300),
    formato: c.video_id ? 'vídeo (só a capa/miniatura está disponível)' : 'imagem',
    imageUrl: c.image_url || c.thumbnail_url || null,
  };
}
async function fetchImageBase64(url) {
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 7000);
    try {
      const r = await fetch(url, { signal: controller.signal });
      if (!r.ok) return null;
      const type = (r.headers.get('content-type') || '').split(';')[0].trim();
      if (!/^image\/(jpeg|png|gif|webp)$/.test(type)) return null;
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > 3.5 * 1024 * 1024) return null;
      return { media_type: type, data: buf.toString('base64') };
    } finally { clearTimeout(t); }
  } catch (e) { return null; }
}

// ---------- saída estruturada ----------
const SCHEMA = {
  type: 'object',
  properties: {
    resumo: { type: 'string', description: 'Conclusão principal em 2 a 3 frases: por que os melhores criativos trouxeram lead qualificado.' },
    criativos: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          nome: { type: 'string', description: 'Nome do criativo exatamente como veio nos dados.' },
          motivos: { type: 'array', items: { type: 'string' }, description: '2 a 4 motivos concretos, ancorados no texto/imagem/números.' },
          atencao: { type: 'string', description: 'Um ponto de atenção ou risco (ex.: amostra pequena, custo alto). Vazio se não houver.' },
        },
        required: ['nome', 'motivos', 'atencao'],
        additionalProperties: false,
      },
    },
    padroes: { type: 'array', items: { type: 'string' }, description: 'Padrões em comum entre os vencedores que os perdedores não têm.' },
    recomendacoes: { type: 'array', items: { type: 'string' }, description: 'Ações práticas para os próximos criativos.' },
    confianca: { type: 'string', description: 'baixa, média ou alta + o porquê (tamanho da amostra, dados faltando).' },
  },
  required: ['resumo', 'criativos', 'padroes', 'recomendacoes', 'confianca'],
  additionalProperties: false,
};

const SYSTEM = `Você é um estrategista de tráfego pago e copywriting de resposta direta. Analisa anúncios do Meta Ads de uma empresa de mentoria/aceleração para DONOS DE ACADEMIA (produtos: Acelerador de Matrículas para academias menores e PAV para academias que faturam mais). O objetivo dos anúncios é captar leads QUALIFICADOS — donos de academia com faturamento mensal a partir de R$50 mil.

Explique por que os criativos que mais trouxeram leads qualificados deram certo. Regras:
- Baseie cada motivo no que foi fornecido: texto do anúncio, título, imagem/capa, nome do criativo e as métricas (leads, leads qualificados, % qualificado, custo por lead qualificado, CTR). Cite o trecho ou elemento concreto.
- Compare com os criativos que trouxeram poucos ou nenhum lead qualificado — o contraste é o que mostra o motivo.
- Pense em: público que a mensagem atrai (dono de academia maior × menor), dor/promessa, gancho, prova, filtro de qualificação na copy, formato e CTA.
- Quando um anúncio for vídeo, você só vê a capa: não invente o que é dito no vídeo; se o nome do criativo sugerir o tema (ex.: "Entrevista", "Outdoor"), pode usar como indício e diga que é indício.
- Se faltar texto/imagem ou a amostra for pequena (poucos leads), diga isso e reduza a confiança — não trate coincidência como causa.
- Responda em português do Brasil, direto, sem jargão desnecessário. Liste em "criativos" só os que trouxeram lead qualificado, do melhor para o pior.`;

const cache = new Map(); // chave -> { at, body }
const CACHE_MS = 6 * 60 * 60 * 1000;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const creatives = Array.isArray(body && body.creatives) ? body.creatives.slice(0, 8) : [];
  const range = String((body && body.range) || '').slice(0, 40);
  const force = !!(body && body.force);

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(200).json({ ok: false, reason: 'missing_key', message: 'Falta a variável ANTHROPIC_API_KEY no projeto da Vercel para a IA funcionar.' });
  }
  const clean = creatives.map((c) => ({
    nome: String(c.nome || '').slice(0, 160),
    campanha: String(c.camp || '').slice(0, 160),
    leads: Number(c.leads) || 0,
    qualif: Number(c.qualif) || 0,
    investido: String(c.invest || '-').slice(0, 30),
    cpl: String(c.cpl || '-').slice(0, 30),
    cplQualif: String(c.cplq || '-').slice(0, 30),
    ctr: String(c.ctr || '-').slice(0, 20),
  })).filter((c) => c.nome);
  if (!clean.some((c) => c.qualif > 0)) {
    return res.status(200).json({ ok: false, reason: 'no_qualified', message: 'Nenhum criativo trouxe lead qualificado no período — escolha um período maior para a IA ter o que analisar.' });
  }

  const key = range + '|' + clean.map((c) => `${c.nome}:${c.leads}:${c.qualif}`).join('|');
  const hit = cache.get(key);
  if (!force && hit && Date.now() - hit.at < CACHE_MS) return res.status(200).json({ ...hit.body, cached: true });

  try {
    // 1) texto + imagem de cada criativo no Meta Ads
    const ads = await fetchAdCreatives();
    const enriched = await Promise.all(clean.map(async (c) => {
      const ad = ads.find((a) => tagsMatch(c.nome, a.name));
      const info = ad ? creativeText(ad) : null;
      const img = info && info.imageUrl && c.qualif > 0 ? await fetchImageBase64(info.imageUrl) : null;
      return { ...c, info, img };
    }));

    // 2) monta a mensagem: um bloco de texto por criativo + a imagem logo depois
    const content = [{
      type: 'text',
      text: `Período: ${range || 'padrão do dashboard'}. Lead qualificado = faturamento mensal >= R$50 mil. Criativos ordenados por leads qualificados (do mais para o menos):`,
    }];
    enriched.forEach((c, i) => {
      const pct = c.leads ? Math.round((c.qualif / c.leads) * 100) : 0;
      const linhas = [
        `### Criativo ${i + 1}: ${c.nome}`,
        `Campanha: ${c.campanha || '-'}`,
        `Leads: ${c.leads} · Leads qualificados: ${c.qualif} (${pct}% qualificado) · Investido: ${c.investido} · CPL: ${c.cpl} · CPL qualificado: ${c.cplQualif} · CTR: ${c.ctr}`,
      ];
      if (c.info) {
        linhas.push(`Formato: ${c.info.formato}`);
        if (c.info.titulo) linhas.push(`Título: ${c.info.titulo}`);
        if (c.info.texto) linhas.push(`Texto do anúncio:\n${c.info.texto}`);
        if (c.info.descricao) linhas.push(`Descrição: ${c.info.descricao}`);
        if (!c.info.texto && !c.info.titulo) linhas.push('(texto do anúncio não disponível no Meta Ads)');
      } else {
        linhas.push('(anúncio não encontrado no Meta Ads — só o nome e as métricas)');
      }
      if (c.img) linhas.push('Imagem/capa do anúncio logo abaixo.');
      content.push({ type: 'text', text: linhas.join('\n') });
      if (c.img) content.push({ type: 'image', source: { type: 'base64', media_type: c.img.media_type, data: c.img.data } });
    });

    // 3) Claude — saída em JSON validada pelo schema; fallback do servidor se o modelo recusar
    const client = new Anthropic();
    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: SYSTEM,
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
      messages: [{ role: 'user', content }],
    });

    if (response.stop_reason === 'refusal') {
      return res.status(200).json({ ok: false, reason: 'refusal', message: 'A IA não conseguiu gerar a análise desta vez. Tente atualizar.' });
    }
    if (response.stop_reason === 'max_tokens') {
      return res.status(200).json({ ok: false, reason: 'max_tokens', message: 'A análise ficou longa demais e foi cortada. Tente atualizar.' });
    }
    const textBlock = response.content.find((b) => b.type === 'text');
    let analise;
    try { analise = JSON.parse(textBlock ? textBlock.text : ''); } catch (e) {
      return res.status(200).json({ ok: false, reason: 'parse', message: 'A IA respondeu num formato inesperado. Tente atualizar.' });
    }

    const out = {
      ok: true,
      analise,
      cobertura: {
        criativos: enriched.length,
        comTexto: enriched.filter((c) => c.info && (c.info.texto || c.info.titulo)).length,
        comImagem: enriched.filter((c) => c.img).length,
      },
      modelo: response.model,
      geradoEm: new Date().toISOString(),
    };
    cache.set(key, { at: Date.now(), body: out });
    return res.status(200).json(out);
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) {
      return res.status(200).json({ ok: false, reason: 'auth', message: 'A chave ANTHROPIC_API_KEY configurada na Vercel foi recusada. Confira a chave.' });
    }
    if (err instanceof Anthropic.RateLimitError) {
      return res.status(200).json({ ok: false, reason: 'rate_limit', message: 'Limite de uso da IA atingido agora. Tente de novo em alguns minutos.' });
    }
    if (err instanceof Anthropic.APIError) {
      return res.status(200).json({ ok: false, reason: 'api_error', message: `Erro da IA (${err.status}). Tente atualizar.` });
    }
    return res.status(500).json({ ok: false, reason: 'error', message: err.message });
  }
}
