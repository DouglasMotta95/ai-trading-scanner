import { readScannerState } from './services/scanner-state-atomic.js';
import { storageLocalGet, storageLocalSet } from './services/chrome-compat.js';
import { createManualTrade, mergeManualTrade, resolveManualTrades, resolveManualTradesFromFeed, manualTradeMetrics } from './core/manual-trades.js';

const KEY = 'atsManualTradeLedgerV1';
let cached = { rows: [], metrics: manualTradeMetrics([]), updatedAt: 0 };
let loaded = false;
let busy = false;
let queuedState = null;

const host = value => String(value || '').toLowerCase().replace(/\.$/, '');
const casaHost = value => value === 'casatrade.com' || value.endsWith('.casatrade.com') || value === 'casatrade.io' || value.endsWith('.casatrade.io');
const traderHost = value => value === 'casatraders.online' || value.endsWith('.casatraders.online') || value === 'ivcasatraders.online' || value.endsWith('.ivcasatraders.online');

function senderTrusted(sender = {}) {
  let frameHost = '', topHost = '';
  try { frameHost = host(new URL(sender.url || '').hostname); } catch {}
  try { topHost = host(new URL(sender.tab?.url || '').hostname); } catch {}
  return !!sender.tab?.id && (casaHost(topHost) || traderHost(topHost)) && (casaHost(frameHost) || traderHost(frameHost));
}

async function ensureLoaded() {
  if (loaded) return cached;
  const stored = await storageLocalGet(KEY).catch(() => ({}));
  const value = stored?.[KEY];
  if (value && typeof value === 'object') {
    cached = {
      rows: Array.isArray(value.rows) ? value.rows.slice(-500) : [],
      metrics: value.metrics || manualTradeMetrics(value.rows || []),
      updatedAt: Number(value.updatedAt || 0)
    };
  }
  loaded = true;
  return cached;
}

async function persist(rows = []) {
  cached = { rows: rows.slice(-500), metrics: manualTradeMetrics(rows), updatedAt: Date.now() };
  await storageLocalSet({ [KEY]: cached });
  return cached;
}

async function registerClick(message = {}, sender = {}) {
  if (!senderTrusted(sender)) return { ok: false, error: 'untrusted_sender' };
  const state = await readScannerState();
  if (Number(state.targetTabId || 0) && Number(state.targetTabId) !== Number(sender.tab?.id)) return { ok: false, error: 'wrong_tab' };
  const previous = await ensureLoaded();
  const trade = createManualTrade(state, {
    direction: message.direction,
    clickedAt: message.clickedAt,
    label: message.label,
    frameHost: (() => { try { return new URL(sender.url || '').hostname; } catch { return ''; } })()
  }, Date.now(), crypto.randomUUID());
  if (!trade) return { ok: false, error: 'market_not_ready' };
  const rows = mergeManualTrade(previous.rows, trade, 500);
  await persist(rows);
  return { ok: true, trade, metrics: cached.metrics };
}

async function resolveAgainstState(state = {}) {
  const previous = await ensureLoaded();
  const result = resolveManualTrades(previous.rows, state, Date.now());
  if (!result.resolved.length) return;
  await persist(result.rows);
}

async function resolveAgainstFeed(payload = {}) {
  const previous = await ensureLoaded();
  if (!(previous.rows || []).some(row => row?.status === 'PENDING')) return;
  const result = resolveManualTradesFromFeed(previous.rows, payload, Date.now());
  if (!result.resolved.length) return;
  await persist(result.rows);
}

async function drain() {
  if (busy) return;
  busy = true;
  try {
    while (queuedState) {
      const state = queuedState;
      queuedState = null;
      await resolveAgainstState(state).catch(() => {});
    }
  } finally { busy = false; }
}

chrome.storage.onChanged.addListener(changes => {
  if (changes[KEY]?.newValue) {
    const value = changes[KEY].newValue;
    if (value && typeof value === 'object') {
      cached = { rows: Array.isArray(value.rows) ? value.rows.slice(-500) : [], metrics: value.metrics || manualTradeMetrics(value.rows || []), updatedAt: Number(value.updatedAt || 0) };
      loaded = true;
    }
  }
  if (!changes.scannerState) return;
  queuedState = changes.scannerState.newValue || {};
  queueMicrotask(() => drain().catch(() => {}));
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'ATS_MANUAL_TRADE_CLICK') {
    registerClick(message, sender).then(sendResponse).catch(error => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }
  if (message?.type === 'ATS_EMBEDDED_FEED' && senderTrusted(sender)) {
    resolveAgainstFeed(message.payload || {}).catch(() => {});
    return false;
  }
  if (message?.type === 'ATS_GET_MANUAL_TRADE_LEDGER') {
    ensureLoaded().then(data => sendResponse({ ok: true, rows: data.rows.slice(-100), metrics: data.metrics })).catch(error => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }
  return false;
});
