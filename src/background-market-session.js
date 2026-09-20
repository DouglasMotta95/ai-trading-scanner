import { updateScannerState } from './services/scanner-state-atomic.js';
import { shouldResetForFocusedAsset, validateMarketBundle } from './core/market-session-guard.js';
import { MARKET_SWITCH_TIMING, isWithinSwitchGuard, protocolTakeoverAllowed, realSelectionAgeMs, resyncSchedule, shouldRefreshVisualSelectionLock } from './core/market-switch-timing.js';

const clean = value => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
const num = value => value == null || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null;
const traderHost = value => value === 'casatraders.online' || value.endsWith('.casatraders.online') || value === 'ivcasatraders.online' || value.endsWith('.ivcasatraders.online');
const casaHost = value => value === 'casatrade.com' || value.endsWith('.casatrade.com') || value === 'casatrade.io' || value.endsWith('.casatrade.io');
const licenseActive = state => {
  const status = String(state?.license?.status || '').toLowerCase();
  return ['active', 'valid'].includes(status)
    || state?.license?.devMode === true
    || state?.license?.plan === 'OWNER_DEV'
    || state?.diagnostics?.access?.ownerDev === true
    || state?.diagnostics?.access?.state === 'owner_dev';
};
const CLOCK_FRESH_MS = 3000;
const FOCUS_FRESH_MS = 5000;
const EXACT_CLOCK_SOURCES = new Set(['trader-dom-countdown', 'network-server-cycle']);

let lastResyncEpoch = -1;

function forceMarketEpochResync(tabId, epoch, asset = '') {
  const id = Number(tabId);
  const sessionEpoch = Number(epoch);
  if (!Number.isInteger(id) || id <= 0 || !Number.isFinite(sessionEpoch) || sessionEpoch <= 0) return;
  if (lastResyncEpoch === sessionEpoch) return;
  lastResyncEpoch = sessionEpoch;

  for (const delay of resyncSchedule()) {
    setTimeout(() => {
      try {
        chrome.tabs?.sendMessage?.(id, {
          type: 'ATS_FORCE_MARKET_RESYNC',
          epoch: sessionEpoch,
          asset
        }, () => void chrome.runtime?.lastError);
      } catch {}
      globalThis.__ATS_SCHEDULE_CENTRAL_ANALYSIS__?.(true);
    }, delay);
  }
}

function normAsset(value = '') {
  const raw = clean(value).toUpperCase();
  if (!raw || raw.length > 100) return '';
  const otc = /(?:\(|\b|[_-])OTC(?:\)|\b)?/i.test(raw);
  const stripped = raw.replace(/\(\s*OTC\s*\)|\bOTC\b/g, ' ').trim();
  const direct = stripped.match(/\b([A-Z0-9]{2,20})\s*[\/_-]\s*([A-Z0-9]{2,12})/i);
  if (direct) return `${direct[1]}/${direct[2]}${otc ? ' (OTC)' : ''}`;
  const compact = stripped.replace(/[^A-Z0-9]/g, '');
  for (const quote of ['USDT','USD','EUR','GBP','JPY','CAD','AUD','CHF','NZD','BTC','ETH']) {
    if (!compact.endsWith(quote) || compact.length <= quote.length + 1) continue;
    const base = compact.slice(0, -quote.length);
    if (/^[A-Z0-9]{2,12}$/.test(base)) return `${base}/${quote}${otc ? ' (OTC)' : ''}`;
  }

  // CasaTrade also exposes named OTC instruments (for example VAULTA or
  // CARDANO) without a visible quote currency. Accept them only when OTC is
  // explicit and reject ambiguous currency/UI words, preserving the strict
  // protocol protection against labels such as EURO.
  const ambiguous = new Set([
    'EURO','DOLLAR','DÓLAR','USD','EUR','GBP','JPY','AUD','CAD','CHF','NZD','BRL',
    'BUY','SELL','COMPRA','VENDA','BLITZ','DIGITAL','INFO','OTC'
  ]);
  if (otc && /^[A-Z0-9][A-Z0-9 ._-]{2,30}$/.test(stripped) && !ambiguous.has(stripped)) {
    return `${stripped} (OTC)`;
  }
  return '';
}
const marketId = value => normAsset(value);
const sameMarket = (a, b) => !!marketId(a) && marketId(a) === marketId(b);

function normTf(value) {
  const s = clean(value).toUpperCase().replace(/\s+/g, '');
  let m = s.match(/^S(\d{1,5})$/); if (m && Number(m[1]) > 0) return `S${Number(m[1])}`;
  m = s.match(/^M(\d{1,4})$/); if (m && Number(m[1]) > 0) return `M${Number(m[1])}`;
  m = s.match(/^H(\d{1,3})$/); if (m && Number(m[1]) > 0) return `H${Number(m[1])}`;
  m = s.match(/^(\d{1,5})S$/); if (m && Number(m[1]) > 0) return `S${Number(m[1])}`;
  m = s.match(/^(\d{1,4})M$/); if (m && Number(m[1]) > 0) return `M${Number(m[1])}`;
  return null;
}

