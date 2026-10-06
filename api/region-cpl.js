// api/region-cpl.js — Vercel Serverless Function
// GET /api/region-cpl?range=30 dias    (ou ?start=YYYY-MM-DD&end=YYYY-MM-DD)
//
// Custo por lead por REGIÃO e por ESTADO:
//   investido = Meta Ads com breakdown "region" (onde o anúncio foi entregue)
//   leads     = planilha de captação, estado pelo DDD do telefone (mesma régua
//               do /api/data e do mapa "Leads por Estado")
//   CPL = investido no estado ÷ leads do estado; CPL qualificado idem com
//   leads de faturamento >= R$50 mil.
// Endpoint independente — não altera /api/data nem os outros.
//
// Env: META_ACCESS_TOKEN / META_AD_ACCOUNT_ID, SHEET_ID / SHEET_GID (opcional)

const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN || '';
const META_AD_ACCOUNT_ID = process.env.META_AD_ACCOUNT_ID || '';
const META_API_VERSION = process.env.META_API_VERSION || 'v20.0';
const SHEET_ID = process.env.SHEET_ID || '1MW_dyf0VOHULceCCtY7FkCR_tLCCkM6YqPY-TQd8fjI';
const SHEET_GID = process.env.SHEET_GID || '1467696356';
const CSV_URL = process.env.SHEET_CSV_URL || `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${SHEET_GID}`;

// ---- copiado do /api/data (mesma leitura da planilha de captação) ----
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

function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; }
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c === '\r') { /* ignora */ }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function parseFaturamento(raw) {
  if (!raw) return null;
  const s = raw.trim();
  if (!s) return null;
  const hasMil = /mil\b/i.test(s);
  const hasK = /\d\s*k\b/i.test(s);
  let cleaned = s.replace(/R\$\s?/gi, '').replace(/(\d)\.(\d{3})(?!\d)/g, '$1$2');
  const nums = cleaned.match(/\d+(?:[.,]\d+)?/g);
  if (!nums) return null;
  let vals = nums.map((n) => parseFloat(n.replace(',', '.')));
  if (hasK || hasMil) vals = vals.map((v) => (v < 1000 ? v * 1000 : v));
  if (!vals.length) return null;
  return Math.min(...vals);
}

function parseRowDate(raw) {
  if (!raw) return null;
  const s = raw.trim();
  const hasComma = s.includes(',');
  const m = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{4}),?\s*(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  let [, p1, p2, year, h, min, sec] = m;
  let day, month;
  if (hasComma) { day = p1; month = p2; } else { month = p1; day = p2; }
  const d = new Date(Number(year), Number(month) - 1, Number(day), Number(h), Number(min), Number(sec || 0));
  return isNaN(d.getTime()) ? null : d;
}

