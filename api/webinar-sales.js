// api/webinar-sales.js — Vercel Serverless Function
// GET /api/webinar-sales?range=7 dias        (ou ?start=YYYY-MM-DD&end=YYYY-MM-DD)
//
// Puxa as VENDAS (deals win=true) do funil "Webnários Quentes" no RD Station CRM
// e cruza pela região a partir do DDD do telefone do deal, para responder
// "de quais regiões estão vindo as vendas".
//
// Variáveis de ambiente (Vercel → Project → Settings → Environment Variables):
//   RDSTATION_CRM_TOKEN            (obrigatório — token da instância do RD Station CRM)
//   RDSTATION_WEBINAR_PIPELINE_ID  (opcional — default já é o funil "Webnários Quentes")

const RD_TOKEN = process.env.RDSTATION_CRM_TOKEN || '';
const RD_PIPELINE_ID = process.env.RDSTATION_WEBINAR_PIPELINE_ID || '694aabf03f1ed8001d44a46b';
const RD_BASE = 'https://crm.rdstation.com/api/v1';

// ---------- Geografia: DDD -> UF / região ----------
const DDD_UF = {
  11: 'SP', 12: 'SP', 13: 'SP', 14: 'SP', 15: 'SP', 16: 'SP', 17: 'SP', 18: 'SP', 19: 'SP',
  21: 'RJ', 22: 'RJ', 24: 'RJ', 27: 'ES', 28: 'ES',
  31: 'MG', 32: 'MG', 33: 'MG', 34: 'MG', 35: 'MG', 37: 'MG', 38: 'MG',
  41: 'PR', 42: 'PR', 43: 'PR', 44: 'PR', 45: 'PR', 46: 'PR',
  47: 'SC', 48: 'SC', 49: 'SC',
  51: 'RS', 53: 'RS', 54: 'RS', 55: 'RS',
  61: 'DF', 62: 'GO', 64: 'GO', 63: 'TO', 65: 'MT', 66: 'MT', 67: 'MS',
  68: 'AC', 69: 'RO',
  71: 'BA', 73: 'BA', 74: 'BA', 75: 'BA', 77: 'BA', 79: 'SE',
  81: 'PE', 87: 'PE', 82: 'AL', 83: 'PB', 84: 'RN', 85: 'CE', 88: 'CE', 86: 'PI', 89: 'PI',
  91: 'PA', 93: 'PA', 94: 'PA', 92: 'AM', 97: 'AM', 95: 'RR', 96: 'AP', 98: 'MA', 99: 'MA',
};
const UF_NOME = {
  AC: 'Acre', AL: 'Alagoas', AP: 'Amapá', AM: 'Amazonas', BA: 'Bahia', CE: 'Ceará',
  DF: 'Distrito Federal', ES: 'Espírito Santo', GO: 'Goiás', MA: 'Maranhão', MT: 'Mato Grosso',
  MS: 'Mato Grosso do Sul', MG: 'Minas Gerais', PA: 'Pará', PB: 'Paraíba', PR: 'Paraná',
  PE: 'Pernambuco', PI: 'Piauí', RJ: 'Rio de Janeiro', RN: 'Rio Grande do Norte',
  RS: 'Rio Grande do Sul', RO: 'Rondônia', RR: 'Roraima', SC: 'Santa Catarina',
  SP: 'São Paulo', SE: 'Sergipe', TO: 'Tocantins',
};
const UF_REGIAO = {
  AC: 'Norte', AP: 'Norte', AM: 'Norte', PA: 'Norte', RO: 'Norte', RR: 'Norte', TO: 'Norte',
  AL: 'Nordeste', BA: 'Nordeste', CE: 'Nordeste', MA: 'Nordeste', PB: 'Nordeste',
  PE: 'Nordeste', PI: 'Nordeste', RN: 'Nordeste', SE: 'Nordeste',
  DF: 'Centro-Oeste', GO: 'Centro-Oeste', MT: 'Centro-Oeste', MS: 'Centro-Oeste',
  ES: 'Sudeste', MG: 'Sudeste', RJ: 'Sudeste', SP: 'Sudeste',
  PR: 'Sul', RS: 'Sul', SC: 'Sul',
};
const REGIAO_ORDER = ['Norte', 'Nordeste', 'Centro-Oeste', 'Sudeste', 'Sul'];

function ufFromPhone(raw) {
  if (!raw) return null;
  let s = String(raw).split(/[\/,;]/)[0].trim();
  // número internacional explícito que não seja Brasil (+55) fica de fora
  if (/^\+(?!55)/.test(s) || /^00(?!55)/.test(s)) return null;
  let digits = s.replace(/\D/g, '');
  if (digits.startsWith('55') && digits.length > 11) digits = digits.slice(2);
  if (digits.length < 10 || digits.length > 13) return null;
  const ddd = parseInt(digits.slice(0, 2), 10);
  return DDD_UF[ddd] || null;
}