function timeframeSeconds(value) {
  const timeframe = normTf(value);
  if (!timeframe) return null;
  if (timeframe[0] === 'S') return Number(timeframe.slice(1));
  if (timeframe[0] === 'M') return Number(timeframe.slice(1)) * 60;
  if (timeframe[0] === 'H') return Number(timeframe.slice(1)) * 3600;
  return null;
}

function senderMeta(sender = {}) {
  let frameHost = '', topHost = '';
  try { frameHost = new URL(sender.url || '').hostname.toLowerCase(); } catch {}
  try { topHost = new URL(sender.tab?.url || '').hostname.toLowerCase(); } catch {}
  const tabOwned = !!sender.tab?.id && (casaHost(topHost) || traderHost(topHost));
  const embeddedTrader = tabOwned && traderHost(frameHost);
  const casaOwnedChart = tabOwned && casaHost(frameHost);
  return {
    trusted: embeddedTrader || casaOwnedChart,
    embeddedTrader,
    casaOwnedChart,
    frameHost, topHost, frameId: sender.frameId, tabId: sender.tab?.id || null
  };
}

function normalizeTime(value) {
  let t = num(value);
  if (t != null && t > 0 && t < 1e12) t *= 1000;
  return Number.isFinite(t) && t > 0 ? t : null;
}

function sanitizeRows(rows = []) {
  if (!Array.isArray(rows)) return [];
  const byKey = new Map();
  for (const raw of rows.slice(-300)) {
    const time = normalizeTime(raw?.time ?? raw?.timestamp);
    const open = num(raw?.open), high = num(raw?.high), low = num(raw?.low), close = num(raw?.close);
    if (time == null || ![open, high, low, close].every(Number.isFinite)) continue;
    const timeframe = normTf(raw?.timeframe);
    byKey.set(`${time}|${timeframe || ''}`, { time, open, high, low, close, timeframe });
  }
  return [...byKey.values()].sort((a, b) => a.time - b.time).slice(-240);
}

function mergeRows(a = [], b = []) {
  return sanitizeRows([...sanitizeRows(a), ...sanitizeRows(b)]);
}

function candidates(payload = {}) {
  return (Array.isArray(payload.candidates) ? payload.candidates : []).map(row => {
    const asset = normAsset(row?.asset);
    const bid = num(row?.bid), ask = num(row?.ask);
    const price = num(row?.price) ?? (bid != null && ask != null ? (bid + ask) / 2 : null);
    return { ...row, asset, price, bid, ask };
  }).filter(row => row.asset && row.price != null && row.price > 0);
}

function bestForFocus(payload = {}, focus = '') {
  const rows = candidates(payload).filter(row => sameMarket(row.asset, focus));
  rows.sort((a, b) => Number(b.selected === true) - Number(a.selected === true)
    || Number(b.confidence || 0) - Number(a.confidence || 0)
    || Number(b.observedAt || 0) - Number(a.observedAt || 0));
  return rows[0] || null;
}

function historyFor(payload = {}, focus = '') {
  const source = payload.recentCandles || {};
  const key = Object.keys(source).find(asset => sameMarket(asset, focus));
  return key ? sanitizeRows(source[key]) : [];
}

function stateHistory(state = {}, asset = '') {
  const source = state.marketHistory || {};
  const key = Object.keys(source).find(value => sameMarket(value, asset));
  const fromHistory = key ? sanitizeRows(source[key]) : [];
  return fromHistory.length ? fromHistory : sanitizeRows(state.candles || []);
}

function clockMatchesFocus(state = {}, info = null) {
  const focus = state.diagnostics?.focusedAsset || null;
  const clock = state.diagnostics?.marketClock || null;
  if (!focus || !clock || !focus.asset) return null;
  if (focus.reliable !== true || focus.chartScoped !== true || focus.trustedChartFrame !== true) return null;
  if (Date.now() - Number(focus.at || 0) > FOCUS_FRESH_MS) return null;
  if (clean(clock.role) !== 'candle-close' || clock.available === false) return null;
  if (Date.now() - Number(clock.at || 0) > CLOCK_FRESH_MS) return null;
  if (!sameMarket(clock.asset, focus.asset)) return null;
  // Frame id is a transport detail. On Android/tablet the focused chart,
  // structured feed and candle clock can live in sibling frames on the same
  // trusted CasaTrade host. Market identity is asset + host + timeframe, not
  // physical frame id.
  if (info && state.targetTabId && Number(info.tabId) !== Number(state.targetTabId)) return null;
  const remaining = num(clock.secondsRemaining);
  const duration = timeframeSeconds(clock.timeframe || state.analysisTimeframe || state.timeframe);
  if (remaining == null || remaining < 0 || (duration && remaining > duration + 2)) return null;
  return clock;
}

function exactClock(state = {}, info = null) {
  const clock = clockMatchesFocus(state, info);
  if (!clock || clock.verified !== true || !EXACT_CLOCK_SOURCES.has(clean(clock.source))) return null;
  return clock;
}

function usableClock(state = {}, info = null) {
  return exactClock(state, info);
}

function nextEpoch(previous = {}) {
  return Math.max(0, Number(previous?.epoch || 0)) + 1;
}

export function marketSessionEpoch(state = {}) {
  return Math.max(0, Number(state?.diagnostics?.marketSession?.epoch || 0));
}

