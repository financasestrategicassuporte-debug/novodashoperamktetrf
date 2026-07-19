// api/data.js — Vercel Serverless Function
// GET /api/data?range=7 dias
//
// Cruza:
//   - Meta Graph API (investimento, impressões, cliques, CTR, CPC, CPM)
//   - Google Sheets CSV público (leads: nome, faturamento, cargo, utm_campaign, utm_content)
//
// Variáveis de ambiente (configure em Vercel → Project → Settings → Environment Variables):
//   META_ACCESS_TOKEN     (obrigatório para trazer investimento/CTR/CPC reais)
//   META_AD_ACCOUNT_ID    (ex.: 762597382480878, sem "act_")
//   META_API_VERSION      (opcional, default v20.0)
//   SHEET_ID              (opcional, já tem default)
//   SHEET_GID             (opcional, já tem default)

const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN || '';
const META_AD_ACCOUNT_ID = process.env.META_AD_ACCOUNT_ID || '';
const META_API_VERSION = process.env.META_API_VERSION || 'v20.0';
const SHEET_ID = process.env.SHEET_ID || '1MW_dyf0VOHULceCCtY7FkCR_tLCCkM6YqPY-TQd8fjI';
const SHEET_GID = process.env.SHEET_GID || '1467696356';
const CSV_URL = process.env.SHEET_CSV_URL || `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${SHEET_GID}`;

