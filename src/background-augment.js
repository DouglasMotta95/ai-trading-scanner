import { processSnapshot, resetOrchestrator } from './core/orchestrator.js';
import { isCasaTradeHost } from './platforms/registry.js';

const allowedTransports = new Set(['ws', 'fetch', 'xhr', 'rendered', 'worker', 'sharedworker', 'broadcast', 'serviceworker', 'window']);
const quotes = new Set(['USDT','USDC','USD','EUR','GBP','JPY','AUD','CAD','CHF','NZD','BRL','BTC','ETH']);
const focusedAssets = new Map();
let lastRun = 0;
const num = v => v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null;
const clean = v => String(v ?? '').trim();
const FOCUS_STABLE_MS = 2000;
const licenseActive = state => ['active', 'valid'].includes(String(state?.license?.status || '').toLowerCase());

const trustedEmbeddedHost = host => {
  const h = clean(host).toLowerCase().replace(/\.$/, '');
  return h === 'casatraders.online' || h.endsWith('.casatraders.online') ||
    h === 'ivcasatraders.online' || h.endsWith('.ivcasatraders.online');
};

const normAsset = v => {
  let s = clean(v).toUpperCase();
  if (!s) return '';
  const otc = /(?:\(|\b|[_-])OTC(?:\)|\b)?/.test(s);
  s = s.replace(/\(OTC\)|\bOTC\b/g, '').replace(/^FRX[:_-]?/, '').replace(/\s+/g, '').replace(/_/g, '/').replace(/-/g, '/').replace(/^\/+|\/+$/g, '').replace(/\/{2,}/g, '/');
  if (!s.includes('/')) {
    const q = [...quotes].find(x => s.length > x.length && s.endsWith(x));
    if (q) s = `${s.slice(0, -q.length)}/${q}`;
    else if (/^[A-Z]{6}$/.test(s)) s = `${s.slice(0, 3)}/${s.slice(3)}`;
  }
  const m = s.match(/^([A-Z0-9]{2,16})\/([A-Z0-9]{2,12})$/);
  if (!m || !quotes.has(m[2])) return '';
  return `${m[1]}/${m[2]}${otc ? ' (OTC)' : ''}`;
};

const sameAsset = (a, b) => {
  const left = normAsset(a);
  const right = normAsset(b);
  return !!left && !!right && left === right;
};

const normTf = v => {
  const s = clean(v).toUpperCase().replace(/\s+/g, '');
  if (/^\d+M$/.test(s)) return `M${s.replace('M', '')}`;
  if (/^\d+S$/.test(s)) return `S${s.replace('S', '')}`;
  if (/^M\d+$/.test(s) || /^S\d+$/.test(s) || /^H\d+$/.test(s)) return s;
  return null;
};

const normExp = v => {
  const s = clean(v).toLowerCase().replace(/\s+/g, '');
  let m = s.match(/^(\d+)s$/); if (m) return `${Number(m[1])}s`;
  m = s.match(/^(\d+)m(?:in)?$/); if (m) return Number(m[1]) === 1 ? '60s' : `${Number(m[1])}m`;
  return s || null;
};

function sanitizeRows(rows = []) {
  if (!Array.isArray(rows)) return [];
  return rows.slice(-240).map(r => {
    let time = num(r?.time ?? r?.timestamp);
    if (time != null && time > 0 && time < 1e12) time *= 1000;
    const open = num(r?.open), high = num(r?.high), low = num(r?.low), close = num(r?.close);
    if (![time, open, high, low, close].every(Number.isFinite)) return null;
    return { time, open, high, low, close, timeframe: normTf(r?.timeframe) };
  }).filter(Boolean).sort((a, b) => a.time - b.time);
}

function sanitizeRecentCandles(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const out = {};
  for (const [rawAsset, rows] of Object.entries(input).slice(0, 80)) {
    const asset = normAsset(rawAsset);
    const cleanRows = sanitizeRows(rows);
    if (asset && cleanRows.length) out[asset] = cleanRows;
  }
  return out;
}

function normalizedCandidates(payload = {}) {
  return (Array.isArray(payload.candidates) ? payload.candidates : []).slice(0, 240).map(c => {
    const asset = normAsset(c?.asset);
    const bid = num(c?.bid), ask = num(c?.ask);
    const price = num(c?.price) ?? (bid != null && ask != null ? (bid + ask) / 2 : null);
    const transport = clean(c?.transport || payload.primaryTransport || '');
    return { ...c, asset, bid, ask, price, transport };
  }).filter(c => c.asset && c.price != null && c.price > 0 && (!c.transport || allowedTransports.has(c.transport)));
}