// ---------- Janela de datas (mesma régua do /api/data) ----------
function rangeToWindow(range) {
  const now = new Date(Date.now() - 3 * 60 * 60 * 1000); // hora de Brasília
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

function dealPhone(d) {
  const cf = (d.deal_custom_fields || []).find(
    (x) => x.custom_field && /telefone|whatsapp|celular|\bfone\b/i.test(x.custom_field.label || '')
  );
  if (cf && cf.value) return cf.value;
  for (const c of d.contacts || []) {
    for (const p of c.phones || []) if (p && p.phone) return p.phone;
  }
  return null;
}

function brl(n) {
  if (n == null || isNaN(n)) return '-';
  return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
}

async function fetchWonDeals() {
  if (!RD_TOKEN) return { ok: false, reason: 'missing_token', deals: [] };
  try {
    let page = 1;
    const deals = [];
    while (page <= 10) {
      const url = `${RD_BASE}/deals?token=${encodeURIComponent(RD_TOKEN)}&deal_pipeline_id=${RD_PIPELINE_ID}&win=true&limit=200&page=${page}`;
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 9000);
      let j;
      try {
        const r = await fetch(url, { signal: controller.signal });
        if (!r.ok) return { ok: false, reason: `HTTP ${r.status}`, deals: [] };
        j = await r.json();
      } finally {
        clearTimeout(t);
      }
      deals.push(...(j.deals || []));
      if (!j.has_more || !(j.deals || []).length) break;
      page += 1;
    }
    return { ok: true, deals };
  } catch (e) {
    return { ok: false, reason: e.message || 'fetch_failed', deals: [] };
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=120');
  try {
    const { range, start: startParam, end: endParam } = req.query || {};
    const window = (startParam && endParam)
      ? { start: new Date(startParam + 'T00:00:00'), end: new Date(new Date(endParam + 'T00:00:00').getTime() + 86400000) }
      : (range ? rangeToWindow(range) : null);

    const { ok, reason, deals } = await fetchWonDeals();

    const stateAgg = new Map();       // UF -> { count, amount }
    const regionAgg = {};             // regiao -> { count, amount }
    let total = 0, amountTotal = 0, semRegiao = 0;

    for (const d of deals) {
      const closed = d.closed_at ? new Date(d.closed_at) : null;
      if (window && closed && (closed < window.start || closed >= window.end)) continue;
      total += 1;
      // amount_total às vezes vem com erro de digitação (ex.: 24.500.000) — a
      // venda conta sempre, mas valores absurdos ficam de fora da soma de R$.
      const raw = Number(d.amount_total) || 0;
      const amt = raw > 0 && raw <= 300000 ? raw : 0;
      amountTotal += amt;

      const uf = ufFromPhone(dealPhone(d));
      if (!uf) { semRegiao += 1; continue; }
      const reg = UF_REGIAO[uf] || 'Outros';
      if (!stateAgg.has(uf)) stateAgg.set(uf, { count: 0, amount: 0 });
      stateAgg.get(uf).count += 1;
      stateAgg.get(uf).amount += amt;
      if (!regionAgg[reg]) regionAgg[reg] = { count: 0, amount: 0 };
      regionAgg[reg].count += 1;
      regionAgg[reg].amount += amt;
    }

    const comRegiao = total - semRegiao;
    const salesByRegion = REGIAO_ORDER.map((reg) => {
      const g = regionAgg[reg] || { count: 0, amount: 0 };
      const ufs = Array.from(stateAgg.entries())
        .filter(([uf]) => UF_REGIAO[uf] === reg)
        .map(([uf, s]) => ({ uf, count: s.count }))
        .sort((a, b) => b.count - a.count || a.uf.localeCompare(b.uf));
      return {
        regiao: reg,
        count: g.count,
        amount: Math.round(g.amount),
        amountLabel: g.amount ? brl(g.amount) : '-',
        ticketMedio: (g.count && g.amount) ? Math.round(g.amount / g.count) : 0,
        ticketLabel: (g.count && g.amount) ? brl(g.amount / g.count) : '-',
        pct: comRegiao ? Math.round((g.count / comRegiao) * 100) : 0,
        estados: ufs,
        estadosLabel: ufs.length ? ufs.map((e) => e.uf).join(', ') : '',
      };
    });
    const salesByState = Array.from(stateAgg.entries())
      .map(([uf, g]) => ({
        uf, nome: UF_NOME[uf] || uf, regiao: UF_REGIAO[uf] || '-',
        count: g.count, amount: Math.round(g.amount), amountLabel: g.amount ? brl(g.amount) : '-',
        pct: comRegiao ? Math.round((g.count / comRegiao) * 100) : 0,
      }))
      .sort((a, b) => b.count - a.count || b.amount - a.amount);

    res.status(200).json({
      connected: ok,
      error: ok ? null : reason,
      pipeline: 'Webnários Quentes',
      salesTotal: total,
      salesAmount: Math.round(amountTotal),
      salesAmountLabel: amountTotal ? brl(amountTotal) : '-',
      ticketMedioLabel: total ? brl(amountTotal / total) : '-',
      salesSemRegiao: semRegiao,
      salesByRegion,
      salesByState,
      range: window ? { since: window.start.toISOString().slice(0, 10) } : null,
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message, connected: false });
  }
}
