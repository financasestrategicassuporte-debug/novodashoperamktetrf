// api/webinar-products.js — Vercel Serverless Function
// GET /api/webinar-products?range=30 dias    (ou ?start=YYYY-MM-DD&end=YYYY-MM-DD)
//
// Funil "Webnários Quentes" (RD Station CRM) separado por PRODUTO:
//   • PAV                      → faturamento a partir de R$80 mil (faixa "R$80-120k" ou acima)
//   • Acelerador de Matrículas → faturamento abaixo de R$80 mil
// O faturamento vem da descrição/anotação do card ("*Faturamento:* R$20-30k",
// mensagem "NOVO LEAD QUALIFICADO" do SDR). Se o card não tiver, cai pra
// faixa de faturamento da planilha de captação (casada pelo telefone/e-mail).
//
// Para cada produto: agendados (chegaram em "Reunião Agendada" ou além),
// reuniões acontecidas (passaram da etapa de reunião: negociação, venda…),
// custo por agendamento e custo por reunião acontecida (investido Meta Ads
// do período ÷ quantidade daquele produto).
//
// Endpoint independente — não altera /api/data nem /api/webinar-*.
//
// Env: RDSTATION_CRM_TOKEN, META_ACCESS_TOKEN / META_AD_ACCOUNT_ID,
//      RDSTATION_WEBINAR_PIPELINE_ID (opcional)

const RD_TOKEN = process.env.RDSTATION_CRM_TOKEN || '';
const RD_PIPELINE_ID = process.env.RDSTATION_WEBINAR_PIPELINE_ID || '694aabf03f1ed8001d44a46b';
const RD_BASE = 'https://crm.rdstation.com/api/v1';

const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN || '';
const META_AD_ACCOUNT_ID = process.env.META_AD_ACCOUNT_ID || '';
const META_API_VERSION = process.env.META_API_VERSION || 'v20.0';

const SHEET_ID = process.env.SHEET_ID || '1MW_dyf0VOHULceCCtY7FkCR_tLCCkM6YqPY-TQd8fjI';
const SHEET_GID = process.env.SHEET_GID || '1467696356';
const SHEET_CSV_URL = process.env.SHEET_CSV_URL || `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${SHEET_GID}`;

const PAV_THRESHOLD = 80000; // piso da faixa >= isso = PAV

function brl(n) {
  if (n == null || isNaN(n)) return '-';
  return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
}
function toISODate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function rangeToWindow(range) {
  const now = new Date(Date.now() - 3 * 60 * 60 * 1000);
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const today = startOfDay(now);
  const addDays = (d, n) => new Date(d.getTime() + n * 86400000);
  switch (range) {
    case 'Hoje': return { start: today, end: addDays(today, 1) };
    case 'Ontem': return { start: addDays(today, -1), end: today };
    case 'Essa Semana': { const dow = today.getDay(); return { start: addDays(today, -dow), end: addDays(today, 1) }; }
    case 'Esse Mês': return { start: new Date(now.getFullYear(), now.getMonth(), 1), end: addDays(today, 1) };
    case 'Mês Passado': return { start: new Date(now.getFullYear(), now.getMonth() - 1, 1), end: new Date(now.getFullYear(), now.getMonth(), 1) };
    case '7 dias': return { start: addDays(today, -7), end: addDays(today, 1) };
    case '14 dias': return { start: addDays(today, -14), end: addDays(today, 1) };
    case '30 dias': return { start: addDays(today, -30), end: addDays(today, 1) };
    case '90 dias': return { start: addDays(today, -90), end: addDays(today, 1) };
    default: return null;
  }
}

