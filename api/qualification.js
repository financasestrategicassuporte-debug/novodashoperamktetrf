// api/qualification.js — Vercel Serverless Function
// GET /api/qualification
//
// Aba "Qualificação": lê AO VIVO (a cada requisição, sem cache) a planilha
// de APLICAÇÃO — só cai nela quem assistiu o workshop e preencheu a
// aplicação — e classifica cada lead pela faixa de faturamento mensal:
//   - Desqualificado: menos de R$30k (inclui "ainda vai inaugurar")
//   - Semi qualificado: R$30k a R$50k
//   - Qualificado: +R$50k a R$150k
//   - Ultra qualificado: +R$150k
// Agrupa por mês do carimbo do Forms e soma, em cada mês, o faturamento das
// vendas (win=true) do funil "Webnários Quentes" no RD Station CRM, pela data
// de fechamento — pra cruzar qualidade das aplicações × faturamento.
//
// Variáveis de ambiente (as mesmas já usadas pelos outros endpoints):
//   RDSTATION_CRM_TOKEN, RDSTATION_WEBINAR_PIPELINE_ID (opcional),
//   APLICACAO_SHEET_ID / APLICACAO_SHEET_GID (opcionais)

const RD_TOKEN = process.env.RDSTATION_CRM_TOKEN || '';
const RD_PIPELINE_ID = process.env.RDSTATION_WEBINAR_PIPELINE_ID || '694aabf03f1ed8001d44a46b';
const RD_BASE = 'https://crm.rdstation.com/api/v1';

const APLIC_SHEET_ID = process.env.APLICACAO_SHEET_ID || '12-vMpjxquYpO7TgQBsXuvsPLUdDmZZtUvyt5ucC8OSo';
const APLIC_SHEET_GID = process.env.APLICACAO_SHEET_GID || '';
const APLIC_CSV_URL = `https://docs.google.com/spreadsheets/d/${APLIC_SHEET_ID}/export?format=csv${APLIC_SHEET_GID ? `&gid=${APLIC_SHEET_GID}` : ''}`;

const TIERS = ['desqualificado', 'semi', 'qualificado', 'ultra'];
const TIER_RANK = { desqualificado: 0, semi: 1, qualificado: 2, ultra: 3 };

