import { processSnapshot } from './core/orchestrator.js';

const allowedTransports = new Set(['ws', 'fetch', 'xhr']);
let lastRun = 0;

const num = v => v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null;
const clean = v => String(v ?? '').trim();
const normAsset = v => {
  let s = clean(v).toUpperCase();
  const otc = /(?:\(|\b|[_-])OTC(?:\)|\b)?/.test(s);
  s = s.replace(/\(OTC\)|\bOTC\b/g, '').replace(/^FRX[:_-]?/, '').replace(/\s+/g, '').replace(/_/g, '/').replace(/-/g, '/');
  s = s.replace(/^\/+|\/+$/g, '').replace(/\/{2,}/g, '/');
  if (!s.includes('/')) {
    const quotes = ['USDT', 'USDC', 'USD', 'EUR', 'GBP', 'JPY', 'AUD', 'CAD', 'CHF', 'NZD', 'BRL', 'BTC', 'ETH'];
    const q = quotes.find(x => s.length > x.length && s.endsWith(x));
    if (q) s = `${s.slice(0, -q.length)}/${q}`;
    else if (/^[A-Z]{6}$/.test(s)) s = `${s.slice(0, 3)}/${s.slice(3)}`;
  }
  return s ? `${s}${otc ? ' (OTC)' : ''}` : '';
};
const normTf = v => {
  const s = clean(v).toUpperCase().replace(/\s+/g, '');
  if (/^\d+M$/.test(s)) return `M${s.replace('M', '')}`;
  if (/^\d+S$/.test(s)) return `S${s.replace('S', '')}`;
  if (/^M\d+$/.test(s) || /^S\d+$/.test(s) || /^H\d+$/.test(s)) return s;
  return s || null;
};
const normExp = v => {
  const s = clean(v).toLowerCase().replace(/\s+/g, '');
  let m = s.match(/^(\d+)s$/); if (m) return `${Number(m[1])}s`;
  m = s.match(/^(\d+)m(?:in)?$/); if (m) return Number(m[1]) === 1 ? '60s' : `${Number(m[1])}m`;
  return s || null;
};
const riskFrom = (settings = {}, license = {}) => ({
  ...settings?.risk,
  minScore: settings?.risk?.minScore ?? settings?.minScore,
  onlyA: settings?.risk?.onlyA ?? settings?.onlyA,
  staleBlock: settings?.risk?.staleBlock ?? settings?.staleBlock,
  staleMs: settings?.risk?.staleMs ?? settings?.staleMs,
  signalsToday: license.usedToday ?? settings?.risk?.signalsToday ?? 0,
  maxSignals: license.dailyLimit ?? settings?.risk?.maxSignals ?? settings?.maxSignals ?? 20,
  maxConsecutiveLosses: settings?.risk?.maxConsecutiveLosses ?? settings?.maxConsecutiveLosses,
  cooldownMs: settings?.risk?.cooldownMs ?? settings?.cooldownMs
});
const rank = state => ({ CONFIRM: 6, WATCH: 5, SEARCHING: 4, WAIT: 3, NO_TRADE: 2, CANCEL: 1, IDLE: 0 })[state] ?? 0;

function sanitizeRecentCandles(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const out = {};
  for (const [rawAsset, rows] of Object.entries(input).slice(0, 60)) {
    const asset = normAsset(rawAsset);
    if (!asset || !Array.isArray(rows)) continue;
    const cleanRows = rows.slice(-180).map(r => {
      let time = num(r?.time ?? r?.timestamp);
      if (time != null && time > 0 && time < 1e12) time *= 1000;
      const open = num(r?.open), high = num(r?.high), low = num(r?.low), close = num(r?.close);
      if (![time, open, high, low, close].every(Number.isFinite)) return null;
      return { time, open, high, low, close, timeframe: normTf(r?.timeframe) };
    }).filter(Boolean).sort((a, b) => a.time - b.time);
    if (cleanRows.length) out[asset] = cleanRows;
  }
  return out;
}