function rangeToWindow(range) {
  const now = new Date(Date.now() - 3 * 60 * 60 * 1000); // Brazil (America/Sao_Paulo, UTC-3) wall-clock "now"
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

function toISODate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function ufFromPhone(raw) {
  if (!raw) return null;
  let s = String(raw).replace(/\D/g, '');
  if (s.startsWith('55') && s.length > 11) s = s.slice(2); // tira código do país
  if (s.length < 10) return null; // precisa de DDD (2) + número (8/9)
  const ddd = parseInt(s.slice(0, 2), 10);
  return DDD_UF[ddd] || null;
}

async function fetchCsv(url) {
  const r = await fetch(url, {
    redirect: 'follow',
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DashboardBot/1.0)', Accept: 'text/csv,*/*' },
  });
  return { ok: r.ok, status: r.status, contentType: r.headers.get('content-type') || '', text: await r.text() };
}

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
const REGIOES = ['Norte', 'Nordeste', 'Centro-Oeste', 'Sudeste', 'Sul'];

// Nome de região do Meta (breakdown "region", vem em inglês/sem acento, às vezes com "(state)") → UF
const normName = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/\(.*?\)/g, '').replace(/\b(state of|estado de|estado do|estado da)\b/g, '').replace(/[^a-z ]+/g, ' ').replace(/\s+/g, ' ').trim();
const META_REGION_UF = (() => {
  const m = {};
  for (const [uf, nome] of Object.entries(UF_NOME)) m[normName(nome)] = uf;
  Object.assign(m, { 'federal district': 'DF', 'distrito federal': 'DF', 'brasilia': 'DF', 'sao paulo': 'SP', 'rio de janeiro': 'RJ' });
  return m;
})();
function metaRegionToUF(name) {
  const n = normName(name);
  if (META_REGION_UF[n]) return META_REGION_UF[n];
  for (const [k, uf] of Object.entries(META_REGION_UF)) if (n.startsWith(k + ' ') || n.endsWith(' ' + k)) return uf;
  return null;
}

function brl(n) {
  if (n == null || isNaN(n)) return '-';
  return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 2 });
}

async function fetchMetaByRegion({ since, until }) {
  if (!META_ACCESS_TOKEN || !META_AD_ACCOUNT_ID) return { ok: false, rows: [], reason: 'missing_credentials' };
  const acct = META_AD_ACCOUNT_ID.startsWith('act_') ? META_AD_ACCOUNT_ID : `act_${META_AD_ACCOUNT_ID}`;
  let url = `https://graph.facebook.com/${META_API_VERSION}/${acct}/insights?${new URLSearchParams({
    level: 'account', fields: 'spend,impressions,clicks', breakdowns: 'region',
    time_range: JSON.stringify({ since, until }), time_increment: 'all_days', limit: '500',
    access_token: META_ACCESS_TOKEN,
  })}`;
  const rows = [];
  try {
    for (let page = 0; page < 5 && url; page++) {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 9000);
      let json;
      try {
        const r = await fetch(url, { signal: controller.signal });
        json = await r.json();
        if (!r.ok || json.error) return { ok: false, rows: [], reason: (json.error && json.error.message) || `HTTP ${r.status}` };
      } finally { clearTimeout(t); }
      rows.push(...(json.data || []));
      url = json.paging && json.paging.next ? json.paging.next : null;
    }
    return { ok: true, rows };
  } catch (e) { return { ok: false, rows: [], reason: e.message || 'fetch_failed' }; }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
  try {
    const { range, start: startParam, end: endParam } = req.query || {};
    const window = (startParam && endParam)
      ? { start: new Date(startParam + 'T00:00:00-03:00'), end: new Date(new Date(endParam + 'T00:00:00-03:00').getTime() + 86400000) }
      : (range ? rangeToWindow(range) : null);
    const metaWindow = window || rangeToWindow('30 dias');
    const since = toISODate(metaWindow.start);
    const until = toISODate(new Date(metaWindow.end.getTime() - 86400000));

    const [csvRes, meta] = await Promise.all([fetchCsv(CSV_URL).catch(() => null), fetchMetaByRegion({ since, until })]);

    // ---- leads por UF (mesma régua do /api/data: nome preenchido, período, DDD do telefone)
    const leadsUF = new Map(); // UF -> { leads, qualif }
    let leadsTotal = 0, leadsSemDDD = 0, sheetOk = false;
    if (csvRes && csvRes.ok && !(csvRes.contentType || '').includes('text/html') && !/^\s*<!DOCTYPE/i.test(csvRes.text)) {
      sheetOk = true;
      const rows = parseCSV(csvRes.text).filter((r) => r.some((c) => (c || '').trim() !== ''));
      const headerIdx = rows.findIndex((r) => r.some((c) => /nome|name/i.test(c)));
      const header = headerIdx >= 0 ? rows[headerIdx] : rows[0];
      const dataRows = rows.slice((headerIdx >= 0 ? headerIdx : 0) + 1);
      const colAny = (...names) => {
        for (const name of names) { const i = header.findIndex((h) => h.trim().toLowerCase() === name.toLowerCase()); if (i >= 0) return i; }
        for (const name of names) { const i = header.findIndex((h) => h.trim().toLowerCase().includes(name.toLowerCase())); if (i >= 0) return i; }
        return -1;
      };
      const idx = {
        data: colAny('Data/Hora'), nome: colAny('Nome', 'First Name', 'Name'),
        faturamento: colAny('Faturamento', 'Faixa de faturamento Mensal', 'Faixa de faturamento'),
        telefone: colAny('Phone', 'Telefone', 'Celular', 'WhatsApp', 'Whatsapp', 'Fone', 'DDD'),
      };
      for (const r of dataRows) {
        const nome = idx.nome >= 0 ? (r[idx.nome] || '').trim() : '';
        if (!nome) continue;
        const d = idx.data >= 0 ? parseRowDate(r[idx.data]) : null;
        if (window && d && (d < window.start || d >= window.end)) continue;
        leadsTotal += 1;
        const uf = idx.telefone >= 0 ? ufFromPhone(r[idx.telefone]) : null;
        if (!uf) { leadsSemDDD += 1; continue; }
        const fat = idx.faturamento >= 0 ? parseFaturamento((r[idx.faturamento] || '').trim()) : null;
        if (!leadsUF.has(uf)) leadsUF.set(uf, { leads: 0, qualif: 0 });
        const g = leadsUF.get(uf);
        g.leads += 1;
        if (fat != null && fat >= 50000) g.qualif += 1;
      }
    }

    // ---- investimento por UF (Meta Ads, breakdown por região de entrega do anúncio)
    const spendUF = new Map(); // UF -> { spend, impressions, clicks }
    let spendTotal = 0, spendSemUF = 0;
    const naoMapeadas = new Set();
    for (const row of meta.rows || []) {
      const spend = parseFloat(row.spend || '0') || 0;
      spendTotal += spend;
      const uf = metaRegionToUF(row.region);
      if (!uf) { spendSemUF += spend; if (row.region && spend > 0) naoMapeadas.add(row.region); continue; }
      if (!spendUF.has(uf)) spendUF.set(uf, { spend: 0, impressions: 0, clicks: 0 });
      const g = spendUF.get(uf);
      g.spend += spend;
      g.impressions += parseInt(row.impressions || '0', 10) || 0;
      g.clicks += parseInt(row.clicks || '0', 10) || 0;
    }

    const cpl = (spend, n) => (meta.ok && n > 0 && spend > 0 ? spend / n : null);
    const pack = (spend, leads, qualif) => {
      const c = cpl(spend, leads), cq = cpl(spend, qualif);
      return {
        invest: Math.round(spend * 100) / 100, investLabel: meta.ok ? brl(spend) : '-',
        leads, qualif,
        cpl: c != null ? Math.round(c * 100) / 100 : null, cplLabel: c != null ? brl(c) : '-',
        cplQualif: cq != null ? Math.round(cq * 100) / 100 : null, cplQualifLabel: cq != null ? brl(cq) : '-',
        pctInvest: spendTotal ? Math.round((spend / spendTotal) * 1000) / 10 : 0,
      };
    };

    const ufs = new Set([...spendUF.keys(), ...leadsUF.keys()]);
    const byState = Array.from(ufs).map((uf) => {
      const s = spendUF.get(uf) || { spend: 0 };
      const l = leadsUF.get(uf) || { leads: 0, qualif: 0 };
      return { uf, nome: UF_NOME[uf] || uf, regiao: UF_REGIAO[uf] || '', ...pack(s.spend, l.leads, l.qualif) };
    }).sort((a, b) => b.invest - a.invest || b.leads - a.leads);

    const byRegion = REGIOES.map((regiao) => {
      const states = byState.filter((s) => s.regiao === regiao);
      const spend = states.reduce((a, s) => a + s.invest, 0);
      const leads = states.reduce((a, s) => a + s.leads, 0);
      const qualif = states.reduce((a, s) => a + s.qualif, 0);
      return { regiao, estados: states.filter((s) => s.leads || s.invest).map((s) => s.uf).join(', '), ...pack(spend, leads, qualif) };
    });

    res.status(200).json({
      connected: meta.ok,
      error: meta.ok ? null : meta.reason,
      sheetConnected: sheetOk,
      byRegion,
      byState,
      investTotal: Math.round(spendTotal), investTotalLabel: meta.ok ? brl(spendTotal) : '-',
      investSemEstado: Math.round(spendSemUF), investSemEstadoLabel: brl(spendSemUF),
      regioesNaoMapeadas: Array.from(naoMapeadas).slice(0, 10),
      leadsTotal, leadsSemDDD,
      range: { since, until },
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message, connected: false });
  }
}