export function withMarketSessionEpoch(state = {}, expectedEpoch, writer) {
  const expected = Number(expectedEpoch);
  if (!Number.isFinite(expected) || marketSessionEpoch(state) !== expected) return state;
  return typeof writer === 'function' ? writer(state) : state;
}

export function clearMarketAuthorityState(state = {}, extra = {}) {
  const previous = state.diagnostics?.marketSession || {};
  const epoch = nextEpoch(previous);
  const now = Date.now();
  const requestedDiagnostics = extra?.diagnostics && typeof extra.diagnostics === 'object'
    ? { ...extra.diagnostics }
    : { ...(state.diagnostics || {}) };
  delete requestedDiagnostics.focusedAsset;
  delete requestedDiagnostics.marketClock;
  requestedDiagnostics.marketSession = {
    epoch,
    asset: null,
    pendingAsset: null,
    confirmedAsset: null,
    dataReady: false,
    transitioning: false,
    timeframe: null,
    frameId: null,
    frameHost: null,
    source: clean(extra.marketSessionSource || 'control-clear'),
    startedAt: now,
    dataMode: 'idle'
  };

  const safeExtra = { ...extra };
  delete safeExtra.asset;
  delete safeExtra.price;
  delete safeExtra.candles;
  delete safeExtra.marketHistory;
  delete safeExtra.currentCandle;
  delete safeExtra.diagnostics;
  delete safeExtra.marketSessionSource;

  return {
    ...state,
    ...safeExtra,
    asset: null,
    price: null,
    timeframe: null,
    analysisTimeframe: null,
    expiration: null,
    targetExpiration: null,
    serverTime: null,
    candles: [],
    currentCandle: null,
    marketHistory: {},
    signal: null,
    professionalDecision: null,
    aiAudit: null,
    tradeIntent: null,
    entryAdvice: null,
    lastConfirmed: null,
    lastSeen: null,
    platformControls: null,
    diagnostics: requestedDiagnostics
  };
}

export function resetForSession(state = {}, { asset, timeframe = null, info, reason, source }) {
  const previous = state.diagnostics?.marketSession || {};
  const epoch = nextEpoch(previous);
  const now = Date.now();
  const fromAsset = normAsset(state.asset || previous.confirmedAsset || previous.asset || state.diagnostics?.focusedAsset?.asset || '');
  const toAsset = normAsset(asset);
  const switched = !!fromAsset && !!toAsset && !sameMarket(fromAsset, toAsset);
  const switchLog = [
    ...(Array.isArray(state.diagnostics?.assetSwitchLog) ? state.diagnostics.assetSwitchLog : []),
    ...(switched ? [{
      at: now,
      from: fromAsset,
      to: toAsset,
      epoch,
      cleanupOk: true,
      source: source || 'visible-chart'
    }] : [])
  ].slice(-12);

  return {
    ...state,
    connection: 'connecting',
    // Do not publish the new asset as live until price + real candle history for
    // that exact instrument have passed the identity/scale guard below.
    asset: null,
    price: null,
    timeframe,
    analysisTimeframe: timeframe,
    expiration: null,
    targetExpiration: null,
    serverTime: null,
    candles: [],
    currentCandle: null,
    marketHistory: {},
    signal: null,
    professionalDecision: null,
    aiAudit: null,
    lastConfirmed: null,
    tradeIntent: null,
    entryAdvice: null,
    lastSeen: null,
    platformControls: state.platformControls || null,
    diagnostics: {
      ...(state.diagnostics || {}),
      marketClock: null,
      assetSwitchLog: switchLog,
      marketSession: {
        epoch,
        asset: toAsset,
        pendingAsset: toAsset,
        confirmedAsset: null,
        dataReady: false,
        transitioning: true,
        timeframe,
        frameId: info?.frameId ?? null,
        frameHost: info?.frameHost || null,
        source: source || 'visible-chart',
        startedAt: now,
        dataMode: 'syncing'
      },
      acquisition: { stage: 'syncing_session', reason, at: now }
    }
  };
}
function clockRecord(message = {}, info = {}, asset = '', timeframe = null, secondsRemaining = null) {
  const verified = message.verified === true;
  const at = Date.now();
  const closeAt = secondsRemaining == null ? null : Math.round((at + Number(secondsRemaining) * 1000) / 1000) * 1000;
  return {
    asset, timeframe, secondsRemaining, closeAt, available: true, verified,
    operational: verified || message.operational === true,
    quality: verified ? 'exact' : 'fallback', role: 'candle-close',
    source: clean(message.clockSource), mode: clean(message.clockMode || (verified ? 'exact' : 'fallback')),
    confidence: Number(message.confidence || 0),
    text: clean(message.clockText || ''), token: clean(message.clockToken || ''),
    frameId: info.frameId, frameHost: info.frameHost, at
  };
}