function chooseCandidate(payload = {}, focusedAsset = '') {
  const focus = normAsset(focusedAsset);
  if (!focus) return null;
  const rows = normalizedCandidates(payload).filter(row => sameAsset(row.asset, focus));
  rows.sort((a, b) =>
    Number(b?.selected === true) - Number(a?.selected === true)
    || Number(b?.confidence || 0) - Number(a?.confidence || 0)
    || Number(b?.seenCount || 0) - Number(a?.seenCount || 0)
    || Number(b?.observedAt || 0) - Number(a?.observedAt || 0)
  );
  return rows[0] || null;
}

function focusedAssetFor(tabId, scannerState = {}) {
  const inMemory = normAsset(focusedAssets.get(tabId));
  if (inMemory) return inMemory;
  const stored = normAsset(scannerState?.diagnostics?.focusedAsset?.asset);
  return stored || '';
}

async function keepRealFeedContext(payload = {}, sender = {}) {
  if (Date.now() - lastRun < 80) return;
  lastRun = Date.now();
  const { scannerState = {}, settings = {} } = await chrome.storage.local.get(['scannerState', 'settings']);
  if (!licenseActive(scannerState) || settings.runtimePaused) return;
  if (scannerState.targetTabId && sender?.tab?.id && scannerState.targetTabId !== sender.tab.id) return;

  const recentCandles = sanitizeRecentCandles(payload.recentCandles || {});
  const candidates = normalizedCandidates(payload);
  const previousNetwork = scannerState.diagnostics?.network || {};
  const mergedHistory = { ...(previousNetwork.recentCandles || {}) };
  for (const [asset, rows] of Object.entries(recentCandles)) {
    const previous = Array.isArray(mergedHistory[asset]) ? mergedHistory[asset] : [];
    const byTime = new Map([...previous, ...rows].map(row => [`${row.time}|${row.timeframe || ''}`, row]));
    mergedHistory[asset] = [...byTime.values()].sort((a, b) => a.time - b.time).slice(-240);
  }

  const previousCandidates = Array.isArray(previousNetwork.candidates) ? previousNetwork.candidates : [];
  const mergedCandidates = [...candidates, ...previousCandidates].filter((c, index, arr) => {
    const asset = normAsset(c?.asset);
    const price = num(c?.price) ?? ((num(c?.bid) != null && num(c?.ask) != null) ? (num(c.bid) + num(c.ask)) / 2 : null);
    if (!asset || price == null || price <= 0) return false;
    return arr.findIndex(x => normAsset(x?.asset) === asset && clean(x?.transport) === clean(c?.transport)) === index;
  }).slice(0, 180);

  const latest = (await chrome.storage.local.get('scannerState')).scannerState || scannerState;
  await chrome.storage.local.set({
    scannerState: {
      ...latest,
      marketHistory: mergedHistory,
      diagnostics: {
        ...(latest.diagnostics || {}),
        network: {
          ...previousNetwork,
          messages: payload.messages || previousNetwork.messages || {},
          connections: payload.connections || previousNetwork.connections || {},
          endpoints: Array.isArray(payload.endpoints) ? payload.endpoints.slice(-30) : (previousNetwork.endpoints || []),
          keys: Array.isArray(payload.keys) ? payload.keys.slice(0, 180) : (previousNetwork.keys || []),
          candidates: mergedCandidates,
          candidateCount: mergedCandidates.length,
          recentCandles: mergedHistory,
          feedQuality: Math.max(Number(previousNetwork.feedQuality || 0), Number(payload.feedQuality || 0)),
          parser: { ...(previousNetwork.parser || {}), ...(payload.parser || {}) },
          primaryTransport: payload.primaryTransport || previousNetwork.primaryTransport || null,
          lastSeen: Date.now()
        }
      }
    }
  });
}

async function setFocusedAsset(asset, sender = {}) {
  const focused = normAsset(asset);
  if (!focused || !sender?.tab?.id || sender.frameId !== 0) return;

  let senderHost = '';
  try { senderHost = new URL(sender.url || sender.tab.url || '').hostname; } catch {}
  if (!isCasaTradeHost(senderHost)) return;

  const tabId = sender.tab.id;
  const previousFocus = focusedAssets.get(tabId) || '';
  focusedAssets.set(tabId, focused);

  const { scannerState = {} } = await chrome.storage.local.get('scannerState');
  if (!licenseActive(scannerState)) return;
  if (scannerState.targetTabId && scannerState.targetTabId !== tabId) return;

  const previousStored = scannerState.diagnostics?.focusedAsset || null;
  const sameStoredFocus = sameAsset(previousStored?.asset, focused);
  const changed = (!!previousFocus && !sameAsset(previousFocus, focused)) || (!!previousStored?.asset && !sameStoredFocus);
  const stateAssetMismatch = scannerState.asset && !sameAsset(scannerState.asset, focused);
  const stableSince = sameStoredFocus
    ? Number(previousStored?.stableSince || previousStored?.at || Date.now())
    : Date.now();
  if (changed || stateAssetMismatch) resetOrchestrator();
  const next = {
    ...scannerState,
    targetTabId: tabId,
    ...(changed || stateAssetMismatch ? {
      asset: focused,
      price: null,
      candles: [],
      currentCandle: null,
      signal: null,
      lastSeen: Date.now()
    } : {}),
    diagnostics: {
      ...(scannerState.diagnostics || {}),
      focusedAsset: { asset: focused, at: Date.now(), stableSince, source: 'chart-header' }
    }
  };
  await chrome.storage.local.set({ scannerState: next });
}

