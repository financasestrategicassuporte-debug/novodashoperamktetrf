// api/webinar-meetings.js — Vercel Serverless Function
// GET /api/webinar-meetings?range=30 dias    (ou ?start=YYYY-MM-DD&end=YYYY-MM-DD)
//
// No funil "Webnários Quentes" (RD Station CRM), conta por CRIATIVO quantos
// negócios chegaram à etapa de REUNIÃO — "Reunião Agendada" ou além
// (Remarcar Reunião, Em Negociação, Acompanhamento, Venda) — e quantos estão
// hoje em "Remarcar Reunião". Cruza pela planilha de captação (telefone) para
// responder "qual criativo trouxe mais reunião marcada".
//
// Env (Vercel → Settings → Environment Variables):
//   RDSTATION_CRM_TOKEN  (obrigatório)
//   META_ACCESS_TOKEN / META_AD_ACCOUNT_ID  (p/ investido e custo por reunião)
//   RDSTATION_WEBINAR_PIPELINE_ID  (opcional)

const RD_TOKEN = process.env.RDSTATION_CRM_TOKEN || '';
const RD_PIPELINE_ID = process.env.RDSTATION_WEBINAR_PIPELINE_ID || '694aabf03f1ed8001d44a46b';
const RD_BASE = 'https://crm.rdstation.com/api/v1';

const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN || '';
const META_AD_ACCOUNT_ID = process.env.META_AD_ACCOUNT_ID || '';
const META_API_VERSION = process.env.META_API_VERSION || 'v20.0';

