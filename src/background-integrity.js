import { processSnapshot, resetOrchestrator } from './core/orchestrator.js';
import { updateScannerState } from './services/scanner-state-atomic.js';

const clean = value => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
const num = value => value == null || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null;
const casaHost = value => value === 'casatrade.com' || value.endsWith('.casatrade.com') || value === 'casatrade.io' || value.endsWith('.casatrade.io');
const traderHost = value => value === 'casatraders.online' || value.endsWith('.casatraders.online') || value === 'ivcasatraders.online' || value.endsWith('.ivcasatraders.online');
const licenseActive = state => ['active', 'valid'].includes(String(state?.license?.status || '').toLowerCase());
const FOCUS_FRESH_MS = 2600;
const CLOCK_FRESH_MS = 2200;
let integrityRepairing = false;

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

function senderMeta(sender = {}) {
  let frameHost = '', topHost = '';
  try { frameHost = new URL(sender.url || '').hostname.toLowerCase(); } catch {}
  try { topHost = new URL(sender.tab?.url || '').hostname.toLowerCase(); } catch {}
  const embeddedTrader = sender.frameId !== 0 && traderHost(frameHost) && casaHost(topHost);
  return { trusted: !!sender.tab?.id && embeddedTrader, embeddedTrader, frameHost, topHost, frameId: sender.frameId };
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
      marketClock: null,
      acquisition: {
        stage: 'reading_price',
        reason: `Ativo ${asset} confirmado no gráfico. Aguardando cotação, velas e relógio reais do mesmo gráfico.`,
        assetSource: 'chart-authority-v4',
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
  const info = senderMeta(sender);
  if (!info.trusted || message.chartScoped !== true || message.frameRole !== 'trader-frame') return { ok: true, ignored: true };
  const asset = normAsset(message.asset);
  if (!asset || message.reliable === false) return { ok: true, ignored: true };

  return updateScannerState(state => {
    if (!licenseActive(state)) return;
    if (state.targetTabId && state.targetTabId !== sender.tab.id) return;
    const now = Date.now();
    const previous = state.diagnostics?.focusedAsset || null;
    const previousFresh = previous?.asset && now - Number(previous.at || 0) < FOCUS_FRESH_MS;
    const sameFrame = Number(previous?.frameId) === Number(sender.frameId) && clean(previous?.frameHost) === info.frameHost;
    const sameFocus = sameAsset(previous?.asset, asset);

    if (previousFresh && !sameFrame && !sameFocus && message.explicit !== true) {
      return {
        ...state,
        diagnostics: {
          ...(state.diagnostics || {}),
          integrity: { state: 'foreign_chart_focus_ignored', expectedAsset: previous.asset, ignoredAsset: asset, at: now }
        }
      };
    }

    const stableSince = sameFocus && sameFrame ? Number(previous?.stableSince || previous?.at || now) : now;
    const meta = {
      asset,
      at: now,
      stableSince,
      changedAt: sameFocus && sameFrame ? Number(previous?.changedAt || stableSince) : now,
      score: Number(message.score || 0),
      samples: Number(message.samples || 0),
      reliable: true,
      visual: true,
      explicit: message.explicit === true,
      chartScoped: true,
      chartFound: message.chartFound === true,
      source: clean(message.source || 'chart-frame-scoped'),
      frameId: sender.frameId,
      frameHost: info.frameHost,
      embeddedTrader: true,
      authority: 'visible-chart-frame'
    };

    const mismatch = !!state.asset && !sameAsset(state.asset, asset);
    if (!sameFocus || !sameFrame || mismatch) return resetForFocus({ ...state, targetTabId: sender.tab.id }, asset, meta);
    return {
      ...state,
      targetTabId: sender.tab.id,
      diagnostics: {
        ...(state.diagnostics || {}),
        focusedAsset: meta,
        integrity: { state: sameAsset(state.asset, asset) ? 'matched' : 'awaiting_market', expectedAsset: asset, at: now }
      }
    };
  });
}

async function applyClock(message = {}, sender = {}) {
  const info = senderMeta(sender);
  if (!info.trusted) return { ok: true, ignored: true };
  const asset = normAsset(message.asset);
  if (!asset) return { ok: true, ignored: true };

  return updateScannerState(state => {
    if (!licenseActive(state)) return;
    if (state.targetTabId && state.targetTabId !== sender.tab.id) return;
    const focusMeta = state.diagnostics?.focusedAsset || null;
    const focus = normAsset(focusMeta?.asset || '');
    const authoritativeFrame = Number(focusMeta?.frameId) === Number(sender.frameId)
      && clean(focusMeta?.frameHost).toLowerCase() === info.frameHost
      && focusMeta?.embeddedTrader === true;
    if (!focus || !sameAsset(focus, asset) || !authoritativeFrame) return;

    const timeframe = clean(message.timeframe || state.analysisTimeframe || state.timeframe || 'M1').toUpperCase();
    const expiration = clean(message.expiration || '') || null;
    const exact = message.available === true
      && message.verified === true
      && clean(message.clockRole) === 'candle-close'
      && clean(message.clockSource) === 'trader-dom-countdown'
      && num(message.secondsRemaining) != null
      && num(message.secondsRemaining) >= 0;

    if (!exact) {
      return {
        ...state,
        signal: null,
        analysisTimeframe: timeframe,
        targetExpiration: expiration,
        diagnostics: {
          ...(state.diagnostics || {}),
          marketClock: {
            asset: focus,
            secondsRemaining: null,
            timeframe,
            expiration,
            verified: false,
            role: 'candle-close',
            source: clean(message.clockSource || 'trader-dom-unavailable'),
            frameId: sender.frameId,
            frameHost: info.frameHost,
            at: Date.now()
          },
          acquisition: {
            ...(state.diagnostics?.acquisition || {}),
            stage: 'syncing_clock',
            reason: 'Ativo e cotação encontrados. Sincronizando o fechamento da vela visível no gráfico.',
            at: Date.now()
          },
          integrity: { state: 'awaiting_exact_clock', expectedAsset: focus, at: Date.now() }
        }
      };
    }

    const secondsRemaining = Number(message.secondsRemaining);
    const marketClock = {
      asset: focus,
      secondsRemaining,
      timeframe,
      expiration,
      verified: true,
      role: 'candle-close',
      source: 'trader-dom-countdown',
      text: clean(message.clockText || ''),
      token: clean(message.clockToken || ''),
      confidence: Number(message.confidence || 0),
      frameId: sender.frameId,
      frameHost: info.frameHost,
      at: Date.now()
    };

    if (state.asset && !sameAsset(state.asset, focus)) return resetForFocus(state, focus, focusMeta);
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
      clockVerified: true,
      serverTime: Date.now(),
      candles: Array.isArray(state.candles) ? state.candles : []
    };
    const processed = processSnapshot(snapshot, state);
    return {
      ...state,
      ...processed,
      analysisTimeframe: timeframe,
      targetExpiration: expiration,
      diagnostics: {
        ...(state.diagnostics || {}),
        marketClock,
        acquisition: {
          ...(state.diagnostics?.acquisition || {}),
          stage: processed?.signal?.state === 'SEARCHING' ? 'reading_history' : 'diagnosing_next_candle',
          reason: processed?.signal?.reason || 'Relógio da vela sincronizado. Diagnosticando a próxima vela.',
          candleCount: Number(processed?.signal?.candleCount ?? state.candles?.length ?? 0),
          requiredCandles: 2,
          at: Date.now()
        },
        integrity: { state: 'matched', expectedAsset: focus, at: Date.now() }
      }
    };
  });
}