function sessionContext(asset, when = new Date()) {
  const value = normAsset(asset);
  const otc = /\(OTC\)$/.test(value);
  if (otc) return {
    code: 'OTC', label: 'Mercado OTC', active: true, score: 0,
    note: 'OTC não segue a sessão oficial do par. O ATS prioriza o feed e a estrutura observada na própria plataforma.'
  };
  const h = when.getUTCHours() + when.getUTCMinutes() / 60;
  const sessions = [
    { code: 'ASIA', label: 'Ásia', start: 0, end: 9, currencies: ['JPY', 'AUD', 'NZD'] },
    { code: 'LONDRES', label: 'Londres', start: 7, end: 16, currencies: ['EUR', 'GBP', 'CHF'] },
    { code: 'NY', label: 'Nova York', start: 12, end: 21, currencies: ['USD', 'CAD', 'BRL'] }
  ];
  const currencies = value.replace(/ \(OTC\)$/, '').split('/');
  const active = sessions.filter(s => h >= s.start && h < s.end);
  const relevant = active.filter(s => currencies.some(c => s.currencies.includes(c)));
  const chosen = relevant[0] || active[0] || null;
  const overlap = active.length > 1;
  return {
    code: chosen?.code || 'FORA',
    label: chosen ? `${chosen.label}${overlap ? ' • sobreposição' : ''}` : 'Fora das sessões principais',
    active: !!chosen,
    score: relevant.length ? (overlap ? 8 : 5) : 0,
    note: chosen ? 'Sessão compatível com as moedas do par. Use como contexto, não como garantia de entrada.' : 'Liquidez pode ser menor fora das sessões principais.'
  };
}

function intelligenceFrom(rows = [], scannerState = {}) {
  const top = rows.slice(0, 8).map(x => {
    const session = sessionContext(x.asset);
    const signalScore = Number(x.signal?.score || 0);
    const structured = x.transport === 'ws' || !!x.structured;
    return {
      asset: x.asset,
      direction: x.signal?.direction || null,
      state: x.signal?.state || 'WAIT',
      score: signalScore,
      adjustedScore: Math.max(0, Math.min(100, signalScore + session.score)),
      timeframe: x.timeframe || null,
      expiration: x.expiration || null,
      feed: x.transport || null,
      structured,
      session,
      warmup: x.signal?.warmup || null,
      updatedAt: x.updatedAt
    };
  }).sort((a, b) => rank(b.state) - rank(a.state) || b.adjustedScore - a.adjustedScore);
  const viable = top.filter(x => ['CONFIRM', 'WATCH'].includes(x.state) && x.structured).slice(0, 3);
  return {
    generatedAt: Date.now(),
    engine: 'ranking-quantitativo-local',
    externalAi: 'nao_configurada',
    summary: viable.length
      ? `${viable.length} mercado${viable.length > 1 ? 's' : ''} com leitura técnica em destaque agora.`
      : top.length
        ? 'Ainda não há mercado com confirmação suficiente. O ATS continua acompanhando os melhores candidatos.'
        : 'Aguardando o feed da plataforma para classificar os mercados.',
    top: top.slice(0, 3),
    currentAsset: scannerState.asset || null,
    note: 'O ranking usa dados reais da plataforma, confluência técnica e contexto de sessão. Uma IA externa não é simulada sem provedor configurado.'
  };
}

