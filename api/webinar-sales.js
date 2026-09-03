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
function toISODate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ---------- Meta Ads: investimento por criativo (mesma régua do /api/data) ----------
const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN || '';
const META_AD_ACCOUNT_ID = process.env.META_AD_ACCOUNT_ID || '';
const META_API_VERSION = process.env.META_API_VERSION || 'v20.0';

function normTag(s) {
  return (s || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Z0-9]+/g, ' ').trim();
}
function tagsMatch(a, b) {
  const na = normTag(a), nb = normTag(b);
  if (!na || !nb) return false;
  return na === nb || na.includes(nb) || nb.includes(na);
}

async function fetchMetaAdInsights({ since, until }) {
  if (!META_ACCESS_TOKEN || !META_AD_ACCOUNT_ID) return { ok: false, rows: [] };
  const acct = META_AD_ACCOUNT_ID.startsWith('act_') ? META_AD_ACCOUNT_ID : `act_${META_AD_ACCOUNT_ID}`;
  const params = new URLSearchParams({
    level: 'ad',
    fields: 'ad_name,campaign_name,adset_name,spend',
    time_range: JSON.stringify({ since, until }),
    time_increment: 'all_days', limit: '400',
    access_token: META_ACCESS_TOKEN,
  });
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 9000);
    let json;
    try {
      const res = await fetch(`https://graph.facebook.com/${META_API_VERSION}/${acct}/insights?${params}`, { signal: controller.signal });
      json = await res.json();
      if (!res.ok || json.error) return { ok: false, rows: [] };
    } finally { clearTimeout(t); }
    return { ok: true, rows: json.data || [] };
  } catch (e) {
    return { ok: false, rows: [] };
  }
}

// ---------- Planilha de captação (Google Sheets CSV) — pra casar venda -> criativo ----------
const SHEET_ID = process.env.SHEET_ID || '1MW_dyf0VOHULceCCtY7FkCR_tLCCkM6YqPY-TQd8fjI';
const SHEET_GID = process.env.SHEET_GID || '1467696356';
const SHEET_CSV_URL = process.env.SHEET_CSV_URL || `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${SHEET_GID}`;

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