export async function applyFocus(message = {}, sender = {}) {
  const info = senderMeta(sender);
  const role = clean(message.frameRole || '');
  if (!info.trusted || message.chartScoped !== true || message.reliable !== true || !['trader-frame', 'casa-chart-frame'].includes(role)) return null;
  const asset = normAsset(message.asset);
  if (!asset) return null;
  const nextState = await updateScannerState(state => {
    if (!licenseActive(state)) return;
    if (state.targetTabId && state.targetTabId !== info.tabId) return;

    const now = Date.now();
    const old = state.diagnostics?.focusedAsset || null;
    const incomingEmbeddedTrader = traderHost(info.frameHost);
    const incomingCasaFrame = casaHost(info.frameHost);
    const assetChanged = !!old?.asset && !sameMarket(old.asset, asset);
    const confirmedAssetChanged = shouldResetForFocusedAsset(state, asset);
    const frameChanged = !!old && (Number(old.frameId) !== Number(info.frameId) || clean(old.frameHost).toLowerCase() !== info.frameHost);
    const interactionAt = Number(message.interactionAt || message.at || 0);
    const userSelected = message.interactionHint === true && interactionAt > 0 && now - interactionAt < 8000;
    const chartHeaderAuthoritative = clean(message.source) === 'visible-chart-header'
      && message.visual !== false
      && message.explicit === true
      && message.chartScoped === true;
    const authoritativeVisual = userSelected || chartHeaderAuthoritative;
    const oldFresh = Number(old?.at || 0) > 0 && isWithinSwitchGuard(now - Number(old.at), MARKET_SWITCH_TIMING.staleFocusProtectionMs);
    const oldEmbeddedTrader = old?.embeddedTrader === true;
    const incomingExplicit = message.explicit === true;
    const incomingStable = Number(message.stableFor || 0) >= 220 || Number(message.samples || 0) >= 3;
    const session = state.diagnostics?.marketSession || {};
    const incomingProtocolOnly = message.visual === false || clean(message.source) === 'protocol-selected';
    const freshVisualFocus = oldFresh
      && old?.visual !== false
      && old?.reliable === true
      && old?.chartScoped === true
      && old?.trustedChartFrame === true;
    const transitionProtectsCurrentFocus = session.transitioning === true
      && !!old?.asset
      && sameMarket(session.pendingAsset || session.asset, old.asset);
    const recentVisualSelection = old?.visual !== false
      && old?.interactionHint === true
      && Number(old?.interactionAt || old?.at || 0) > 0
      && isWithinSwitchGuard(now - Number(old.interactionAt || old.at), MARKET_SWITCH_TIMING.recentSelectionProtectionMs);
    const selectionLock = state.diagnostics?.visualSelectionLock || null;
    // Once the user explicitly selects a market, passive readers may confirm
    // that same market but may not replace it. The lock changes only on the
    // next explicit user selection; a timeout allowed stale hidden rows to
    // resurrect EURO/old assets several seconds later.
    const selectionLockActive = !!selectionLock?.asset && Number(selectionLock.at || 0) > 0;
    const contradictsSelectionLock = selectionLockActive
      && !sameMarket(asset, selectionLock.asset);
    const protocolContradictsSelectionLock = incomingProtocolOnly && contradictsSelectionLock;
    const recentSelectionAgeMs = realSelectionAgeMs({ now, focus: old, selectionLock });
    // Passive visual/chart-header heartbeats are not a user lock. If they keep
    // repainting stale text after a real CasaTrade switch, a stable explicit
    // protocol selection must be able to take over instead of waiting forever
    // for old.at to become stale (it is refreshed every ~600ms).
    const oldFocusAgeMs = recentSelectionAgeMs;
    const protocolCanTakeOver = incomingProtocolOnly && protocolTakeoverAllowed({
      oldFocusAgeMs,
      recentSelectionAgeMs,
      incomingExplicit,
      incomingStable
    });

    // The visible chart is the long-lived market authority. Network/protocol
    // selection is only a bootstrap fallback; it may confirm the same market
    // but may never replace a fresh reliable visual focus with another asset.
    // This also neutralizes stale content scripts that survived an unpacked
    // extension reload and still announce an older/ambiguous market.
    if (assetChanged && incomingProtocolOnly && freshVisualFocus && !protocolCanTakeOver) {
      return {
        ...state,
        diagnostics: {
          ...(state.diagnostics || {}),
          focusRejected: {
            asset, frameId: info.frameId, frameHost: info.frameHost,
            reason: 'protocol-conflicts-fresh-visual-focus',
            at: now
          }
        }
      };
    }

    // During a visible market switch, stale protocol/network state from the
    // previous instrument can continue to announce itself as selected for a
    // few seconds. Never let that non-visual source roll the current visible
    // transition back to the old market. This is the guard against mixing
    // USO/USD price/history into a newly selected AUD/CAD session.
    if (assetChanged && !authoritativeVisual && contradictsSelectionLock && !protocolCanTakeOver) {
      return {
        ...state,
        diagnostics: {
          ...(state.diagnostics || {}),
          focusRejected: {
            asset, frameId: info.frameId, frameHost: info.frameHost,
            reason: incomingProtocolOnly
              ? 'protocol-rollback-visual-selection-lock'
              : 'stale-visual-rollback-selection-lock',
            at: now
          }
        }
      };
    }

    if (assetChanged && incomingProtocolOnly && !protocolCanTakeOver && (transitionProtectsCurrentFocus || recentVisualSelection || protocolContradictsSelectionLock)) {
      return {
        ...state,
        diagnostics: {
          ...(state.diagnostics || {}),
          focusRejected: {
            asset, frameId: info.frameId, frameHost: info.frameHost,
            reason: transitionProtectsCurrentFocus
              ? 'protocol-rollback-during-visible-transition'
              : protocolContradictsSelectionLock
                ? 'protocol-rollback-visual-selection-lock'
                : 'protocol-rollback-after-user-selection',
            at: now
          }
        }
      };
    }

    // A passive symbol change from the same frame must prove stability before it
    // can replace a fresh selected market. User interaction/explicit selection wins immediately.
    if (assetChanged && oldFresh && !authoritativeVisual && !incomingExplicit && !incomingStable) {
      return {
        ...state,
        diagnostics: {
          ...(state.diagnostics || {}),
          focusRejected: {
            asset, frameId: info.frameId, frameHost: info.frameHost,
            reason: 'passive-asset-change-not-stable', at: now
          }
        }
      };
    }

    // Hidden/inactive CasaTrade market frames can stay alive and keep publishing
    // their old symbol. They must never roll the visible user-selected chart back.
    if (assetChanged && frameChanged && oldFresh && !authoritativeVisual && !incomingExplicit && !incomingStable) {
      return {
        ...state,
        diagnostics: {
          ...(state.diagnostics || {}),
          focusRejected: {
            asset, frameId: info.frameId, frameHost: info.frameHost,
            reason: 'cross-frame-stale-asset', at: now
          }
        }
      };
    }

    // The same asset is often visible in the CasaTrade shell and the embedded
    // trader frame at the same time. Once the embedded trader owns the live clock,
    // shell heartbeats must not keep resetting the market session.
    if (!assetChanged && frameChanged && oldEmbeddedTrader && incomingCasaFrame && !authoritativeVisual) {
      return state;
    }

    // Prefer the embedded trader as the long-lived authority for the same asset.
    // IMPORTANT: a shell -> trader frame handoff is NOT a market switch. It must
    // never call resetForSession(), because doing so clears the current candle
    // candidate and can flip POSSÍVEL VENDA -> POSSÍVEL COMPRA within seconds.
    const traderHandoff = !assetChanged && frameChanged && !oldEmbeddedTrader && incomingEmbeddedTrader;
    let next = state;

    // Only a REAL asset change may reset market/session analysis state.
    if (confirmedAssetChanged) {
      next = resetForSession(state, {
        asset, info, source: clean(message.source || (authoritativeVisual ? 'user-selected-transition' : 'visible-chart')),
        reason: authoritativeVisual
          ? `Ativo ${asset} selecionado na CasaTrade. Limpando a sessão anterior e sincronizando dados do novo ativo.`
          : `Ativo ${asset} confirmado no gráfico. Sincronizando a sessão ao vivo.`
      });
    } else if (traderHandoff) {
      const previousSession = state.diagnostics?.marketSession || {};
      next = {
        ...state,
        diagnostics: {
          ...(state.diagnostics || {}),
          // Keep the same epoch and all analysis/signal state. Only move the
          // frame ownership to the embedded trader.
          marketClock: null,
          marketSession: {
            ...previousSession,
            asset: normAsset(previousSession.asset || asset) || asset,
            confirmedAsset: normAsset(previousSession.confirmedAsset || state.asset || asset) || asset,
            frameId: info.frameId,
            frameHost: info.frameHost,
            source: 'same-market-trader-handoff'
          },
          acquisition: {
            ...(state.diagnostics?.acquisition || {}),
            stage: 'syncing_clock_owner',
            reason: `Mesmo ativo ${asset}; transferindo apenas a autoridade do frame sem reiniciar o sinal.`,
            at: now
          }
        }
      };
    }

    const previousStableSince = sameMarket(old?.asset, asset)
      ? Number(old?.stableSince || old?.at || now)
      : now;
    return {
      ...next,
      targetTabId: info.tabId,
      platformId: 'casatrade', platformName: 'CasaTrade', scanner: 'scanning',
      diagnostics: {
        ...(next.diagnostics || {}),
        visualSelectionLock: shouldRefreshVisualSelectionLock({
          userSelected,
          source: clean(message.source)
        })
          ? { asset, at: interactionAt || now, source: 'user-selection' }
          : protocolCanTakeOver
            ? { asset, at: now, source: 'protocol-selected-fallback' }
            : (next.diagnostics?.visualSelectionLock || null),
        focusedAsset: {
          asset, at: now, stableSince: assetChanged ? now : previousStableSince,
          score: Number(message.score || 0), samples: Number(message.samples || 0), reliable: true,
          visual: message.visual !== false, explicit: message.explicit === true, chartScoped: true,
          interactionHint: userSelected,
          interactionAt: userSelected ? interactionAt : null,
          trustedChartFrame: true, embeddedTrader: incomingEmbeddedTrader, casaTradeFrame: incomingCasaFrame,
          frameRole: incomingEmbeddedTrader ? 'trader-frame' : 'casa-chart-frame', frameId: info.frameId, frameHost: info.frameHost,
          source: clean(message.source || 'visible-chart')
        }
      }
    };
  });
  const session = nextState?.diagnostics?.marketSession || {};
  if (session.transitioning === true
      && sameMarket(session.pendingAsset || session.asset, asset)
      && Number(session.epoch || 0) > 0) {
    forceMarketEpochResync(info.tabId, session.epoch, asset);
  }
  return nextState;
}