function focusValid(state, now = Date.now()) {
  const focus = state?.diagnostics?.focusedAsset || null;
  return !!normAsset(focus?.asset)
    && focus?.reliable === true
    && focus?.chartScoped === true
    && focus?.embeddedTrader === true
    && traderHost(clean(focus?.frameHost).toLowerCase())
    && now - Number(focus?.at || 0) < FOCUS_FRESH_MS;
}

function clockValid(state, now = Date.now()) {
  const focus = state?.diagnostics?.focusedAsset || null;
  const clock = state?.diagnostics?.marketClock || null;
  return focusValid(state, now)
    && clock?.verified === true
    && clean(clock?.role) === 'candle-close'
    && clean(clock?.source) === 'trader-dom-countdown'
    && now - Number(clock?.at || 0) < CLOCK_FRESH_MS
    && sameAsset(clock?.asset, focus?.asset)
    && Number(clock?.frameId) === Number(focus?.frameId)
    && clean(clock?.frameHost).toLowerCase() === clean(focus?.frameHost).toLowerCase()
    && num(clock?.secondsRemaining) != null;
}

function enforceStateIntegrity(nextState = {}) {
  if (!licenseActive(nextState)) return nextState;
  const now = Date.now();
  const validFocus = focusValid(nextState, now);
  const focusAsset = validFocus ? normAsset(nextState.diagnostics?.focusedAsset?.asset) : '';
  const assetMismatch = !!nextState.asset && (!focusAsset || !sameAsset(nextState.asset, focusAsset));
  if (!validFocus || assetMismatch) {
    resetOrchestrator();
    return {
      ...nextState,
      connection: 'connecting',
      asset: focusAsset || null,
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
      diagnostics: {
        ...(nextState.diagnostics || {}),
        integrity: { state: validFocus ? 'asset_mismatch_blocked' : 'awaiting_visible_chart_asset', expectedAsset: focusAsset || null, at: now }
      }
    };
  }

  const validClock = clockValid(nextState, now);
  const signalSeconds = num(nextState.signal?.secondsRemaining);
  const clockSeconds = num(nextState.diagnostics?.marketClock?.secondsRemaining);
  const signalClockMismatch = nextState.signal && (!validClock || signalSeconds == null || clockSeconds == null || signalSeconds !== clockSeconds);
  if (signalClockMismatch) {
    return {
      ...nextState,
      signal: null,
      diagnostics: {
        ...(nextState.diagnostics || {}),
        acquisition: {
          ...(nextState.diagnostics?.acquisition || {}),
          stage: 'syncing_clock',
          reason: 'Sincronizando a decisão com o fechamento real da vela do gráfico.',
          at: now
        },
        integrity: { state: 'signal_blocked_without_exact_clock', expectedAsset: focusAsset, at: now }
      }
    };
  }
  return nextState;
}

chrome.storage.onChanged.addListener(changes => {
  if (!changes.scannerState || integrityRepairing) return;
  const nextState = changes.scannerState.newValue || {};
  const repaired = enforceStateIntegrity(nextState);
  if (repaired === nextState) return;
  const before = JSON.stringify(nextState);
  const after = JSON.stringify(repaired);
  if (before === after) return;
  integrityRepairing = true;
  updateScannerState(() => repaired).finally(() => { integrityRepairing = false; });
});

async function injectIntegrityReaders(tabId) {
  if (!tabId || !chrome.scripting?.executeScript) return;
  const files = ['src/content/focused-asset-v2.js', 'src/content/market-clock-sync.js', 'src/content/analysis-visual-overlay-v2.js'];
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