// Chave canônica de telefone para casar registros: DDD + últimos 8 dígitos
// (ignora o "9" do celular e o código do país, que variam entre as fontes).
function phoneKey(raw) {
  if (!raw) return null;
  let s = String(raw).split(/[\/,;]/)[0].trim();
  if (/^\+(?!55)/.test(s) || /^00(?!55)/.test(s)) return null;
  let d = s.replace(/\D/g, '');
  if (d.startsWith('55') && d.length > 11) d = d.slice(2);
  if (d.length < 10) return null;
  return d.slice(0, 2) + d.slice(2).slice(-8);
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

// Devolve { byPhone: Map, byEmail: Map, since: 'YYYY-MM-DD'|null } a partir da planilha.
async function fetchCaptureSheet() {
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 9000);
    let text, ok, ct;
    try {
      const r = await fetch(SHEET_CSV_URL, { redirect: 'follow', headers: { 'User-Agent': 'DashboardBot/1.0', Accept: 'text/csv,*/*' }, signal: controller.signal });
      ok = r.ok; ct = r.headers.get('content-type') || ''; text = await r.text();
    } finally { clearTimeout(t); }
    if (!ok || ct.includes('text/html') || /^\s*<!DOCTYPE/i.test(text)) return { ok: false, byPhone: new Map(), byEmail: new Map(), since: null };

    const rows = parseCSV(text).filter((r) => r.some((c) => (c || '').trim() !== ''));
    const hi = rows.findIndex((r) => r.some((c) => /nome|name/i.test(c)));
    const header = hi >= 0 ? rows[hi] : rows[0];
    const dataRows = rows.slice((hi >= 0 ? hi : 0) + 1);
    const col = (...names) => {
      for (const n of names) { const i = header.findIndex((h) => h.trim().toLowerCase() === n.toLowerCase()); if (i >= 0) return i; }
      for (const n of names) { const i = header.findIndex((h) => h.trim().toLowerCase().includes(n.toLowerCase())); if (i >= 0) return i; }
      return -1;
    };
    const ci = {
      phone: col('Phone', 'Telefone', 'WhatsApp', 'Celular'),
      email: col('Email', 'E-mail'),
      content: col('utm_content'),
      camp: col('utm_campaign'),
      date: col('Data/Hora'),
    };
    const byPhone = new Map(), byEmail = new Map();
    let since = null;
    for (const r of dataRows) {
      const iso = ci.date >= 0 ? parseSheetDateISO(r[ci.date]) : null;
      if (iso && (!since || iso < since)) since = iso;
      const lead = {
        content: (ci.content >= 0 ? r[ci.content] : '') || '',
        camp: (ci.camp >= 0 ? r[ci.camp] : '') || '',
      };
      const pk = ci.phone >= 0 ? phoneKey(r[ci.phone]) : null;
      if (pk && !byPhone.has(pk)) byPhone.set(pk, lead);
      const em = ci.email >= 0 ? String(r[ci.email] || '').toLowerCase().trim() : '';
      if (em && !byEmail.has(em)) byEmail.set(em, lead);
    }
    return { ok: true, byPhone, byEmail, since };
  } catch (e) {
    return { ok: false, byPhone: new Map(), byEmail: new Map(), since: null };
  }
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

    // Janela do investimento em mídia = mesma do período (default 30 dias, como no /api/data)
    const metaWindow = window || rangeToWindow('30 dias');
    const metaSince = toISODate(metaWindow.start);
    const metaUntil = toISODate(new Date(metaWindow.end.getTime() - 86400000));

    const [{ ok, reason, deals }, sheet, metaAds] = await Promise.all([
      fetchWonDeals(),
      fetchCaptureSheet(),
      fetchMetaAdInsights({ since: metaSince, until: metaUntil }),
    ]);

    const stateAgg = new Map();       // UF -> { count, amount }
    const regionAgg = {};             // regiao -> { count, amount }
    const creativeAgg = new Map();    // utm_content -> { content, camp, count, amount }
    let total = 0, amountTotal = 0, semRegiao = 0;
    let matched = 0, unmatched = 0;   // venda casada (ou não) com a planilha de captação

    for (const d of deals) {
      const closed = d.closed_at ? new Date(d.closed_at) : null;
      if (window && closed && (closed < window.start || closed >= window.end)) continue;
      total += 1;
      // amount_total às vezes vem com erro de digitação (ex.: 24.500.000) — a
      // venda conta sempre, mas valores absurdos ficam de fora da soma de R$.
      const raw = Number(d.amount_total) || 0;
      const amt = raw > 0 && raw <= 300000 ? raw : 0;
      amountTotal += amt;

      // ---- casa a venda com o lead da planilha (telefone; e-mail como reserva) ----
      const pk = phoneKey(dealPhone(d));
      let lead = pk ? sheet.byPhone.get(pk) : null;
      if (!lead) { for (const em of dealEmails(d)) { if (sheet.byEmail.get(em)) { lead = sheet.byEmail.get(em); break; } } }
      if (lead) {
        matched += 1;
        const content = (lead.content || '').trim() || '(sem utm_content)';
        const key = content;
        if (!creativeAgg.has(key)) creativeAgg.set(key, { content, camp: (lead.camp || '').trim() || '—', count: 0, amount: 0 });
        const g = creativeAgg.get(key);
        g.count += 1;
        g.amount += amt;
      } else {
        unmatched += 1;
      }

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

    // ---- investimento por criativo (Meta Ads, level ad, casado pelo nome do anúncio) ----
    const adSpendRows = (metaAds.rows || []).map((r) => ({ name: r.ad_name, spend: parseFloat(r.spend || '0') || 0 }));
    function spendForContent(content) {
      let s = 0;
      for (const row of adSpendRows) if (tagsMatch(content, row.name)) s += row.spend;
      return s;
    }

    const salesByCreative = Array.from(creativeAgg.values())
      .map((g) => {
        const invest = metaAds.ok ? spendForContent(g.content) : 0;
        const roi = (metaAds.ok && invest > 0) ? g.amount / invest : null;
        const cpa = (metaAds.ok && invest > 0 && g.count > 0) ? invest / g.count : null;
        return {
          content: g.content,
          campaign: g.camp,
          count: g.count,
          amount: Math.round(g.amount),
          amountLabel: g.amount ? brl(g.amount) : '-',
          ticketLabel: (g.count && g.amount) ? brl(g.amount / g.count) : '-',
          invest: Math.round(invest),
          investLabel: (metaAds.ok && invest > 0) ? brl(invest) : '-',
          cpa: cpa != null ? Math.round(cpa) : null,
          cpaLabel: cpa != null ? brl(cpa) : '-',
          roi,
          roiLabel: roi != null ? roi.toFixed(1).replace('.', ',') + 'x' : '-',
          pct: matched ? Math.round((g.count / matched) * 100) : 0,
        };
      })
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
      salesByCreative,
      salesMatched: matched,
      salesUnmatched: unmatched,
      sheetConnected: sheet.ok,
      sheetSince: sheet.since,
      metaConnected: metaAds.ok,
      investRange: { since: metaSince, until: metaUntil },
      range: window ? { since: window.start.toISOString().slice(0, 10) } : null,
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message, connected: false });
  }
}