export async function applyClock(message = {}, sender = {}) {
  const info = senderMeta(sender);
  if (!info.trusted) return null;
  const asset = normAsset(message.asset);
  const timeframe = normTf(message.timeframe);
  const secondsRemaining = num(message.secondsRemaining);
  const duration = timeframeSeconds(timeframe);
  const source = clean(message.clockSource);
  const exact = message.verified === true && message.available !== false && clean(message.clockRole) === 'candle-close'
    && EXACT_CLOCK_SOURCES.has(source);
  const validRemaining = secondsRemaining != null && secondsRemaining >= 0 && (!duration || secondsRemaining <= duration + 2);

  return updateScannerState(state => {
    if (!licenseActive(state)) return;
    const focus = state.diagnostics?.focusedAsset || null;
    if (!focus?.asset || !sameMarket(focus.asset, asset) || clean(focus.frameHost).toLowerCase() !== info.frameHost) return;
    if (state.targetTabId && Number(state.targetTabId) !== Number(info.tabId)) return;

    if (!exact || !validRemaining) {
      // Do not let a transient "pending" sample erase an exact CasaTrade clock
      // that is still fresh for this same focused frame. The next exact sample
      // can refresh it; only a genuinely stale clock is allowed to become pending.
      if (exactClock(state, info)) return state;
      return {
        ...state,
        diagnostics: {
          ...(state.diagnostics || {}),
          marketClock: {
            asset, timeframe, available: false, verified: false, operational: false, role: 'candle-close',
            source: clean(message.clockSource || 'unverified'), mode: clean(message.clockMode || ''),
            frameId: info.frameId, frameHost: info.frameHost, at: Date.now()
          },
          acquisition: { ...(state.diagnostics?.acquisition || {}), stage: 'syncing_clock', reason: 'Sincronizando o relógio da vela com a CasaTrade.', at: Date.now() }
        }
      };
    }

    const session = state.diagnostics?.marketSession || {};
    const sessionChanged = !sameMarket(session.asset, asset)
      || clean(session.timeframe).toUpperCase() !== clean(timeframe).toUpperCase();
    let next = state;
    if (sessionChanged) {
      next = resetForSession(state, {
        asset, timeframe, info, source: 'exact-candle-clock',
        reason: `Sessão ${asset} • ${timeframe || '—'} sincronizada ao fechamento real da vela.`
      });
    }

    const record = clockRecord(message, info, asset, timeframe, secondsRemaining);
    let clockState = {
      ...next,
      connection: next.price != null ? 'online' : 'connecting',
      timeframe: timeframe || next.timeframe,
      analysisTimeframe: timeframe || next.analysisTimeframe,
      expiration: message.expiration || next.expiration || null,
      targetExpiration: message.expiration || next.targetExpiration || null,
      diagnostics: {
        ...(next.diagnostics || {}),
        marketClock: record,
        marketSession: {
          ...(next.diagnostics?.marketSession || {}), asset, timeframe,
          // Preserve the market/session owner frame. The clock may legitimately
          // arrive from a sibling frame on the same trusted host.
          frameId: next.diagnostics?.marketSession?.frameId ?? focus.frameId ?? info.frameId,
          frameHost: next.diagnostics?.marketSession?.frameHost || focus.frameHost || info.frameHost,
          dataMode: next.price != null ? 'live' : 'syncing'
        },
        acquisition: {
          ...(next.diagnostics?.acquisition || {}),
          stage: next.price != null ? 'diagnosing_next_candle' : 'syncing_price',
          reason: 'Relógio exato da vela sincronizado com a CasaTrade.',
          clockQuality: 'exact', at: Date.now()
        }
      }
    };

    return clockState;
  });
}

