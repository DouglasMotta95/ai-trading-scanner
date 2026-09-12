import { processSnapshot } from './core/orchestrator.js';

const allowedTransports = new Set(['ws', 'fetch', 'xhr']);
let lastRun = 0;

const num = v => v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null;
const clean = v => String(v ?? '').trim();
const normAsset = v => clean(v).toUpperCase().replace(/\s/g, '').replace(/-/g, '/');
const normTf = v => {
  const s = clean(v).toUpperCase();
  if (/^\d+S$/.test(s)) return `S${s.replace('S', '')}`;
  if (/^\d+M$/.test(s)) return `M${s.replace('M', '')}`;
  return s || null;
};
const normExp = v => clean(v).toLowerCase().replace(/\s+/g, '') || null;
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

const rank = s => ({ CONFIRM: 6, WATCH: 5, SEARCHING: 4, WAIT: 3, NO_TRADE: 2, CANCEL: 1, IDLE: 0 })[s] ?? 0;

function sanitizeRecentCandles(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const out = {};
  for (const [rawAsset, rows] of Object.entries(input).slice(0, 20)) {
    const asset = normAsset(rawAsset);
    if (!asset || !Array.isArray(rows)) continue;
    const cleanRows = rows.slice(-80).map(r => {
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

async function persistRecentCandles(payload = {}, sender = {}) {
  const recentCandles = sanitizeRecentCandles(payload.recentCandles || {});
  if (!Object.keys(recentCandles).length) return;
  const { scannerState = {} } = await chrome.storage.local.get('scannerState');
  if (scannerState.targetTabId && sender?.tab?.id && scannerState.targetTabId !== sender.tab.id) return;
  const latestNetwork = scannerState.diagnostics?.network || {};
  await chrome.storage.local.set({
    scannerState: {
      ...scannerState,
      diagnostics: {
        ...(scannerState.diagnostics || {}),
        network: { ...latestNetwork, recentCandles, historyUpdatedAt: Date.now() }
      },
      marketHistory: recentCandles
    }
  });
}

async function analyzeUniverse(payload = {}, sender = {}) {
  if (Date.now() - lastRun < 350) return;
  lastRun = Date.now();

  const { scannerState = {}, settings = {} } = await chrome.storage.local.get(['scannerState', 'settings']);
  if (scannerState.targetTabId && sender?.tab?.id && scannerState.targetTabId !== sender.tab.id) return;
  const prefs = settings.scanPreferences || {};
  if (prefs.scanScope === 'current' || scannerState.scanner !== 'scanning' || scannerState.license?.status !== 'active') {
    if (Array.isArray(scannerState.universeAnalysis) && scannerState.universeAnalysis.length) {
      const latest = (await chrome.storage.local.get('scannerState')).scannerState || scannerState;
      await chrome.storage.local.set({ scannerState: { ...latest, universeAnalysis: [], universeRecommendation: null } });
    }
    return;
  }
  if (!prefs.timeframe || prefs.timeframe === 'AUTO' || !prefs.expiration || prefs.expiration === 'AUTO') return;

  const candidates = (Array.isArray(payload.candidates) ? payload.candidates : []).filter(c => {
    const price = num(c?.price) ?? ((num(c?.bid) != null && num(c?.ask) != null) ? (num(c.bid) + num(c.ask)) / 2 : null);
    return normAsset(c?.asset) && price != null && price > 0 && allowedTransports.has(clean(c?.transport)) && Number(c?.seenCount || 0) >= 2 && Date.now() - Number(c?.observedAt || 0) <= 6000;
  }).slice(0, 30);

  const previous = new Map((scannerState.universeAnalysis || []).map(x => [`${x.asset}|${x.timeframe}`, x]));
  const out = [];
  for (const c of candidates) {
    const asset = normAsset(c.asset);
    const price = num(c.price) ?? ((num(c.bid) != null && num(c.ask) != null) ? (num(c.bid) + num(c.ask)) / 2 : null);
    const timeframe = normTf(prefs.timeframe || c.timeframe || scannerState.analysisTimeframe || scannerState.timeframe || 'M1') || 'M1';
    const expiration = normExp(prefs.expiration || c.expiration || scannerState.targetExpiration || scannerState.expiration || null);
    const prev = previous.get(`${asset}|${timeframe}`);
    const rawTs = num(c.timestamp);
    const serverTime = rawTs && rawTs > 1e12 ? rawTs : Number(c.observedAt) || Date.now();
    const snapshot = {
      platformId: scannerState.platformId || 'unknown',
      platformName: scannerState.platformName || 'Plataforma',
      asset,
      price,
      serverTime,
      timeframe,
      analysisTimeframe: timeframe,
      expiration,
      targetExpiration: expiration,
      candles: scannerState.marketHistory?.[asset] || [],
      capabilities: { ...(scannerState.capabilities || {}), structuredQuotes: true, multiAsset: true }
    };
    const localState = {
      ...scannerState,
      asset,
      price,
      analysisTimeframe: timeframe,
      targetExpiration: expiration,
      signal: prev?.signal || null,
      scanner: 'scanning'
    };
    const result = processSnapshot(snapshot, localState, riskFrom(settings, scannerState.license || {}));
    out.push({
      asset,
      price,
      timeframe,
      expiration,
      transport: clean(c.transport),
      seenCount: Number(c.seenCount || 0),
      observedAt: Number(c.observedAt || 0),
      requiresFocus: asset !== normAsset(scannerState.asset),
      signal: result.signal || prev?.signal || null,
      updatedAt: Date.now()
    });
  }

  out.sort((a, b) => rank(b.signal?.state) - rank(a.signal?.state) || Number(b.signal?.score || 0) - Number(a.signal?.score || 0) || Number(b.signal?.warmup?.current || 0) - Number(a.signal?.warmup?.current || 0));
  const recommendation = out[0] ? {
    asset: out[0].asset,
    price: out[0].price,
    timeframe: out[0].timeframe,
    expiration: out[0].expiration,
    direction: out[0].signal?.direction || null,
    score: out[0].signal?.score ?? 0,
    state: out[0].signal?.state || 'WAIT',
    requiresFocus: !!out[0].requiresFocus,
    updatedAt: Date.now()
  } : null;

  const latest = (await chrome.storage.local.get('scannerState')).scannerState || scannerState;
  await chrome.storage.local.set({
    scannerState: {
      ...latest,
      universeAnalysis: out.slice(0, 30),
      universeRecommendation: recommendation,
      capabilities: { ...(latest.capabilities || {}), multiAsset: out.length > 1 || latest.capabilities?.multiAsset }
    }
  });
}

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type !== 'ATS_NETWORK_DIAGNOSTIC') return;
  setTimeout(() => persistRecentCandles(message.payload || {}, sender).catch(() => {}), 140);
  setTimeout(() => analyzeUniverse(message.payload || {}, sender).catch(() => {}), 180);
});
