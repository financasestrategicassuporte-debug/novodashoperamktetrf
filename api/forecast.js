// api/forecast.js — Vercel Serverless Function
// GET /api/forecast?start=YYYY-MM-DD&end=YYYY-MM-DD   (ou ?range=Esse Mês)
//
// Base da previsão do Simulador. Cruza, pelo telefone, os leads da planilha de
// captação (faixa de faturamento declarada) com os negócios do funil
// "Webnários Quentes" no RD Station e devolve:
//   - calibração: por faixa de faturamento, quantos leads viraram negócio e venda
//     (só leads maduros: de 16/07/2026 até 21 dias atrás), com os tickets reais;
//   - janela pedida: leads únicos por faixa, por dia e por campanha, negócios e
//     vendas já fechadas, e a taxa de aplicação ao funil vs. a esperada.
//
// Env: RDSTATION_CRM_TOKEN (obrigatório), RDSTATION_WEBINAR_PIPELINE_ID, SHEET_ID, SHEET_GID

const RD_TOKEN = process.env.RDSTATION_CRM_TOKEN || '';
const RD_PIPELINE_ID = process.env.RDSTATION_WEBINAR_PIPELINE_ID || '694aabf03f1ed8001d44a46b';
const RD_BASE = 'https://crm.rdstation.com/api/v1';
const SHEET_ID = process.env.SHEET_ID || '1MW_dyf0VOHULceCCtY7FkCR_tLCCkM6YqPY-TQd8fjI';
const SHEET_GID = process.env.SHEET_GID || '1467696356';
const SHEET_CSV_URL = process.env.SHEET_CSV_URL || `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${SHEET_GID}`;