export async function applyFeed(payload = {}, sender = {}) {
  const info = senderMeta(sender);
  if (!info.trusted) return null;
  const nextState = await updateScannerState(state => {
    if (!licenseActive(state)) return;
    if (state.targetTabId && state.targetTabId !== info.tabId) return;
    const focus = state.diagnostics?.focusedAsset || null;
    if (!focus?.asset) return;
    if (state.targetTabId && Number(state.targetTabId) !== Number(info.tabId)) return;
    const asset = normAsset(focus.asset);
    const candidate = bestForFocus(payload, asset);
    if (!candidate) return;

    const incomingHistory = historyFor(payload, asset);
    const previousHistory = stateHistory(state, asset);
    const mergedHistory = mergeRows(previousHistory, incomingHistory);
    const bundle = validateMarketBundle({
      focusAsset: asset,
      candidateAsset: candidate.asset,
      price: candidate.price,
      candles: mergedHistory,
      requireCandles: true
    });
    if (!bundle.ok) {
      return {
        ...state,
        diagnostics: {
          ...(state.diagnostics || {}),
          rejectedMarketData: {
            asset,
            candidateAsset: candidate.asset || null,
            reason: bundle.reason,
            at: Date.now()
          }
        }
      };
    }
    const acceptedHistory = sanitizeRows(bundle.candles);
    const marketHistory = { [asset]: acceptedHistory };
    const clock = usableClock(state, info);
    const timeframe = normTf(clock?.timeframe || state.analysisTimeframe || candidate.timeframe) || null;
    const price = Number(bundle.price);
    // candidate.timestamp is often the candle OPEN timestamp and can remain static
    // for the full minute. Runtime observation time must advance for stability logic.
    const serverTime = Date.now();
    const historicalJump = incomingHistory.length > 1 && acceptedHistory.length - previousHistory.length > 1;
    const next = {
      ...state,
      asset,
      price,
      timeframe,
      analysisTimeframe: timeframe,
      serverTime,
      candles: acceptedHistory,
      marketHistory,
      lastSeen: Date.now(),
      connection: 'online',
      capabilities: {
        ...(state.capabilities || {}),
        structuredQuotes: true,
        candles: acceptedHistory.length >= 2
      }
    };
    const diagnostics = { ...(state.diagnostics || {}), ...(next.diagnostics || {}) };
    delete diagnostics.connectionError;
    return {
      ...next,
      targetTabId: info.tabId,
      platformId: 'casatrade', platformName: 'CasaTrade', scanner: 'scanning',
      asset, price, timeframe: timeframe || next.timeframe, analysisTimeframe: timeframe || next.analysisTimeframe,
      serverTime, marketHistory, candles: acceptedHistory, lastSeen: Date.now(), connection: 'online',
      diagnostics: {
        ...diagnostics,
        focusedAsset: focus,
        marketClock: state.diagnostics?.marketClock || null,
        marketSession: {
          ...(state.diagnostics?.marketSession || {}), asset, pendingAsset: null, confirmedAsset: asset,
          dataReady: true, transitioning: false, timeframe,
          frameId: info.frameId, frameHost: info.frameHost,
          dataMode: historicalJump ? 'backfill' : 'live',
          lastLiveAt: Date.now(), historyCount: acceptedHistory.length
        },
        acquisition: {
          stage: clock ? 'diagnosing_next_candle' : 'syncing_clock',
          reason: clock
            ? clock.verified === true
              ? `Sessão ao vivo ${asset} • ${timeframe || '—'} sincronizada.`
              : `Sessão ao vivo ${asset} • ${timeframe || '—'} usando clock temporário estimado até a CasaTrade expor o fechamento exato.`
            : 'Preço e histórico prontos. Sincronizando o relógio da vela.',
          clockQuality: clock?.verified === true ? 'exact' : clock ? 'fallback' : 'missing',
          priceSource: candidate.transport || payload.primaryTransport || 'market', candleCount: acceptedHistory.length, requiredCandles: 2,
          feedQuality: Number(payload.feedQuality || 0), at: Date.now()
        },
        inspector: state.diagnostics?.inspector || null
      }
    };
  });
  if (nextState?.diagnostics?.marketSession?.dataReady === true) {
    globalThis.__ATS_SCHEDULE_CENTRAL_ANALYSIS__?.(true);
  }
  return nextState;
}