// ---------- CSV ----------
async function fetchCsv(url) {
  const r = await fetch(url, {
    redirect: 'follow',
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DashboardBot/1.0)', Accept: 'text/csv,*/*' },
  });
  return { ok: r.ok, status: r.status, contentType: r.headers.get('content-type') || '', text: await r.text() };
}

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

function qualificationFor(value) {
  if (value == null) return { qual: 'Sem dado de faturamento', qualBg: '#f3f4f6', qualColor: '#6b7280' };
  if (value >= 150000) return { qual: 'Ultra Qualif. (+150k)', qualBg: '#f5f3ff', qualColor: '#7c3aed' };
  if (value >= 50000) return { qual: 'Qualificado (+50k)', qualBg: '#eff6ff', qualColor: '#2563eb' };
  if (value >= 30000) return { qual: 'Semi Qualif. (+30k)', qualBg: '#fffbeb', qualColor: '#b45309' };
  return { qual: 'Não Qualificado', qualBg: '#f9fafb', qualColor: '#6b7c72' };
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
  const now = new Date();
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

const AVATAR_COLORS = ['#7c3aed', '#2563eb', '16a34a', '#f59e0b', '#0891b2', '#dc2626'];
function initialsOf(name) {
  if (!name) return '??';
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '??';
  return (parts[0][0] + (parts[1] ? parts[1][0] : '')).toUpperCase();
}
function formatDataLabel(date) {
  if (!date) return '-';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(date.getDate())}/${p(date.getMonth() + 1)} · ${p(date.getHours())}h`;
}
function brl(n) { if (n == null || isNaN(n)) return '-'; return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }); }
function pct(n) { if (n == null || isNaN(n)) return '-'; return `${n.toFixed(2)}%`; }

function normTag(s) {
  return (s || '').toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Z0-9]+/g, ' ').trim();
}
function tagsMatch(a, b) {
  const na = normTag(a), nb = normTag(b);
  if (!na || !nb) return false;
  return na === nb || na.includes(nb) || nb.includes(na);
}

// ---------- Meta Ads ----------
async function fetchMetaInsights({ since, until, level }) {
  if (!META_ACCESS_TOKEN || !META_AD_ACCOUNT_ID) return { ok: false, reason: 'missing_credentials', rows: [] };
  const acct = META_AD_ACCOUNT_ID.startsWith('act_') ? META_AD_ACCOUNT_ID : `act_${META_AD_ACCOUNT_ID}`;
  const fields = level === 'ad'
    ? 'ad_name,campaign_name,adset_name,spend,impressions,clicks,ctr,cpc,cpm'
    : 'campaign_name,spend,impressions,clicks,ctr,cpc,cpm';
  const params = new URLSearchParams({
    level, fields,
    time_range: JSON.stringify({ since, until }),
    time_increment: 'all_days', limit: '200',
    access_token: META_ACCESS_TOKEN,
  });
  const url = `https://graph.facebook.com/${META_API_VERSION}/${acct}/insights?${params}`;
  const res = await fetch(url);
  const json = await res.json();
  if (!res.ok || json.error) return { ok: false, reason: json.error?.message || `HTTP ${res.status}`, rows: [] };
  return { ok: true, rows: json.data || [] };
}

async function fetchMetaDailySpend({ since, until }) {
  if (!META_ACCESS_TOKEN || !META_AD_ACCOUNT_ID) return { ok: false, rows: [] };
  const acct = META_AD_ACCOUNT_ID.startsWith('act_') ? META_AD_ACCOUNT_ID : `act_${META_AD_ACCOUNT_ID}`;
  const params = new URLSearchParams({
    level: 'account', fields: 'spend',
    time_range: JSON.stringify({ since, until }),
    time_increment: '1', limit: '200',
    access_token: META_ACCESS_TOKEN,
  });
  const url = `https://graph.facebook.com/${META_API_VERSION}/${acct}/insights?${params}`;
  const res = await fetch(url);
  const json = await res.json();
  if (!res.ok || json.error) return { ok: false, rows: [] };
  return { ok: true, rows: json.data || [] };
}

function enumerateDays(start, end) {
  const days = [];
  let d = new Date(start);
  while (d < end) { days.push(toISODate(d)); d = new Date(d.getTime() + 86400000); }
  return days;
}
function dayLabelOf(iso) {
  const [, m, d] = iso.split('-');
  return `${m}-${d}`;
}
function compactNumber(n) {
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}K`;
  return String(Math.round(n));
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 's-maxage=15, stale-while-revalidate=15');
  try {
    const csvRes = await fetchCsv(CSV_URL);
    if (!csvRes.ok) throw new Error(`Falha ao buscar a planilha (HTTP ${csvRes.status})`);
    if ((csvRes.contentType || '').includes('text/html') || /^\s*<!DOCTYPE/i.test(csvRes.text)) {
      throw new Error('A planilha retornou HTML em vez de CSV — verifique se o compartilhamento está como "Qualquer pessoa com o link -> Leitor".');
    }

    const rows = parseCSV(csvRes.text).filter((r) => r.some((c) => (c || '').trim() !== ''));
    if (!rows.length) throw new Error('Planilha vazia ou sem linhas com dados.');

    const headerIdx = rows.findIndex((r) => r.some((c) => /nome/i.test(c)));
    const header = headerIdx >= 0 ? rows[headerIdx] : rows[0];
    const dataRows = rows.slice((headerIdx >= 0 ? headerIdx : 0) + 1);
    const col = (name) => header.findIndex((h) => h.trim().toLowerCase() === name.toLowerCase());
    const idx = {
      data: col('Data/Hora'), nome: col('Nome'), faturamento: col('Faturamento'),
      area: col('Área'), utmCampaign: col('utm_campaign'), utmContent: col('utm_content'),
    };

    const { range } = req.query || {};
    const window = range ? rangeToWindow(range) : null;

    const leads = [];
    const leadsPerDayMap = new Map(); // iso date -> { naoQualif, qualif, ultra }
    const hourBuckets = { madrugada: 0, manha: 0, tarde: 0, noite: 0 };
    dataRows.forEach((r, i) => {
      const nome = idx.nome >= 0 ? (r[idx.nome] || '').trim() : '';
      if (!nome) return;
      const parsedDate = idx.data >= 0 ? parseRowDate(r[idx.data]) : null;
      if (window && parsedDate && (parsedDate < window.start || parsedDate >= window.end)) return;

      const faturamentoRaw = idx.faturamento >= 0 ? (r[idx.faturamento] || '').trim() : '';
      const faturamentoValor = parseFaturamento(faturamentoRaw);
      const q = qualificationFor(faturamentoValor);

      if (parsedDate) {
        const iso = toISODate(parsedDate);
        if (!leadsPerDayMap.has(iso)) leadsPerDayMap.set(iso, { naoQualif: 0, qualif: 0, ultra: 0 });
        const bucket = leadsPerDayMap.get(iso);
        if (faturamentoValor != null && faturamentoValor >= 100000) bucket.ultra += 1;
        else if (faturamentoValor != null && faturamentoValor >= 50000) bucket.qualif += 1;
        else bucket.naoQualif += 1;

        const h = parsedDate.getHours();
        if (h < 8) hourBuckets.madrugada += 1;
        else if (h < 12) hourBuckets.manha += 1;
        else if (h < 18) hourBuckets.tarde += 1;
        else hourBuckets.noite += 1;
      }

      leads.push({
        nome, initials: initialsOf(nome), avatarBg: AVATAR_COLORS[i % AVATAR_COLORS.length],
        camp: (idx.utmCampaign >= 0 ? r[idx.utmCampaign] : '') || '(sem campanha)',
        renda: faturamentoRaw || '-', cargo: (idx.area >= 0 ? r[idx.area] : '') || '-',
        qual: q.qual, qualBg: q.qualBg, qualColor: q.qualColor, data: formatDataLabel(parsedDate),
        _fat: faturamentoValor,
        _camp: (idx.utmCampaign >= 0 ? r[idx.utmCampaign] : '') || '(sem campanha)',
        _content: (idx.utmContent >= 0 ? r[idx.utmContent] : '') || '(sem criativo)',
      });
    });

    const metaWindow = window || rangeToWindow('30 dias');
    const since = toISODate(metaWindow.start);
    const until = toISODate(new Date(metaWindow.end.getTime() - 86400000));

    const [campaignInsights, adInsights, dailySpendInsights] = await Promise.all([
      fetchMetaInsights({ since, until, level: 'campaign' }),
      fetchMetaInsights({ since, until, level: 'ad' }),
      fetchMetaDailySpend({ since, until }),
    ]);
    const metaOk = campaignInsights.ok;

    const byCampaign = new Map();
    leads.forEach((l) => {
      const key = l._camp;
      if (!byCampaign.has(key)) byCampaign.set(key, { camp: key, total: 0, qualif: 0, spend: 0, impressions: 0, clicks: 0, matched: false });
      const g = byCampaign.get(key);
      g.total += 1;
      if (l._fat != null && l._fat >= 50000) g.qualif += 1;
    });
    let totalSpend = 0, totalImpressions = 0, totalClicks = 0;
    if (metaOk) {
      campaignInsights.rows.forEach((row) => {
        const spend = parseFloat(row.spend || '0') || 0;
        const impressions = parseInt(row.impressions || '0', 10) || 0;
        const clicks = parseInt(row.clicks || '0', 10) || 0;
        totalSpend += spend; totalImpressions += impressions; totalClicks += clicks;
        let matchedKey = null;
        for (const key of byCampaign.keys()) { if (tagsMatch(key, row.campaign_name)) { matchedKey = key; break; } }
        if (matchedKey) {
          const g = byCampaign.get(matchedKey);
          g.spend += spend; g.impressions += impressions; g.clicks += clicks; g.matched = true;
        } else {
          byCampaign.set(`__meta__${row.campaign_name}`, { camp: row.campaign_name, total: 0, qualif: 0, spend, impressions, clicks, matched: true });
        }
      });
    }
    const maxQualif = Math.max(1, ...Array.from(byCampaign.values()).map((g) => g.qualif));
    const campaignsList = Array.from(byCampaign.values())
      .sort((a, b) => b.qualif - a.qualif || b.total - a.total)
      .map((g) => {
        const txQualif = g.total ? (g.qualif / g.total) * 100 : 0;
        const ctr = g.impressions ? (g.clicks / g.impressions) * 100 : null;
        const cpc = g.clicks ? g.spend / g.clicks : null;
        const custoLead = g.matched && g.total ? g.spend / g.total : null;
        return {
          camp: g.camp, leadsQualif: String(g.qualif),
          leadsQualifBarWidth: `${Math.round((g.qualif / maxQualif) * 100)}%`,
          totalLeads: String(g.total),
          invest: g.matched ? brl(g.spend) : '-',
          custoLead: custoLead != null ? brl(custoLead) : '-',
          ctr: ctr != null ? pct(ctr) : '-',
          cpc: cpc != null ? brl(cpc) : '-',
          txQualif: pct(txQualif),
          txQualifBg: txQualif > 0 ? '#dcfce7' : '#f5f3ff',
          txQualifColor: txQualif > 0 ? '#15803d' : '#7c3aed',
        };
      });

    const byContent = new Map();
    leads.forEach((l) => {
      const key = l._content;
      if (!byContent.has(key)) byContent.set(key, { nome: key, camp: l._camp, leads: 0, qualif: 0, spend: 0, impressions: 0, clicks: 0, matched: false });
      const g = byContent.get(key);
      g.leads += 1;
      if (l._fat != null && l._fat >= 50000) g.qualif += 1;
    });
    if (adInsights.ok) {
      adInsights.rows.forEach((row) => {
        const spend = parseFloat(row.spend || '0') || 0;
        const impressions = parseInt(row.impressions || '0', 10) || 0;
        const clicks = parseInt(row.clicks || '0', 10) || 0;
        for (const key of byContent.keys()) {
          if (tagsMatch(key, row.ad_name)) {
            const g = byContent.get(key);
            g.spend += spend; g.impressions += impressions; g.clicks += clicks; g.matched = true;
            break;
          }
        }
      });
    }
    const rankColors = ['#16a34a', '#2563eb', '#94a3b8', '#94a3b8', '#94a3b8', '#94a3b8'];
    const creativesList = Array.from(byContent.values())
      .sort((a, b) => b.qualif - a.qualif || b.leads - a.leads)
      .slice(0, 6)
      .map((g, i) => {
        const cpl = g.matched && g.leads ? g.spend / g.leads : null;
        const cplq = g.matched && g.qualif ? g.spend / g.qualif : null;
        const ctr = g.impressions ? (g.clicks / g.impressions) * 100 : null;
        return {
          rank: i + 1, rankBg: rankColors[i] || '#94a3b8',
          cardBg: i === 0 ? '#f6fdf8' : '#f9fbf9', cardBorder: i === 0 ? '#bbf7d0' : '#e8ece8',
          tag: g.qualif > 0 ? 'COM LEAD QUALIF.' : 'SEM LEAD QUALIF.',
          tagBg: g.qualif > 0 ? '#dcfce7' : '#fef3c7', tagColor: g.qualif > 0 ? '#15803d' : '#b45309',
          nome: g.nome, camp: g.camp,
          cpl: cpl != null ? brl(cpl) : '-',
          cplq: cplq != null ? brl(cplq) : '-',
          cplqColor: cplq != null ? '#16a34a' : '#93a29a',
          qualif: String(g.qualif),
          invest: g.spend ? brl(g.spend) : '-',
          ctr: ctr != null ? pct(ctr) : '-',
          leads: String(g.leads),
        };
      });

    const leadsList = leads.map(({ _fat, _camp, _content, ...rest }) => rest).sort((a, b) => (a.data < b.data ? 1 : -1));

    const totalLeads = leads.length;
    const leadsQualificados = leads.filter((l) => l._fat != null && l._fat >= 50000).length;
    const kpis = {
      investimento: metaOk ? brl(totalSpend) : '-',
      investimentoValor: metaOk ? totalSpend : 0,
      impressoes: metaOk ? totalImpressions : null,
      cliques: metaOk ? totalClicks : null,
      leads: totalLeads,
      leadsQualificados,
      cpl: metaOk && totalLeads ? brl(totalSpend / totalLeads) : '-',
      cplQualificado: metaOk && leadsQualificados ? brl(totalSpend / leadsQualificados) : '-',
      ctr: metaOk && totalImpressions ? pct((totalClicks / totalImpressions) * 100) : '-',
      cpc: metaOk && totalClicks ? brl(totalSpend / totalClicks) : '-',
      cpm: metaOk && totalImpressions ? brl((totalSpend / totalImpressions) * 1000) : '-',
      taxaConexao: null,
    };

    const dayLabels = enumerateDays(metaWindow.start, metaWindow.end);
    const spendByDate = new Map();
    if (dailySpendInsights.ok) {
      dailySpendInsights.rows.forEach((row) => {
        spendByDate.set(row.date_start, (spendByDate.get(row.date_start) || 0) + (parseFloat(row.spend || '0') || 0));
      });
    }
    const dailySpend = dayLabels.map((iso) => ({
      date: iso, label: dayLabelOf(iso), spend: spendByDate.get(iso) || 0,
    }));
    const leadsPerDay = dayLabels.map((iso) => {
      const b = leadsPerDayMap.get(iso) || { naoQualif: 0, qualif: 0, ultra: 0 };
      return { date: iso, label: dayLabelOf(iso), naoQualif: b.naoQualif, qualif: b.qualif, ultra: b.ultra, total: b.naoQualif + b.qualif + b.ultra };
    });
    const hourTotal = hourBuckets.madrugada + hourBuckets.manha + hourBuckets.tarde + hourBuckets.noite;
    const hourPct = (n) => (hourTotal ? (n / hourTotal) * 100 : 0);
    const hourlyDistribution = [
      { key: 'madrugada', label: 'Madrugada / antes 8h', range: '00h-08h', count: hourBuckets.madrugada, pct: hourPct(hourBuckets.madrugada) },
      { key: 'manha', label: 'Manhã', range: '08h-12h', count: hourBuckets.manha, pct: hourPct(hourBuckets.manha) },
      { key: 'tarde', label: 'Tarde', range: '12h-18h', count: hourBuckets.tarde, pct: hourPct(hourBuckets.tarde) },
      { key: 'noite', label: 'Noite', range: '18h-23h', count: hourBuckets.noite, pct: hourPct(hourBuckets.noite) },
    ];

    res.status(200).json({
      kpis, leadsList, creativesList, campaignsList,
      dailySpend, leadsPerDay, hourlyDistribution,
      meta: { connected: metaOk, error: metaOk ? null : campaignInsights.reason },
      source: 'meta+google-sheets',
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