// ---------- casamento telefone / planilha ----------
function parseCSV(text) {
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c === '\r') { /* ignora */ }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}
function phoneKey(raw) {
  if (!raw) return null;
  let s = String(raw).split(/[\/,;]/)[0].trim();
  if (/^\+(?!55)/.test(s) || /^00(?!55)/.test(s)) return null;
  let d = s.replace(/\D/g, '');
  if (d.startsWith('55') && d.length > 11) d = d.slice(2);
  if (d.length < 10) return null;
  return d.slice(0, 2) + d.slice(2).slice(-8);
}
function dealPhone(d) {
  const cf = (d.deal_custom_fields || []).find(
    (x) => x.custom_field && /telefone|whatsapp|celular|\bfone\b/i.test(x.custom_field.label || '')
  );
  if (cf && cf.value) return cf.value;
  for (const c of d.contacts || []) for (const p of c.phones || []) if (p && p.phone) return p.phone;
  return null;
}
function dealEmails(d) {
  const out = [];
  for (const c of d.contacts || []) for (const e of c.emails || []) if (e && e.email) out.push(String(e.email).toLowerCase().trim());
  const cf = (d.deal_custom_fields || []).find((x) => x.custom_field && /e-?mail/i.test(x.custom_field.label || ''));
  if (cf && cf.value) out.push(String(cf.value).toLowerCase().trim());
  return out;
}
function parseSheetDateISO(raw) {
  const m = String(raw || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) return null;
  const hasComma = String(raw).includes(',');
  const [, a, b, y] = m;
  const dd = hasComma ? a : b, mm = hasComma ? b : a;
  return `${y}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
}
// ---------- RD Station: funil + estágios ----------
async function fetchPipeline() {
  if (!RD_TOKEN) return null;
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 9000);
    try {
      const r = await fetch(`${RD_BASE}/deal_pipelines?token=${encodeURIComponent(RD_TOKEN)}`, { signal: controller.signal });
      if (!r.ok) return null;
      const j = await r.json();
      return (Array.isArray(j) ? j : []).find((p) => p.id === RD_PIPELINE_ID) || null;
    } finally { clearTimeout(t); }
  } catch (e) { return null; }
}
async function fetchAllDeals() {
  if (!RD_TOKEN) return { ok: false, reason: 'missing_token', deals: [] };
  try {
    let page = 1;
    const deals = [];
    while (page <= 15) {
      const url = `${RD_BASE}/deals?token=${encodeURIComponent(RD_TOKEN)}&deal_pipeline_id=${RD_PIPELINE_ID}&limit=200&page=${page}`;
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 9000);
      let j;
      try {
        const r = await fetch(url, { signal: controller.signal });
        if (!r.ok) return { ok: false, reason: `HTTP ${r.status}`, deals: [] };
        j = await r.json();
      } finally { clearTimeout(t); }
      deals.push(...(j.deals || []));
      if (!j.has_more || !(j.deals || []).length) break;
      page += 1;
    }
    return { ok: true, deals };
  } catch (e) {
    return { ok: false, reason: e.message || 'fetch_failed', deals: [] };
  }
}


// ---------- faturamento → produto ----------
// "R$20-30k" → 20000 · "R$80-120k" → 80000 · "Acima R$200k" → 200000
// "Até R$10k" → 9999 (teto exclusivo). Retorna o piso da faixa.
export function parseFaturamento(raw) {
  if (!raw) return null;
  const s = String(raw).replace(/\*/g, '').trim();
  if (!s) return null;
  const hasMil = /mil\b/i.test(s);
  const hasK = /\d\s*k\b/i.test(s);
  const cleaned = s.replace(/R\$\s?/gi, '').replace(/(\d)\.(\d{3})(?!\d)/g, '$1$2');
  const nums = cleaned.match(/\d+(?:[.,]\d+)?/g);
  if (!nums) return null;
  let vals = nums.map((n) => parseFloat(n.replace(',', '.')));
  if (hasK || hasMil) vals = vals.map((v) => (v < 1000 ? v * 1000 : v));
  if (!vals.length) return null;
  if (/(^|\s)at[eé](\s|$)/i.test(s) && vals.length === 1) return vals[0] - 1;
  return Math.min(...vals);
}
export function productFromFat(v) {
  if (v == null || isNaN(v)) return null;
  return v >= PAV_THRESHOLD ? 'pav' : 'acelerador';
}
// procura "Faturamento: ..." (e, de reserva, "Produto: ...") num texto livre
export function extractFromText(text) {
  if (!text) return {};
  const t = String(text);
  const out = {};
  const mf = t.match(/faturamento[^:\n]{0,20}:\**\s*([^\n]+)/i);
  if (mf) { const v = parseFaturamento(mf[1]); if (v != null) { out.fat = v; out.fatRaw = mf[1].replace(/\*/g, '').trim(); } }
  const mp = t.match(/produto[^:\n]{0,20}:\**\s*([^\n]+)/i);
  if (mp) {
    if (/\bPAV\b|acelera[cç][aã]o de vendas/i.test(mp[1])) out.prod = 'pav';
    else if (/acelerador|matr[ií]cula/i.test(mp[1])) out.prod = 'acelerador';
  }
  return out;
}
// negócios de treino/teste do time ficam fora da conta:
// "Treino" no nome ou "(Treino)" na descrição/anotação do card
export const TREINO_NOME = /\btreino\b/i;
export const TREINO_DESC = /[(\[]\s*treino\s*[)\]]/i;

// junta todas as strings de um objeto (campos personalizados, descrição…)
function allStrings(obj, out = [], depth = 0) {
  if (obj == null || depth > 5) return out;
  if (typeof obj === 'string') { out.push(obj); return out; }
  if (Array.isArray(obj)) { for (const x of obj) allStrings(x, out, depth + 1); return out; }
  if (typeof obj === 'object') for (const k of Object.keys(obj)) allStrings(obj[k], out, depth + 1);
  return out;
}

// ---------- planilha: faixa de faturamento por telefone/e-mail ----------
async function fetchSheetFat() {
  const empty = { ok: false, byPhone: new Map(), byEmail: new Map() };
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 9000);
    let text, ok, ct;
    try {
      const r = await fetch(SHEET_CSV_URL, { redirect: 'follow', headers: { 'User-Agent': 'DashboardBot/1.0', Accept: 'text/csv,*/*' }, signal: controller.signal });
      ok = r.ok; ct = r.headers.get('content-type') || ''; text = await r.text();
    } finally { clearTimeout(t); }
    if (!ok || ct.includes('text/html') || /^\s*<!DOCTYPE/i.test(text)) return empty;
    const rows = parseCSV(text).filter((r) => r.some((c) => (c || '').trim() !== ''));
    const hi = rows.findIndex((r) => r.some((c) => /nome|name/i.test(c)));
    const header = hi >= 0 ? rows[hi] : rows[0];
    const dataRows = rows.slice((hi >= 0 ? hi : 0) + 1);
    const col = (...names) => {
      for (const n of names) { const i = header.findIndex((h) => h.trim().toLowerCase().includes(n.toLowerCase())); if (i >= 0) return i; }
      return -1;
    };
    const ci = { phone: col('Phone', 'Telefone', 'WhatsApp', 'Celular'), email: col('Email', 'E-mail'), fat: col('faturamento') };
    const byPhone = new Map(), byEmail = new Map();
    for (const r of dataRows) {
      const fat = ci.fat >= 0 ? parseFaturamento(r[ci.fat]) : null;
      if (fat == null) continue;
      const pk = ci.phone >= 0 ? phoneKey(r[ci.phone]) : null;
      if (pk) byPhone.set(pk, fat); // última ocorrência vence (cadastro mais recente)
      const em = ci.email >= 0 ? String(r[ci.email] || '').toLowerCase().trim() : '';
      if (em) byEmail.set(em, fat);
    }
    return { ok: true, byPhone, byEmail };
  } catch (e) { return empty; }
}

// ---------- Meta Ads: investido total do período (conta toda) ----------
async function fetchMetaSpend({ since, until }) {
  if (!META_ACCESS_TOKEN || !META_AD_ACCOUNT_ID) return { ok: false, spend: 0 };
  const acct = META_AD_ACCOUNT_ID.startsWith('act_') ? META_AD_ACCOUNT_ID : `act_${META_AD_ACCOUNT_ID}`;
  const params = new URLSearchParams({
    level: 'account', fields: 'spend',
    time_range: JSON.stringify({ since, until }), time_increment: 'all_days',
    access_token: META_ACCESS_TOKEN,
  });
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 9000);
    try {
      const res = await fetch(`https://graph.facebook.com/${META_API_VERSION}/${acct}/insights?${params}`, { signal: controller.signal });
      const json = await res.json();
      if (!res.ok || json.error) return { ok: false, spend: 0 };
      const spend = (json.data || []).reduce((s, r) => s + (parseFloat(r.spend || '0') || 0), 0);
      return { ok: true, spend };
    } finally { clearTimeout(t); }
  } catch (e) { return { ok: false, spend: 0 }; }
}