async function analyzeUniverse(payload = {}, sender = {}) {
  if (Date.now() - lastRun < 220) return;
  lastRun = Date.now();
  const { scannerState = {}, settings = {} } = await chrome.storage.local.get(['scannerState', 'settings']);
  if (scannerState.targetTabId && sender?.tab?.id && scannerState.targetTabId !== sender.tab.id) return;

  const recentCandles = sanitizeRecentCandles(payload.recentCandles || {});
  const latestNetwork = {
    ...(scannerState.diagnostics?.network || {}),
    messages: payload.messages || {},
    connections: payload.connections || {},
    endpoints: Array.isArray(payload.endpoints) ? payload.endpoints.slice(-24) : [],
    keys: Array.isArray(payload.keys) ? payload.keys.slice(0, 160) : [],
    candidates: Array.isArray(payload.candidates) ? payload.candidates.slice(0, 150) : [],
    candidateCount: Number(payload.candidateCount || 0),
    recentCandles,
    feedQuality: Number(payload.feedQuality || 0),
    parser: payload.parser || {},
    primaryTransport: payload.primaryTransport || null,
    lastSeen: Date.now()
  };

  const prefs = settings.scanPreferences || {};
  const activeLicense = scannerState.license?.status === 'active';
  const candidates = latestNetwork.candidates.filter(c => {
    const price = num(c?.price) ?? ((num(c?.bid) != null && num(c?.ask) != null) ? (num(c.bid) + num(c.ask)) / 2 : null);
    return normAsset(c?.asset) && price != null && price > 0 && allowedTransports.has(clean(c?.transport)) && Number(c?.seenCount || 0) >= 2 && Date.now() - Number(c?.observedAt || 0) <= 6500;
  }).slice(0, 60);

  if (!activeLicense || !candidates.length) {
    const latest = (await chrome.storage.local.get('scannerState')).scannerState || scannerState;
    await chrome.storage.local.set({ scannerState: {
      ...latest,
      marketHistory: recentCandles,
      diagnostics: { ...(latest.diagnostics || {}), network: latestNetwork },
      universeAnalysis: activeLicense ? (latest.universeAnalysis || []) : [],
      universeRecommendation: activeLicense ? latest.universeRecommendation || null : null,
      marketIntelligence: intelligenceFrom(activeLicense ? latest.universeAnalysis || [] : [], latest)
    } });
    return;
  }

  const previous = new Map((scannerState.universeAnalysis || []).map(x => [`${normAsset(x.asset)}|${normTf(x.timeframe)}`, x]));
  const out = [];
  for (const c of candidates) {
    const asset = normAsset(c.asset);
    const price = num(c.price) ?? ((num(c.bid) != null && num(c.ask) != null) ? (num(c.bid) + num(c.ask)) / 2 : null);
    const timeframe = normTf((prefs.timeframe && prefs.timeframe !== 'AUTO') ? prefs.timeframe : (c.timeframe || scannerState.timeframe || scannerState.analysisTimeframe));
    const expiration = normExp((prefs.expiration && prefs.expiration !== 'AUTO') ? prefs.expiration : (c.expiration || scannerState.expiration || scannerState.targetExpiration));
    if (!timeframe) continue;
    const prev = previous.get(`${asset}|${timeframe}`);
    const rawTs = num(c.timestamp);
    const serverTime = rawTs && rawTs > 1e12 ? rawTs : Number(c.observedAt) || Date.now();
    const historyKey = Object.keys(recentCandles).find(k => normAsset(k) === asset);
    const candles = historyKey ? recentCandles[historyKey] : [];
    const snapshot = {
      platformId: scannerState.platformId || 'casatrade',
      platformName: scannerState.platformName || 'CasaTrade',
      asset, price, serverTime, timeframe, analysisTimeframe: timeframe,
      expiration, targetExpiration: expiration,
      candles: Array.isArray(candles) ? candles : [],
      capabilities: { ...(scannerState.capabilities || {}), structuredQuotes: true, candles: Array.isArray(candles) && candles.length >= 3, multiAsset: candidates.length > 1 }
    };
    const localState = {
      ...scannerState, asset, price, analysisTimeframe: timeframe, targetExpiration: expiration,
      signal: prev?.signal || null, scanner: 'scanning'
    };
    const result = processSnapshot(snapshot, localState, riskFrom(settings, scannerState.license || {}));
    out.push({
      asset, price, timeframe, expiration,
      transport: clean(c.transport), structured: true,
      confidence: Number(c.confidence || 0), seenCount: Number(c.seenCount || 0), observedAt: Number(c.observedAt || 0),
      payout: num(c.payout), instrumentType: c.instrumentType || null,
      marketType: c.marketType || (/\(OTC\)$/.test(asset) ? 'otc' : 'regular'),
      requiresFocus: asset !== normAsset(scannerState.asset),
      signal: result.signal || prev?.signal || null,
      updatedAt: Date.now()
    });
  }

  out.sort((a, b) => rank(b.signal?.state) - rank(a.signal?.state) || Number(b.signal?.score || 0) - Number(a.signal?.score || 0) || Number(b.signal?.warmup?.current || 0) - Number(a.signal?.warmup?.current || 0));
  const recommendation = out[0] ? {
    asset: out[0].asset, price: out[0].price, timeframe: out[0].timeframe, expiration: out[0].expiration,
    direction: out[0].signal?.direction || null, score: out[0].signal?.score ?? 0,
    state: out[0].signal?.state || 'WAIT', requiresFocus: !!out[0].requiresFocus, updatedAt: Date.now()
  } : null;

  const latest = (await chrome.storage.local.get('scannerState')).scannerState || scannerState;
  await chrome.storage.local.set({ scannerState: {
    ...latest,
    marketHistory: recentCandles,
    diagnostics: { ...(latest.diagnostics || {}), network: latestNetwork },
    universeAnalysis: out.slice(0, 60),
    universeRecommendation: recommendation,
    marketIntelligence: intelligenceFrom(out, latest),
    capabilities: { ...(latest.capabilities || {}), multiAsset: out.length > 1 || latest.capabilities?.multiAsset }
  } });
}

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type !== 'ATS_NETWORK_DIAGNOSTIC') return;
  setTimeout(() => analyzeUniverse(message.payload || {}, sender).catch(() => {}), 60);
});