const CAL_START = '2026-07-16'; // a planilha de captação só tem dados a partir daqui
const MATURE_DAYS = 21; // lead com menos de 21 dias ainda pode virar venda
const AMOUNT_CAP = 300000; // valores acima disso são erro de digitação
const BAND_KEYS = ['b0', 'b1', 'b2', 'b3', 'b4'];
const BAND_LABELS = { b0: 'Até R$ 20 mil', b1: 'R$ 20–30 mil', b2: 'R$ 30–40 mil', b3: 'R$ 50–150 mil', b4: 'R$ 150–500 mil' };

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
  const s = String(raw).split(/[\/,;]/)[0].trim();
  if (/^\+(?!55)/.test(s) || /^00(?!55)/.test(s)) return null;
  let d = s.replace(/\D/g, '');
  if (d.startsWith('55') && d.length > 11) d = d.slice(2);
  if (d.length < 10) return null;
  return d.slice(0, 2) + d.slice(2).slice(-8);
}
function dealPhone(d) {
  const cf = (d.deal_custom_fields || []).find((x) => x.custom_field && /telefone|whatsapp|celular|\bfone\b/i.test(x.custom_field.label || ''));
  if (cf && cf.value) return cf.value;
  for (const c of d.contacts || []) for (const p of c.phones || []) if (p && p.phone) return p.phone;
  return null;
}
// "16/07/2026, 21:37:51" (dia/mês, com vírgula) ou "7/16/2026 12:31:46" (mês/dia, sem vírgula).
// Sem vírgula e ambíguo, usa o valor > 12 para decidir; empate = mês/dia.
function sheetISO(raw) {
  const m = String(raw || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) return null;
  const [, a, b, y] = m;
  let dmy = String(raw).includes(',');
  if (!dmy) { if (+a > 12) dmy = true; else if (+b > 12) dmy = false; }
  const dd = dmy ? a : b, mm = dmy ? b : a;
  return `${y}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
}
function bandOf(raw) {
  const s = String(raw || '').toLowerCase();
  if (s.indexOf('500k') >= 0) return 'b4';
  if (s.indexOf('150k') >= 0 || s.indexOf('50k') >= 0) return 'b3';
  if (/30\.000 a/.test(s)) return 'b2';
  if (/20\.000 a/.test(s)) return 'b1';
  return 'b0';
}
function normTag(s) {
  return String(s || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Z0-9]+/g, ' ').trim();
}
const brtShift = (d) => new Date(new Date(d).getTime() - 3 * 60 * 60 * 1000);
const isoOf = (d) => brtShift(d).toISOString().slice(0, 10);
const dayDiff = (a, b) => Math.round((new Date(b + 'T12:00:00Z') - new Date(a + 'T12:00:00Z')) / 86400000);
const addDays = (iso, n) => new Date(new Date(iso + 'T12:00:00Z').getTime() + n * 86400000).toISOString().slice(0, 10);

async function fetchText(url) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 9000);
  try {
    const r = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'DashboardBot/1.0', Accept: 'text/csv,*/*' }, signal: controller.signal });
    const ct = r.headers.get('content-type') || '';
    const text = await r.text();
    if (!r.ok || ct.includes('text/html') || /^\s*<!DOCTYPE/i.test(text)) return null;
    return text;
  } finally { clearTimeout(t); }
}
async function fetchSheetLeads() {
  const text = await fetchText(SHEET_CSV_URL);
  if (!text) return null;
  const rows = parseCSV(text).filter((r) => r.some((c) => (c || '').trim() !== ''));
  const hi = rows.findIndex((r) => r.some((c) => /nome|name/i.test(c)));
  const header = rows[hi >= 0 ? hi : 0];
  const dataRows = rows.slice((hi >= 0 ? hi : 0) + 1);
  const col = (...names) => {
    for (const n of names) { const i = header.findIndex((h) => h.trim().toLowerCase() === n.toLowerCase()); if (i >= 0) return i; }
    for (const n of names) { const i = header.findIndex((h) => h.trim().toLowerCase().includes(n.toLowerCase())); if (i >= 0) return i; }
    return -1;
  };
  const ci = { date: col('Data/Hora'), phone: col('Phone', 'Telefone', 'WhatsApp', 'Celular'), email: col('Email', 'E-mail'), fat: col('Faixa de faturamento'), camp: col('utm_campaign'), name: col('First Name', 'Nome') };
  const out = [];
  dataRows.forEach((r, i) => {
    const iso = ci.date >= 0 ? sheetISO(r[ci.date]) : null;
    if (!iso) return;
    if (ci.name >= 0 && !String(r[ci.name] || '').trim()) return;
    const pk = ci.phone >= 0 ? phoneKey(r[ci.phone]) : null;
    const em = ci.email >= 0 ? String(r[ci.email] || '').toLowerCase().trim() : '';
    out.push({ iso, pk, key: pk || em || 'row' + i, band: bandOf(ci.fat >= 0 ? r[ci.fat] : ''), camp: (ci.camp >= 0 ? r[ci.camp] : '') || '(sem campanha)' });
  });
  return out;
}
async function fetchAllDeals() {
  if (!RD_TOKEN) return null;
  const deals = [];
  for (let page = 1; page <= 15; page++) {
    const url = `${RD_BASE}/deals?token=${encodeURIComponent(RD_TOKEN)}&deal_pipeline_id=${RD_PIPELINE_ID}&limit=200&page=${page}`;
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 9000);
    let j;
    try {
      const r = await fetch(url, { signal: controller.signal });
      if (!r.ok) return null;
      j = await r.json();
    } finally { clearTimeout(t); }
    deals.push(...(j.deals || []));
    if (!j.has_more || !(j.deals || []).length) break;
  }
  return deals;
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  try {
    const { start: startParam, end: endParam, range } = req.query || {};
    const today = isoOf(Date.now());
    let start, end;
    if (startParam && endParam) { start = startParam; end = endParam; }
    else { start = today.slice(0, 8) + '01'; end = today; }
    if (range && !startParam) { start = today.slice(0, 8) + '01'; end = today; }
    if (end > today) end = today;

    const [leadsRaw, dealsRaw] = await Promise.all([fetchSheetLeads(), fetchAllDeals()]);
    if (!leadsRaw || !dealsRaw) {
      res.status(200).json({ connected: false, reason: !leadsRaw ? 'sheet' : 'rd', updatedAt: new Date().toISOString() });
      return;
    }

    // negócios por telefone
    const dealsByPk = new Map();
    for (const d of dealsRaw) {
      const pk = phoneKey(dealPhone(d));
      if (!pk) continue;
      if (!dealsByPk.has(pk)) dealsByPk.set(pk, []);
      dealsByPk.get(pk).push({ created: d.created_at ? isoOf(d.created_at) : null, win: d.win === true, amount: Number(d.amount_total) || 0 });
    }
    // lead único = primeiro envio daquele telefone/e-mail
    const sorted = leadsRaw.slice().sort((a, b) => (a.iso < b.iso ? -1 : a.iso > b.iso ? 1 : 0));
    const firstByKey = new Map();
    for (const l of sorted) if (!firstByKey.has(l.key)) firstByKey.set(l.key, l);
    const uniq = Array.from(firstByKey.values());

    const outcome = (l) => {
      const ds = l.pk ? dealsByPk.get(l.pk) : null;
      if (!ds || !ds.length) return { deal: false, applied3: false, wins: 0, revenue: 0, tickets: [] };
      const valid = ds.filter((d) => d.created && dayDiff(l.iso, d.created) >= -1);
      if (!valid.length) return { deal: false, applied3: false, wins: 0, revenue: 0, tickets: [] };
      const wonDeals = valid.filter((d) => d.win && d.amount > 0 && d.amount < AMOUNT_CAP);
      const first = valid.reduce((a, b) => (a.created <= b.created ? a : b));
      return { deal: true, applied3: dayDiff(l.iso, first.created) <= 3, wins: valid.filter((d) => d.win).length ? 1 : 0, revenue: wonDeals.reduce((a, d) => a + d.amount, 0), tickets: wonDeals.map((d) => d.amount) };
    };

    // calibração (leads maduros)
    const matureCut = addDays(today, -MATURE_DAYS);
    const bands = {};
    BAND_KEYS.forEach((k) => { bands[k] = { key: k, label: BAND_LABELS[k], leads: 0, deals: 0, applied3: 0, wins: 0, revenue: 0, tickets: [] }; });
    for (const l of uniq) {
      if (l.iso < CAL_START || l.iso > matureCut) continue;
      const o = outcome(l), b = bands[l.band];
      b.leads++; if (o.deal) b.deals++; if (o.applied3) b.applied3++; b.wins += o.wins; b.revenue += o.revenue; b.tickets.push(...o.tickets);
    }
    const calibration = BAND_KEYS.map((k) => bands[k]);

    // janela pedida
    const empty = () => ({ b0: 0, b1: 0, b2: 0, b3: 0, b4: 0 });
    const win = { start, end, unique: 0, rawRows: 0, byBand: {}, daily: {}, byCampaign: {}, maturity: { matureLeads: 0, expApps: 0, obsApps: 0 } };
    BAND_KEYS.forEach((k) => { win.byBand[k] = { n: 0, deals: 0, wins: 0, revenue: 0 }; });
    for (const l of leadsRaw) if (l.iso >= start && l.iso <= end) win.rawRows++;
    const appRate = {};
    BAND_KEYS.forEach((k) => { appRate[k] = bands[k].leads ? bands[k].applied3 / bands[k].leads : 0; });
    const ageCut = addDays(today, -3);
    for (const l of uniq) {
      if (l.iso < start || l.iso > end) continue;
      const o = outcome(l);
      win.unique++;
      const wb = win.byBand[l.band];
      wb.n++; if (o.deal) wb.deals++; wb.wins += o.wins; wb.revenue += o.revenue;
      if (!win.daily[l.iso]) win.daily[l.iso] = empty();
      win.daily[l.iso][l.band]++;
      const ck = normTag(l.camp) || l.camp;
      if (!win.byCampaign[ck]) win.byCampaign[ck] = { camp: l.camp, n: empty(), total: 0 };
      win.byCampaign[ck].n[l.band]++; win.byCampaign[ck].total++;
      if (l.iso <= ageCut) { win.maturity.matureLeads++; win.maturity.expApps += appRate[l.band]; if (o.applied3) win.maturity.obsApps++; }
    }
    const daily = Object.keys(win.daily).sort().map((date) => ({ date, n: win.daily[date] }));
    // série dos últimos 42 dias (inclui dias sem lead): os leads chegam em ondas
    // semanais (domingo/segunda), então a projeção usa o perfil por dia da semana.
    const recentMap = {};
    for (const l of uniq) { if (l.iso >= addDays(end, -41) && l.iso <= end) { if (!recentMap[l.iso]) recentMap[l.iso] = empty(); recentMap[l.iso][l.band]++; } }
    const recent = [];
    for (let i = 41; i >= 0; i--) { const d = addDays(end, -i); recent.push({ date: d, n: recentMap[d] || empty() }); }
    const byCampaign = Object.keys(win.byCampaign).map((k) => Object.assign({ key: k }, win.byCampaign[k]));

    res.status(200).json({
      connected: true,
      calibration: { since: CAL_START, until: matureCut, bands: calibration },
      window: { start, end, unique: win.unique, rawRows: win.rawRows, byBand: win.byBand, daily, recent, byCampaign, maturity: win.maturity },
      updatedAt: new Date().toISOString(),
    });
  } catch (e) {
    res.status(200).json({ connected: false, reason: String(e && e.message || e), updatedAt: new Date().toISOString() });
  }
}
