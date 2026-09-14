import { processSnapshot, resetOrchestrator } from './core/orchestrator.js';
import { updateScannerState } from './services/scanner-state-atomic.js';

const clean = value => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
const num = value => value == null || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null;
const casaHost = value => value === 'casatrade.com' || value.endsWith('.casatrade.com') || value === 'casatrade.io' || value.endsWith('.casatrade.io');
const traderHost = value => value === 'casatraders.online' || value.endsWith('.casatraders.online') || value === 'ivcasatraders.online' || value.endsWith('.ivcasatraders.online');
const licenseActive = state => ['active', 'valid'].includes(String(state?.license?.status || '').toLowerCase());

function normAsset(value = '') {
  const raw = clean(value).toUpperCase();
  if (!raw || raw.length > 100) return '';
  const otc = /(?:\(|\b|[_-])OTC(?:\)|\b)?/i.test(raw);
  const direct = raw.match(/\b([A-Z0-9]{2,20})\s*[\/_-]\s*([A-Z0-9]{2,12})/i);
  if (direct) return `${direct[1]}/${direct[2]}${otc ? ' (OTC)' : ''}`;
  const compact = raw.match(/\b([A-Z]{3})([A-Z]{3})\b/);
  return compact ? `${compact[1]}/${compact[2]}${otc ? ' (OTC)' : ''}` : '';
}

const identity = value => normAsset(value).replace(/\s*\(OTC\)\s*$/i, '');
const sameAsset = (a, b) => !!identity(a) && identity(a) === identity(b);

function trustedSender(sender = {}) {
  let frameHost = '', topHost = '';
  try { frameHost = new URL(sender.url || '').hostname.toLowerCase(); } catch {}
  try { topHost = new URL(sender.tab?.url || '').hostname.toLowerCase(); } catch {}
  return !!sender.tab?.id && (casaHost(frameHost) || (traderHost(frameHost) && casaHost(topHost)));
}

function resetForFocus(state, asset, meta) {
  resetOrchestrator();
  return {
    ...state,
    connection: 'connecting',
    asset,
    price: null,
    candles: [],
    currentCandle: null,
    signal: null,
    lastConfirmed: null,
    tradeIntent: null,
    lastSeen: null,
    timeframe: null,
    analysisTimeframe: null,
    expiration: null,
    targetExpiration: null,
    platformControls: null,
    diagnostics: {
      ...(state.diagnostics || {}),
      focusedAsset: meta,
      acquisition: {
        stage: 'reading_price',
        reason: `Ativo ${asset} confirmado na tela. Sincronizando cotação real do mesmo ativo.`,
        assetSource: 'visual-integrity-v2',
        priceSource: null,
        candleCount: 0,
        requiredCandles: 2,
        at: Date.now()
      },
      integrity: { state: 'asset_switched', expectedAsset: asset, at: Date.now() }
    }
  };
}

async function applyVisualFocus(message = {}, sender = {}) {
  if (!trustedSender(sender)) return { ok: true, ignored: true };
  const asset = normAsset(message.asset);
  if (!asset) return { ok: true, ignored: true };
  return updateScannerState(state => {
    if (!licenseActive(state)) return;
    if (state.targetTabId && state.targetTabId !== sender.tab.id) return;
    const previous = state.diagnostics?.focusedAsset || null;
    const sameFocus = sameAsset(previous?.asset, asset);
    const stableSince = sameFocus ? Number(previous?.stableSince || previous?.at || Date.now()) : Date.now();
    const meta = {
      asset,
      at: Date.now(),
      stableSince,
      changedAt: sameFocus ? Number(previous?.changedAt || stableSince) : Date.now(),
      score: Number(message.score || 0),
      samples: Number(message.samples || 0),
      reliable: message.reliable !== false,
      visual: true,
      explicit: message.explicit === true,
      source: clean(message.source || 'visual-v2'),
      frameId: sender.frameId
    };
    const mismatch = !!state.asset && !sameAsset(state.asset, asset);
    if (!sameFocus || mismatch) return resetForFocus({ ...state, targetTabId: sender.tab.id }, asset, meta);
    return {
      ...state,
      targetTabId: sender.tab.id,
      diagnostics: {
        ...(state.diagnostics || {}),
        focusedAsset: meta,
        integrity: { state: sameAsset(state.asset, asset) ? 'matched' : 'awaiting_market', expectedAsset: asset, at: Date.now() }
      }
    };
  });
}

