import { isCasaTradeHost } from './platforms/registry.js';
import { updateScannerState } from './services/scanner-state-atomic.js';
import { applyFocus as reportMarketFocus, applyFeed as reportMarketFeed } from './background-market-session.js';
import { storageLocalGet } from './services/chrome-compat.js';

const allowedTransports = new Set(['ws', 'fetch', 'xhr', 'rendered', 'worker', 'sharedworker', 'broadcast', 'serviceworker', 'window']);
const quotes = new Set(['USDT','USDC','USD','EUR','GBP','JPY','AUD','CAD','CHF','NZD','BRL','BTC','ETH']);
const focusedAssets = new Map();
let lastRun = 0;
const num = v => v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null;
const clean = v => String(v ?? '').trim();
const FOCUS_STABLE_MS = 2000;
const FOCUS_CHANGE_MIN_SCORE = 70;
const CLOCK_FRESH_MS = 2200;
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

const assetIdentity = value => normAsset(value).replace(/\s*\(OTC\)\s*$/, '');
const sameAsset = (a, b) => {
  const left = assetIdentity(a);
  const right = assetIdentity(b);
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

const strongCandidate = candidate => !!candidate && (
  candidate.selected === true
  || Number(candidate.confidence || 0) >= 82
  || Number(candidate.seenCount || 0) >= 2
);

function chooseCandidate(payload = {}, preferredAsset = '') {
  const focus = normAsset(preferredAsset);
  let rows = normalizedCandidates(payload);
  if (focus) rows = rows.filter(row => sameAsset(row.asset, focus));
  rows.sort((a, b) =>
    Number(b?.selected === true) - Number(a?.selected === true)
    || Number(b?.confidence || 0) - Number(a?.confidence || 0)
    || Number(b?.seenCount || 0) - Number(a?.seenCount || 0)
    || Number(b?.observedAt || 0) - Number(a?.observedAt || 0)
  );
  const candidate = rows[0] || null;
  return focus || strongCandidate(candidate) ? candidate : null;
}

function focusedAssetFor(tabId, scannerState = {}) {
  const now = Date.now();
  const storedMeta = scannerState?.diagnostics?.focusedAsset || null;
  const stored = storedMeta
    && storedMeta.reliable === true
    && storedMeta.chartScoped === true
    && storedMeta.embeddedTrader === true
    && now - Number(storedMeta.at || 0) < 5000
      ? normAsset(storedMeta.asset)
      : '';
  if (stored) return stored;
  const memory = focusedAssets.get(tabId) || null;
  return memory && now - Number(memory.at || 0) < 2500 ? normAsset(memory.asset) : '';
}

function historyForState(scannerState = {}, asset = '') {
  const wanted = normAsset(asset);
  if (!wanted) return [];
  const sources = [scannerState.marketHistory, scannerState.diagnostics?.network?.recentCandles];
  for (const source of sources) {
    if (!source || typeof source !== 'object') continue;
    const key = Object.keys(source).find(k => sameAsset(k, wanted));
    const rows = key ? sanitizeRows(source[key]) : [];
    if (rows.length) return rows;
  }
  return [];
}

function mergeHistory(a = [], b = []) {
  const byTime = new Map();
  for (const row of [...sanitizeRows(a), ...sanitizeRows(b)]) {
    byTime.set(`${row.time}|${row.timeframe || ''}`, row);
  }
  return [...byTime.values()].sort((x, y) => x.time - y.time).slice(-240);
}

function authoritativeClock(scannerState = {}, asset = '', sender = {}) {
  const focus = scannerState.diagnostics?.focusedAsset || null;
  const clock = scannerState.diagnostics?.marketClock || null;
  if (!focus || !clock) return null;
  if (focus.reliable !== true || focus.chartScoped !== true || focus.embeddedTrader !== true) return null;
  if (!sameAsset(focus.asset, asset) || !sameAsset(clock.asset, asset)) return null;
  if (clock.verified !== true || clean(clock.role) !== 'candle-close' || clean(clock.source) !== 'trader-dom-countdown') return null;
  if (Date.now() - Number(clock.at || 0) > CLOCK_FRESH_MS) return null;
  if (Number(focus.frameId) !== Number(sender.frameId) || Number(clock.frameId) !== Number(sender.frameId)) return null;
  let frameHost = '';
  try { frameHost = new URL(sender?.url || '').hostname.toLowerCase(); } catch {}
  if (!frameHost || clean(focus.frameHost).toLowerCase() !== frameHost || clean(clock.frameHost).toLowerCase() !== frameHost) return null;
  if (num(clock.secondsRemaining) == null) return null;
  return clock;
}

async function keepRealFeedContext(payload = {}, sender = {}) {
  if (Date.now() - lastRun < 80) return;
  lastRun = Date.now();
  const { settings = {} } = await storageLocalGet('settings');
  if (settings.runtimePaused) return;

  return updateScannerState(scannerState => {
    if (!licenseActive(scannerState)) return;
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

    return {
      ...scannerState,
      diagnostics: {
        ...(scannerState.diagnostics || {}),
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
    };
  });
}

async function setFocusedAsset(message = {}, sender = {}) {
  const focused = normAsset(message.asset);
  if (!focused || !sender?.tab?.id) return;

  let senderHost = '';
  let topHost = '';
  try { senderHost = new URL(sender.url || '').hostname; } catch {}
  try { topHost = new URL(sender.tab.url || '').hostname; } catch {}
  const topLevelCasaTrade = sender.frameId === 0 && isCasaTradeHost(senderHost || topHost);
  const trustedEmbeddedVisual = sender.frameId !== 0 && trustedEmbeddedHost(senderHost) && isCasaTradeHost(topHost);
  if (!topLevelCasaTrade && !trustedEmbeddedVisual) return;

  const tabId = sender.tab.id;
  const previousFocus = focusedAssets.get(tabId) || null;
  const score = Number(message.score || 0);
  const samples = Number(message.samples || 0);
  const source = clean(message.source || 'chart-header');
  const explicit = message.explicit === true || source === 'user-selection';
  const visual = message.visual === true || source === 'chart-header' || source === 'user-selection' || source === 'single-frame-asset';
  const reliable = message.reliable === true || explicit || source === 'single-frame-asset' || score >= FOCUS_CHANGE_MIN_SCORE || samples >= 2;
  const incomingUserSelection = source === 'user-selection';
  const previousUserSelection = previousFocus?.source === 'user-selection';
  const previousProtected = previousUserSelection || previousFocus?.explicit === true;
  if (previousFocus?.asset && !sameAsset(previousFocus.asset, focused)) {
    if (previousUserSelection && !incomingUserSelection) return;
    if (!reliable || (previousProtected && !explicit)) return;
  }

  focusedAssets.set(tabId, { asset: focused, score, samples, reliable, visual, source, explicit, frameId: sender.frameId, at: Date.now() });

  // Legacy observer only reports what it saw. background-market-session.js is
  // the sole owner allowed to reset/publish focusedAsset or market fields.
  return reportMarketFocus({
    ...message,
    type: 'ATS_VISUAL_FOCUS_V2',
    asset: focused,
    score,
    samples,
    source,
    explicit,
    visual,
    reliable,
    chartScoped: true,
    frameRole: trustedEmbeddedVisual ? 'trader-frame' : 'casa-chart-frame'
  }, sender);
}

async function applyEmbeddedFeed(payload = {}, sender = {}) {
  let frameHost = '';
  let topHost = '';
  try { frameHost = new URL(sender?.url || '').hostname.toLowerCase(); } catch {}
  try { topHost = new URL(sender?.tab?.url || '').hostname.toLowerCase(); } catch {}
  if (!trustedEmbeddedHost(frameHost) || !isCasaTradeHost(topHost) || !sender?.tab?.id) return;

  await keepRealFeedContext(payload, sender).catch(() => {});
  const { settings = {} } = await storageLocalGet('settings');
  if (settings.runtimePaused) return;

  // Feed validation, epoch checks and publication of asset/price/candles live
  // exclusively in background-market-session.js.
  return reportMarketFeed(payload, sender);
}

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type === 'ATS_FOCUSED_ASSET') {
    setTimeout(() => setFocusedAsset(message, sender).catch(() => {}), 0);
  }
  if (message?.type === 'ATS_NETWORK_DIAGNOSTIC') {
    setTimeout(() => keepRealFeedContext(message.payload || {}, sender).catch(() => {}), 30);
  }
  if (message?.type === 'ATS_EMBEDDED_FEED') {
    setTimeout(() => applyEmbeddedFeed(message.payload || {}, sender).catch(() => {}), 0);
  }
});