function normalize(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

// Opções que já apareceram no formulário. "20mil a 50mil" e "+40 mil"
// atravessam/ficam perto do corte de 30k — entram como semi porque a maior
// parte da faixa declarada fica entre 30k e 50k.
const KNOWN_OPTIONS = {
  '0': 'desqualificado',
  'ainda vai inaugurar': 'desqualificado',
  'ate 20mil mensal': 'desqualificado',
  'ate 20 mil': 'desqualificado',
  'entre r$20.000 a r$30.000': 'desqualificado',
  '20mil ate 30 mil por mes': 'desqualificado',
  'entre r$30.000 a r$40.000': 'semi',
  '30mil ate 40 mil mensal': 'semi',
  '+40 mil reais por mes': 'semi',
  '20mil a 50mil': 'semi',
  '20mil a 50mil mensal': 'semi',
  '50k a 150k': 'qualificado',
  '51mil a 100mil': 'qualificado',
  '101mil a 150mil mensal': 'qualificado',
  '150k a 500k': 'ultra',
  'acima de 150mil mensal': 'ultra',
};

// Fallback pra opção nova no formulário: usa o menor valor citado (em mil).
function tierFromNumbers(option) {
  const nums = Array.from(option.matchAll(/(\d+(?:[.,]\d+)*)\s*(k|mil)?/g))
    .map((m) => {
      const n = Number(m[1].replace(/[.,]/g, ''));
      return m[2] ? n : n >= 1000 ? n / 1000 : n;
    })
    .filter((n) => Number.isFinite(n));
  if (!nums.length) return option.includes('inaugurar') ? 'desqualificado' : null;
  const k = Math.min(...nums);
  if (k >= 150) return 'ultra';
  if (k >= 50) return 'qualificado';
  if (k >= 30) return 'semi';
  return 'desqualificado';
}

// Faixa da resposta, ou null se vazia/lixo. Marcou mais de uma → vale a maior.
export function classifyRevenue(raw) {
  const value = normalize(raw);
  if (!value || value.startsWith('[ljava')) return null;
  const options = KNOWN_OPTIONS[value] ? [value] : value.split(',').map((s) => s.trim()).filter(Boolean);
  let best = null;
  for (const option of options) {
    const tier = KNOWN_OPTIONS[option] || tierFromNumbers(option);
    if (tier && (best === null || TIER_RANK[tier] > TIER_RANK[best])) best = tier;
  }
  return best;
}

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

// Carimbo do Forms (col 0) vem em M/D/AAAA H:M:S → "AAAA-MM".
function monthFromStamp(raw) {
  const m = String(raw || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return m ? `${m[3]}-${m[1].padStart(2, '0')}` : null;
}

function findCol(header, re) {
  return header.findIndex((h) => re.test(normalize(h)));
}

export function computeQualification(csv) {
  const [header = [], ...rows] = parseCSV(csv);
  const revCol = findCol(header, /faturamento/);
  const emailCol = findCol(header, /e-?mail/);
  const phoneCol = findCol(header, /telefone|whats/);

  // Mesmo lead preenchendo a aplicação mais de uma vez conta 1 — fica a
  // resposta mais recente (identificado por e-mail, senão telefone).
  const byLead = new Map();
  rows.forEach((r, i) => {
    const month = monthFromStamp(r[0]);
    if (!month) return;
    const email = emailCol >= 0 ? normalize(r[emailCol]) : '';
    const phone = phoneCol >= 0 ? String(r[phoneCol] || '').replace(/\D/g, '') : '';
    byLead.set(email || phone || `row-${i}`, { month, tier: revCol >= 0 ? classifyRevenue(r[revCol]) : null });
  });

  const empty = (month) => ({ month, total: 0, semResposta: 0, desqualificado: 0, semi: 0, qualificado: 0, ultra: 0 });
  const months = new Map();
  const totals = empty('total');
  for (const { month, tier } of byLead.values()) {
    if (!months.has(month)) months.set(month, empty(month));
    for (const b of [months.get(month), totals]) {
      b.total += 1;
      if (tier) b[tier] += 1; else b.semResposta += 1;
    }
  }
  return {
    totals,
    months: Array.from(months.values()).sort((a, b) => a.month.localeCompare(b.month)),
    respostas: rows.length,
  };
}

async function fetchApplicationsCsv() {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 12000);
  try {
    // cache-buster: garante que vem a versão atual da planilha, nunca uma cópia
    const r = await fetch(`${APLIC_CSV_URL}&_ts=${Date.now()}`, {
      redirect: 'follow',
      cache: 'no-store',
      headers: { 'User-Agent': 'DashboardBot/1.0', Accept: 'text/csv,*/*' },
      signal: controller.signal,
    });
    if (!r.ok) throw new Error(`planilha HTTP ${r.status}`);
    return await r.text();
  } finally {
    clearTimeout(t);
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
  // Sem cache: cada abertura da aba relê a planilha na hora.
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  try {
    const [csv, sales] = await Promise.all([fetchApplicationsCsv(), fetchWonDeals()]);
    const { totals, months, respostas } = computeQualification(csv);

    // Faturamento por mês de fechamento (hora de Brasília). Mesma régua do
    // webinar-sales: valor > R$300k é erro de digitação e fica fora da soma.
    const revenue = {};
    const vendas = {};
    for (const d of sales.deals) {
      if (!d.closed_at) continue;
      const month = new Date(new Date(d.closed_at).getTime() - 3 * 3600000).toISOString().slice(0, 7);
      const raw = Number(d.amount_total) || 0;
      revenue[month] = (revenue[month] || 0) + (raw > 0 && raw <= 300000 ? raw : 0);
      vendas[month] = (vendas[month] || 0) + 1;
    }

    res.status(200).json({
      totals,
      months: months.map((m) => ({
        ...m,
        faturamento: sales.ok ? revenue[m.month] || 0 : null,
        vendas: sales.ok ? vendas[m.month] || 0 : null,
      })),
      respostas,
      salesConnected: sales.ok,
      salesReason: sales.ok ? null : sales.reason,
      updatedAt: new Date().toISOString(),
    });
  } catch (e) {
    res.status(502).json({ error: e.message || 'falha ao ler a planilha de aplicação' });
  }
}