async function applyEmbeddedFeed(payload = {}, sender = {}) {
  let frameHost = '';
  let topHost = '';
  try { frameHost = new URL(sender?.url || '').hostname; } catch {}
  try { topHost = new URL(sender?.tab?.url || '').hostname; } catch {}
  if (!trustedEmbeddedHost(frameHost) || !isCasaTradeHost(topHost) || !sender?.tab?.id) return;

  await keepRealFeedContext(payload, sender).catch(() => {});
  const { scannerState = {}, settings = {} } = await chrome.storage.local.get(['scannerState', 'settings']);
  if (!licenseActive(scannerState) || settings.runtimePaused) return;
  if (scannerState.targetTabId && scannerState.targetTabId !== sender.tab.id) return;

  const focusedAsset = focusedAssetFor(sender.tab.id, scannerState);
  if (!focusedAsset) return;
  const focusMeta = scannerState.diagnostics?.focusedAsset || null;
  const stableSince = Number(focusMeta?.stableSince || focusMeta?.at || 0);
  if (!sameAsset(focusMeta?.asset, focusedAsset)) return;
  if (!Number.isFinite(stableSince) || Date.now() - stableSince < FOCUS_STABLE_MS) return;

  const candidate = chooseCandidate(payload, focusedAsset);
  if (!candidate) return;

  const allHistory = sanitizeRecentCandles(payload.recentCandles || {});
  const historyKey = Object.keys(allHistory).find(k => sameAsset(k, focusedAsset));
  const candles = historyKey ? allHistory[historyKey] : [];
  const timeframe = normTf(candidate.timeframe) || candles.at(-1)?.timeframe || scannerState.analysisTimeframe || scannerState.timeframe || 'M1';
  const expiration = normExp(candidate.expiration) || scannerState.targetExpiration || scannerState.expiration || null;
  const secondsRemaining = num(candidate.secondsRemaining ?? payload.secondsRemaining);

  const snapshot = {
    platformId: 'casatrade',
    platformName: 'CasaTrade',
    connection: 'online',
    asset: focusedAsset,
    price: Number(candidate.price),
    timeframe,
    analysisTimeframe: timeframe,
    expiration,
    targetExpiration: expiration,
    secondsRemaining,
    serverTime: num(candidate.timestamp) || null,
    candles,
    capabilities: {
      structuredQuotes: true,
      candles: candles.length >= 3,
      expiration: !!expiration,
      multiAsset: false
    }
  };

  const base = {
    ...scannerState,
    ...snapshot,
    targetTabId: sender.tab.id,
    scanner: 'scanning',
    lastSeen: Date.now(),
    platformControls: {
      ...(scannerState.platformControls || {}),
      observed: {
        ...(scannerState.platformControls?.observed || {}),
        timeframe,
        expiration,
        detected: { timeframe: !!timeframe, expiration: !!expiration },
        at: Date.now()
      }
    },
    diagnostics: {
      ...(scannerState.diagnostics || {}),
      focusedAsset: {
        asset: focusedAsset,
        at: Date.now(),
        stableSince: Number(scannerState.diagnostics?.focusedAsset?.stableSince || scannerState.diagnostics?.focusedAsset?.at || Date.now()),
        source: 'chart-header'
      },
      embeddedFeed: {
        frameHost,
        transport: candidate.transport || payload.primaryTransport || null,
        candidateCount: normalizedCandidates(payload).length,
        filteredTo: focusedAsset,
        candleCount: candles.length,
        at: Date.now()
      }
    }
  };

  const processed = processSnapshot(snapshot, base);
  await chrome.storage.local.set({ scannerState: { ...base, ...processed, license: scannerState.license } });
}

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type === 'ATS_FOCUSED_ASSET') {
    setTimeout(() => setFocusedAsset(message.asset, sender).catch(() => {}), 0);
  }
  if (message?.type === 'ATS_NETWORK_DIAGNOSTIC') {
    setTimeout(() => keepRealFeedContext(message.payload || {}, sender).catch(() => {}), 30);
  }
  if (message?.type === 'ATS_EMBEDDED_FEED') {
    setTimeout(() => applyEmbeddedFeed(message.payload || {}, sender).catch(() => {}), 0);
  }
});