function observedCurrentCandle(state = {}, price, clock = null) {
  const timeframe = normTf(clock?.timeframe || state.analysisTimeframe || state.timeframe);
  const duration = timeframeSeconds(timeframe);
  if (!timeframe || !duration || num(price) == null) return state.currentCandle || null;
  const remaining = num(clock?.secondsRemaining);
  const anchorAt = num(clock?.at);
  const closeAt = num(clock?.closeAt) ?? (remaining != null && anchorAt != null ? anchorAt + remaining * 1000 : null);
  if (closeAt == null) return state.currentCandle || null;
  const cycleKey = `${normAsset(state.asset)}|${timeframe}|${Math.round(closeAt / 5000) * 5000}`;
  const previous = state.currentCandle;
  const same = previous?.source === 'live-price-observed' && previous?.cycleKey === cycleKey;
  const open = same ? num(previous.open) : Number(price);
  const high = same ? Math.max(num(previous.high) ?? Number(price), Number(price)) : Number(price);
  const low = same ? Math.min(num(previous.low) ?? Number(price), Number(price)) : Number(price);
  return { cycleKey, timeframe, open, high, low, close: Number(price), source: 'live-price-observed', partial: true, openReliable: false, rangeReliable: false, at: Date.now() };
}

export async function applyChartPrice(message = {}, sender = {}) {
  const info = senderMeta(sender);
  if (!info.trusted) return null;
  const price = num(message.price);
  if (price == null || price <= 0) return null;
  return updateScannerState(state => {
    if (!licenseActive(state)) return;
    const focus = state.diagnostics?.focusedAsset || null;
    if (!focus?.asset) return;
    if (state.targetTabId && Number(state.targetTabId) !== Number(info.tabId)) return;
    // Untagged quotes are unsafe during an asset switch: an old frame event can
    // otherwise repopulate the new session with the previous instrument's price.
    if (!message.asset || !sameMarket(message.asset, focus.asset)) return;
    const session = state.diagnostics?.marketSession || {};
    if (session.dataReady !== true || !sameMarket(session.confirmedAsset, focus.asset) || !sameMarket(state.asset, focus.asset)) return;
    const bundle = validateMarketBundle({
      focusAsset: focus.asset,
      candidateAsset: message.asset,
      price,
      candles: state.candles || [],
      requireCandles: true
    });
    if (!bundle.ok) return;
    const clock = usableClock(state, info);
    let next = {
      ...state,
      asset: normAsset(focus.asset), price: Number(bundle.price),
      currentCandle: observedCurrentCandle({ ...state, asset: normAsset(focus.asset) }, Number(bundle.price), clock),
      lastSeen: Date.now(), connection: 'online',
      diagnostics: {
        ...(state.diagnostics || {}),
        marketSession: { ...(state.diagnostics?.marketSession || {}), dataMode: 'live', lastLiveAt: Date.now() },
        acquisition: {
          ...(state.diagnostics?.acquisition || {}),
          stage: clock ? 'diagnosing_next_candle' : 'syncing_clock',
          reason: clock
            ? clock.verified === true ? 'Cotação e relógio da vela sincronizados.' : 'Cotação ao vivo; clock temporário estimado em uso.'
            : 'Cotação do gráfico pronta. Sincronizando o relógio da vela.',
          clockQuality: clock?.verified === true ? 'exact' : clock ? 'fallback' : 'missing',
          priceSource: clean(message.priceSource || 'visible-chart'), at: Date.now()
        }
      }
    };
    return next;
  });
}