const SHEET_ID = process.env.SHEET_ID || '1MW_dyf0VOHULceCCtY7FkCR_tLCCkM6YqPY-TQd8fjI';
const SHEET_GID = process.env.SHEET_GID || '1467696356';
const SHEET_CSV_URL = process.env.SHEET_CSV_URL || `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${SHEET_GID}`;

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
    const ci = { phone: col('Phone', 'Telefone', 'WhatsApp', 'Celular'), email: col('Email', 'E-mail'), content: col('utm_content'), camp: col('utm_campaign'), date: col('Data/Hora') };
    const byPhone = new Map(), byEmail = new Map();
    let since = null;
    for (const r of dataRows) {
      const iso = ci.date >= 0 ? parseSheetDateISO(r[ci.date]) : null;
      if (iso && (!since || iso < since)) since = iso;
      const lead = { content: (ci.content >= 0 ? r[ci.content] : '') || '', camp: (ci.camp >= 0 ? r[ci.camp] : '') || '' };
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

// ---------- Meta Ads: investido por criativo ----------
function normTag(s) {
  return (s || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Z0-9]+/g, ' ').trim();
}
function tagsMatch(a, b) {
  const na = normTag(a), nb = normTag(b);
  if (!na || !nb) return false;
  if (na === nb || na.includes(nb) || nb.includes(na)) return true;
  // Nome da campanha no Meta às vezes ganha UM token curto a mais que o
  // utm_campaign do lead (ex.: renomearam "[CAPTAÇÃO]" pra "[CAPTAÇÃO V]").
  // Casa quando as sequências de tokens ficam idênticas tirando no máximo um
  // token curto (<=2 chars) ou puramente numérico de um dos lados. Não funde
  // "[CAPTAÇÃO 4]" com "[CAPTAÇÃO 5]" nem descritores diferentes.
  const A = na.split(" "), B = nb.split(" ");
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
async function fetchMetaAdInsights({ since, until }) {
  if (!META_ACCESS_TOKEN || !META_AD_ACCOUNT_ID) return { ok: false, rows: [] };
  const acct = META_AD_ACCOUNT_ID.startsWith('act_') ? META_AD_ACCOUNT_ID : `act_${META_AD_ACCOUNT_ID}`;
  const params = new URLSearchParams({
    level: 'ad', fields: 'ad_name,campaign_name,adset_name,spend',
    time_range: JSON.stringify({ since, until }), time_increment: 'all_days', limit: '400',
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
  } catch (e) { return { ok: false, rows: [] }; }
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

export default async function handler(req, res) {
  // Cache curto — uma reunião marcada/venda no RD Station precisa aparecer
  // rápido no card "Criativos que trouxeram reunião".
  res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
  try {
    const { range, start: startParam, end: endParam } = req.query || {};
    const window = (startParam && endParam)
      ? { start: new Date(startParam + 'T00:00:00'), end: new Date(new Date(endParam + 'T00:00:00').getTime() + 86400000) }
      : (range ? rangeToWindow(range) : null);

    const metaWindow = window || rangeToWindow('30 dias');
    const metaSince = toISODate(metaWindow.start);
    const metaUntil = toISODate(new Date(metaWindow.end.getTime() - 86400000));

    const [{ ok, reason, deals }, sheet, metaAds, pipeline] = await Promise.all([
      fetchAllDeals(),
      fetchCaptureSheet(),
      fetchMetaAdInsights({ since: metaSince, until: metaUntil }),
      fetchPipeline(),
    ]);

    // ordem dos estágios do funil: da etapa "Reunião Agendada" pra frente = "teve reunião"
    const stagesOrdered = (pipeline && pipeline.deal_stages ? pipeline.deal_stages : [])
      .slice().sort((a, b) => (a.order || 0) - (b.order || 0));
    const raStage = stagesOrdered.find((s) => /reuni[aã]o agendada/i.test(s.name || ''));
    const rrStage = stagesOrdered.find((s) => /remarcar reuni[aã]o/i.test(s.name || ''));
    const raOrder = raStage ? (raStage.order || 0) : 3;
    // ids dos estágios que já contam como "chegou na reunião": RA e todos com order >= RA
    const meetingStageIds = new Set(
      stagesOrdered.filter((s) => (s.order || 0) >= raOrder).map((s) => s.id || s._id)
    );
    const rrStageId = rrStage ? (rrStage.id || rrStage._id) : null;

    const stageIdOf = (d) => (d.deal_stage && (d.deal_stage.id || d.deal_stage._id)) || null;
    const reachedMeeting = (d) => d.win === true || meetingStageIds.has(stageIdOf(d));

    const creativeAgg = new Map(); // utm_content -> { content, camp, reunioes, remarcadas }
    let meetingsTotal = 0, matched = 0, unmatched = 0;

    for (const d of deals) {
      if (window) {
        const c = d.created_at ? new Date(d.created_at) : null;
        if (!(c && c >= window.start && c < window.end)) continue;
      }
      if (!reachedMeeting(d)) continue;
      meetingsTotal += 1;
      const isRR = rrStageId && stageIdOf(d) === rrStageId;

      const pk = phoneKey(dealPhone(d));
      let lead = pk ? sheet.byPhone.get(pk) : null;
      if (!lead) { for (const em of dealEmails(d)) { if (sheet.byEmail.get(em)) { lead = sheet.byEmail.get(em); break; } } }
      if (!lead) { unmatched += 1; continue; }
      matched += 1;

      let content = (lead.content || '').trim();
      if (!content || /\{\{.*\}\}/.test(content)) content = '(utm_content não preenchido)';
      if (!creativeAgg.has(content)) creativeAgg.set(content, { content, camp: (lead.camp || '').trim() || '—', reunioes: 0, remarcadas: 0 });
      const g = creativeAgg.get(content);
      g.reunioes += 1;
      if (isRR) g.remarcadas += 1;
    }

    const adSpendRows = (metaAds.rows || []).map((r) => ({ name: r.ad_name, spend: parseFloat(r.spend || '0') || 0 }));
    const spendForContent = (content) => {
      let s = 0;
      for (const row of adSpendRows) if (tagsMatch(content, row.name)) s += row.spend;
      return s;
    };
    const maxReunioes = Math.max(1, ...Array.from(creativeAgg.values()).map((g) => g.reunioes));

    const meetingsByCreative = Array.from(creativeAgg.values())
      .map((g) => {
        const invest = metaAds.ok ? spendForContent(g.content) : 0;
        const cpr = (metaAds.ok && invest > 0 && g.reunioes > 0) ? invest / g.reunioes : null;
        return {
          content: g.content,
          campaign: g.camp,
          reunioes: g.reunioes,
          remarcadas: g.remarcadas,
          invest: Math.round(invest),
          investLabel: (metaAds.ok && invest > 0) ? brl(invest) : '-',
          cpr: cpr != null ? Math.round(cpr) : null,
          cprLabel: cpr != null ? brl(cpr) : '-',
          barWidth: Math.round((g.reunioes / maxReunioes) * 100) + '%',
        };
      })
      .sort((a, b) => b.reunioes - a.reunioes || b.remarcadas - a.remarcadas);

    res.status(200).json({
      connected: ok,
      error: ok ? null : reason,
      pipeline: pipeline ? pipeline.name : 'Webnários Quentes',
      meetingsTotal,
      meetingsMatched: matched,
      meetingsUnmatched: unmatched,
      meetingsByCreative,
      sheetConnected: sheet.ok,
      sheetSince: sheet.since,
      metaConnected: metaAds.ok,
      range: window ? { since: toISODate(window.start) } : null,
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message, connected: false });
  }
}