async function applyClock(message = {}, sender = {}) {
  if (!trustedSender(sender)) return { ok: true, ignored: true };
  const asset = normAsset(message.asset);
  const secondsRemaining = num(message.secondsRemaining);
  if (!asset || secondsRemaining == null || secondsRemaining < 0) return { ok: true, ignored: true };

  return updateScannerState(state => {
    if (!licenseActive(state)) return;
    if (state.targetTabId && state.targetTabId !== sender.tab.id) return;
    const focus = normAsset(state.diagnostics?.focusedAsset?.asset || '');
    if (!focus || !sameAsset(focus, asset)) return;
    if (state.asset && !sameAsset(state.asset, focus)) return resetForFocus(state, focus, state.diagnostics?.focusedAsset || { asset: focus, at: Date.now(), stableSince: Date.now(), reliable: true, visual: true, source: 'integrity-repair' });

    const timeframe = clean(message.timeframe || state.analysisTimeframe || state.timeframe || 'M1').toUpperCase();
    const expiration = clean(message.expiration || state.targetExpiration || state.expiration || '') || null;
    const marketClock = {
      secondsRemaining,
      timeframe,
      expiration,
      source: clean(message.clockSource || 'clock-v2'),
      confidence: Number(message.confidence || 0),
      frameHost: clean(message.frameHost || ''),
      at: Date.now()
    };
    const freshPrice = num(state.price) != null && state.lastSeen && Date.now() - Number(state.lastSeen) < 8000;
    if (!freshPrice || state.connection !== 'online') {
      return {
        ...state,
        ...(state.connection === 'online' && !freshPrice ? { connection: 'connecting', signal: null } : {}),
        analysisTimeframe: timeframe,
        targetExpiration: expiration,
        diagnostics: { ...(state.diagnostics || {}), marketClock, integrity: { state: 'awaiting_fresh_price', expectedAsset: focus, at: Date.now() } }
      };
    }

    const snapshot = {
      ...state,
      asset: focus,
      price: Number(state.price),
      timeframe,
      analysisTimeframe: timeframe,
      expiration,
      targetExpiration: expiration,
      secondsRemaining,
      serverTime: Date.now(),
      candles: Array.isArray(state.candles) ? state.candles : []
    };
    const processed = processSnapshot(snapshot, state);
    return {
      ...state,
      ...processed,
      analysisTimeframe: timeframe,
      targetExpiration: expiration,
      diagnostics: { ...(state.diagnostics || {}), marketClock, integrity: { state: 'matched', expectedAsset: focus, at: Date.now() } }
    };
  });
}

async function injectIntegrityReaders(tabId) {
  if (!tabId || !chrome.scripting?.executeScript) return;
  const files = [
    'src/content/focused-asset-v2.js',
    'src/content/market-clock-sync.js',
    'src/content/analysis-visual-overlay-v2.js'
  ];
  for (const file of files) {
    try { await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: [file], world: 'ISOLATED' }); } catch {}
  }
}

function maybeInject(tab) {
  if (!tab?.id || !tab.url) return;
  let h = '';
  try { h = new URL(tab.url).hostname.toLowerCase(); } catch {}
  if (casaHost(h)) injectIntegrityReaders(tab.id);
}

chrome.tabs?.onActivated?.addListener(async info => {
  try { const tab = await chrome.tabs.get(info.tabId); maybeInject(tab); } catch {}
});
chrome.tabs?.onUpdated?.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' || changeInfo.url) maybeInject({ ...tab, id: tabId });
});
try {
  chrome.tabs?.query?.({ active: true, currentWindow: true }, tabs => {
    void chrome.runtime?.lastError;
    maybeInject(tabs?.[0]);
  });
} catch {}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'ATS_VISUAL_FOCUS_V2') {
    applyVisualFocus(message, sender).then(state => sendResponse({ ok: true, state })).catch(error => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }
  if (message?.type === 'ATS_MARKET_CLOCK_V2') {
    applyClock(message, sender).then(state => sendResponse({ ok: true, state })).catch(error => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }
});