async function applyInspector(message = {}, sender = {}) {
  const info = senderMeta(sender);
  if (!info.trusted) return null;
  const snapshot = message.snapshot && typeof message.snapshot === 'object' ? message.snapshot : {};
  return updateScannerState(state => {
    if (!licenseActive(state)) return;
    const focus = state.diagnostics?.focusedAsset || null;
    if (focus?.frameId != null && Number(focus.frameId) !== Number(info.frameId)) return;
    return {
      ...state,
      diagnostics: {
        ...(state.diagnostics || {}),
        inspector: {
          frameId: info.frameId, frameHost: info.frameHost, at: Date.now(),
          transports: snapshot.transports || {}, endpoints: Array.isArray(snapshot.endpoints) ? snapshot.endpoints.slice(-12) : [],
          keys: Array.isArray(snapshot.keys) ? snapshot.keys.slice(0, 80) : [],
          focusedCandidate: snapshot.focusedCandidate || null,
          candleCount: Number(snapshot.candleCount || 0),
          rawCandidateCount: Number(snapshot.rawCandidateCount || 0)
        }
      }
    };
  });
}

export async function repairMarketSessionIntegrity(observedState = {}) {
  const expectedEpoch = marketSessionEpoch(observedState);
  return updateScannerState(current => {
    if (marketSessionEpoch(current) !== expectedEpoch) return current;
    const focus = current.diagnostics?.focusedAsset || null;
    const session = current.diagnostics?.marketSession || null;
    if (!focus?.asset || !session?.asset) return current;
    const mismatch = (current.asset && !sameMarket(current.asset, session.asset))
      || (current.analysisTimeframe && session.timeframe && normTf(current.analysisTimeframe) !== normTf(session.timeframe));
    if (!mismatch) return current;
    return resetForSession(current, {
      asset: normAsset(focus.asset),
      timeframe: normTf(session.timeframe),
      info: { frameId: focus.frameId, frameHost: clean(focus.frameHost).toLowerCase() },
      source: 'session-integrity',
      reason: 'Dado atrasado de outra sessão foi bloqueado pelo owner do marketSession.'
    });
  });
}

let repairing = false;
chrome.storage.onChanged.addListener(changes => {
  if (!changes.scannerState || repairing) return;
  const state = changes.scannerState.newValue || {};
  if (!licenseActive(state)) return;
  const focus = state.diagnostics?.focusedAsset || null;
  const session = state.diagnostics?.marketSession || null;
  if (!focus?.asset || !session?.asset) return;
  const mismatch = (state.asset && !sameMarket(state.asset, session.asset))
    || (state.analysisTimeframe && session.timeframe && normTf(state.analysisTimeframe) !== normTf(session.timeframe));
  if (!mismatch) return;
  repairing = true;
  updateScannerState(current => resetForSession(current, {
    asset: normAsset(focus.asset), timeframe: normTf(session.timeframe),
    info: { frameId: focus.frameId, frameHost: clean(focus.frameHost).toLowerCase() },
    source: 'session-integrity', reason: 'Dado atrasado de outra sessão foi bloqueado.'
  })).finally(() => { repairing = false; });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  let task = null;
  if (message?.type === 'ATS_VISUAL_FOCUS_V2') task = applyFocus(message, sender);
  else if (message?.type === 'ATS_MARKET_CLOCK_V2') task = applyClock(message, sender);
  else if (message?.type === 'ATS_EMBEDDED_FEED') task = applyFeed(message.payload || {}, sender);
  else if (message?.type === 'ATS_CHART_FRAME_MARKET') task = applyChartPrice(message, sender);
  else if (message?.type === 'ATS_DATA_INSPECTOR') task = applyInspector(message, sender);
  if (!task) return false;
  Promise.resolve(task).then(state => sendResponse({ ok: true, state })).catch(error => sendResponse({ ok: false, error: String(error?.message || error) }));
  return true;
});