// ---------- RD Station: anotações do negócio (cache em memória) ----------
const notesCache = new Map(); // deal id -> { at, info }
async function fetchDealNotesInfo(dealId) {
  const hit = notesCache.get(dealId);
  if (hit && Date.now() - hit.at < (hit.info.fat != null ? 15 * 60e3 : 2 * 60e3)) return hit.info;
  const info = {};
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 8000);
    try {
      const r = await fetch(`${RD_BASE}/activities?token=${encodeURIComponent(RD_TOKEN)}&deal_id=${encodeURIComponent(dealId)}&limit=50`, { signal: controller.signal });
      if (r.ok) {
        const j = await r.json();
        const acts = Array.isArray(j) ? j : (j.activities || j.data || []);
        // a anotação mais recente com faturamento vence
        const sorted = acts.slice().sort((a, b) => String(b.date || b.created_at || '').localeCompare(String(a.date || a.created_at || '')));
        for (const a of sorted) {
          const txt = a.text || a.description || a.body || '';
          if (TREINO_DESC.test(txt)) info.treino = true;
          const ex = extractFromText(txt);
          if (ex.prod && !info.prod) info.prod = ex.prod;
          if (ex.fat != null && info.fat == null) { info.fat = ex.fat; info.fatRaw = ex.fatRaw; }
        }
        info.acts = acts.length;
      } else info.err = r.status;
    } finally { clearTimeout(t); }
  } catch (e) { info.err = e.message || 'fail'; }
  notesCache.set(dealId, { at: Date.now(), info });
  return info;
}
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  });
  await Promise.all(workers);
  return out;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
  try {
    const { range, start: startParam, end: endParam } = req.query || {};
    const window = (startParam && endParam)
      ? { start: new Date(startParam + 'T00:00:00-03:00'), end: new Date(new Date(endParam + 'T00:00:00-03:00').getTime() + 86400000) }
      : (range ? rangeToWindow(range) : null);

    const metaWindow = window || rangeToWindow('30 dias');
    const metaSince = toISODate(metaWindow.start);
    const metaUntil = toISODate(new Date(metaWindow.end.getTime() - 86400000));

    const [{ ok, reason, deals }, sheet, meta, pipeline] = await Promise.all([
      fetchAllDeals(),
      fetchSheetFat(),
      fetchMetaSpend({ since: metaSince, until: metaUntil }),
      fetchPipeline(),
    ]);

    // ---- estágios: agendado = "Reunião Agendada" ou além; acontecida = passou das etapas de reunião
    const stagesOrdered = (pipeline && pipeline.deal_stages ? pipeline.deal_stages : [])
      .slice().sort((a, b) => (a.order || 0) - (b.order || 0));
    const sid = (s) => s.id || s._id;
    const raStage = stagesOrdered.find((s) => /reuni[aã]o agendada/i.test(s.name || ''));
    const raOrder = raStage ? (raStage.order || 0) : 3;
    const notHappened = /remarcar|no.?show|n[aã]o compareceu|cancelad|agendad/i;
    const realizadaStage = stagesOrdered.find((s) => /realizad|aconteceu/i.test(s.name || ''));
    const lastMeetingOrder = Math.max(raOrder, ...stagesOrdered
      .filter((s) => (s.order || 0) >= raOrder && notHappened.test(s.name || '')).map((s) => s.order || 0));
    const happenedFrom = realizadaStage ? (realizadaStage.order || 0) : lastMeetingOrder + 1;
    const agendadoIds = new Set(stagesOrdered.filter((s) => (s.order || 0) >= raOrder).map(sid));
    const aconteceuIds = new Set(stagesOrdered
      .filter((s) => (s.order || 0) >= happenedFrom && !notHappened.test(s.name || '')).map(sid));

    const stageIdOf = (d) => (d.deal_stage && (d.deal_stage.id || d.deal_stage._id)) || null;
    const isAgendado = (d) => d.win === true || agendadoIds.has(stageIdOf(d));
    const isAconteceu = (d) => d.win === true || aconteceuIds.has(stageIdOf(d));

    const agendadosAll = deals.filter((d) => {
      if (window) {
        const c = d.created_at ? new Date(d.created_at) : null;
        if (!(c && c >= window.start && c < window.end)) return false;
      }
      return isAgendado(d);
    });

    // ---- produto de cada agendado: 1) campos/descrição do card 2) anotações 3) planilha 4) linha "Produto:"
    // "Treino" no nome / "(Treino)" na descrição → desconsiderado
    const classify = async (d) => {
      const ownText = allStrings([d.deal_custom_fields, d.description, d.notes]).join('\n');
      const notes = RD_TOKEN ? await fetchDealNotesInfo(d.id || d._id) : {};
      if (TREINO_NOME.test(d.name || '') || TREINO_DESC.test(ownText) || notes.treino) return { treino: true };
      const own = extractFromText(ownText);
      if (own.fat != null) return { prod: productFromFat(own.fat), src: 'card', fatRaw: own.fatRaw };
      if (notes.fat != null) return { prod: productFromFat(notes.fat), src: 'anotacao', fatRaw: notes.fatRaw };
      const pk = phoneKey(dealPhone(d));
      let sf = pk ? sheet.byPhone.get(pk) : null;
      if (sf == null) for (const em of dealEmails(d)) { if (sheet.byEmail.has(em)) { sf = sheet.byEmail.get(em); break; } }
      if (sf != null) return { prod: productFromFat(sf), src: 'planilha' };
      const prodHint = own.prod || notes.prod;
      if (prodHint) return { prod: prodHint, src: 'produto' };
      return { prod: null, src: 'nenhum', notes };
    };
    const classesAll = await mapLimit(agendadosAll, 8, classify);
    const treinoCount = classesAll.filter((c) => c.treino).length;
    const agendados = agendadosAll.filter((_, i) => !classesAll[i].treino);
    const classes = classesAll.filter((c) => !c.treino);

    const blank = () => ({ agendados: 0, acontecidas: 0 });
    const agg = { acelerador: blank(), pav: blank(), indefinido: blank() };
    const sources = { card: 0, anotacao: 0, planilha: 0, produto: 0, nenhum: 0 };
    agendados.forEach((d, i) => {
      const c = classes[i];
      sources[c.src] += 1;
      const g = agg[c.prod || 'indefinido'];
      g.agendados += 1;
      if (isAconteceu(d)) g.acontecidas += 1;
    });

    const spend = meta.ok ? meta.spend : null;
    const per = (n) => (spend != null && n > 0 ? spend / n : null);
    const productOut = (key, label) => {
      const g = agg[key];
      const cpa = per(g.agendados), cpr = per(g.acontecidas);
      return {
        key, label,
        agendados: g.agendados,
        acontecidas: g.acontecidas,
        comparecimento: g.agendados ? Math.round((g.acontecidas / g.agendados) * 100) : null,
        custoAgendamento: cpa != null ? Math.round(cpa) : null,
        custoAgendamentoLabel: cpa != null ? brl(cpa) : '-',
        custoReuniao: cpr != null ? Math.round(cpr) : null,
        custoReuniaoLabel: cpr != null ? brl(cpr) : '-',
      };
    };

    // diagnóstico sem dados pessoais: etapas do funil e de onde veio o faturamento
    console.log('[webinar-products]', JSON.stringify({
      stages: stagesOrdered.map((s) => s.name), sources, agendados: agendados.length,
      semFat: classes.filter((c) => c.src === 'nenhum').slice(0, 3).map((c) => c.notes),
      fatSamples: classes.filter((c) => c.fatRaw).slice(0, 5).map((c) => c.fatRaw),
    }));

    res.status(200).json({
      connected: ok,
      error: ok ? null : reason,
      pipeline: pipeline ? pipeline.name : 'Webnários Quentes',
      products: [productOut('acelerador', 'Acelerador de Matrículas'), productOut('pav', 'PAV')],
      indefinidos: agg.indefinido,
      agendadosTotal: agendados.length,
      treinoIgnorados: treinoCount,
      sources,
      invest: spend != null ? Math.round(spend) : null,
      investLabel: spend != null ? brl(spend) : '-',
      metaConnected: meta.ok,
      sheetConnected: sheet.ok,
      stagesAgendado: stagesOrdered.filter((s) => agendadoIds.has(sid(s))).map((s) => s.name),
      stagesAcontecida: stagesOrdered.filter((s) => aconteceuIds.has(sid(s))).map((s) => s.name),
      range: window ? { since: toISODate(window.start), until: toISODate(new Date(window.end.getTime() - 86400000)) } : null,
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message, connected: false });
  }
}
