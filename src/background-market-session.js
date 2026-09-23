import { updateScannerState } from './services/scanner-state-atomic.js';
import { validateMarketBundle } from './core/market-session-guard.js';

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
const CLOCK_FRESH_MS = 4500;
const FOCUS_FRESH_MS = 5000;
const EXACT_CLOCK_SOURCES = new Set(['trader-dom-countdown', 'network-server-cycle']);
const FALLBACK_CLOCK_SOURCE = 'platform-cycle-derived';
const FALLBACK_MIN_CONFIDENCE = 50;
const COMMON_QUOTES = new Set(['USD','EUR','GBP','JPY','AUD','CAD','CHF','NZD','BRL','HKD','SGD','NOK','SEK','DKK','PLN','CZK','HUF','TRY','MXN','ZAR','INR','CNY','CNH','KRW','THB','MYR','PHP','IDR','VND','TWD','ILS','AED','SAR','QAR','KWD','BHD','OMR','ARS','CLP','COP','PEN','UYU','BOB','PYG','USDT','USDC','BTC','ETH']);
const GENERIC_ASSET_TOKENS = new Set(['BLITZ','OPTION','BINARY','BINARIA','DIGITAL','TURBO','CALL','PUT','TRADE','TRADING','OPERATION','OPERACAO','OPÇÃO','OPCAO']);

function normAsset(value = '') {
  const raw = clean(value).toUpperCase();
  if (!raw || raw.length > 100) return '';
  const otc = /(?:\(|\b|[_-])OTC(?:\)|\b)?/i.test(raw);
  const stripped = raw.replace(/\(\s*OTC\s*\)|\bOTC\b/g, ' ').trim();
  const direct = stripped.match(/\b([A-Z0-9]{2,20})\s*[\/_-]\s*([A-Z0-9]{2,12})/i);
  if (direct) {
    const base = direct[1];
    const quote = direct[2];
    if (!COMMON_QUOTES.has(quote) || GENERIC_ASSET_TOKENS.has(base) || GENERIC_ASSET_TOKENS.has(quote)) return '';
    return `${base}/${quote}${otc ? ' (OTC)' : ''}`;
  }
  const compact = stripped.replace(/[^A-Z0-9]/g, '');
  for (const quote of COMMON_QUOTES) {
    if (!compact.endsWith(quote) || compact.length <= quote.length + 1) continue;
    const base = compact.slice(0, -quote.length);
    if (/^[A-Z0-9]{2,12}$/.test(base) && !GENERIC_ASSET_TOKENS.has(base)) return `${base}/${quote}${otc ? ' (OTC)' : ''}`;
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
    tabOwned,
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

function filterTimeframe(rows = [], timeframe = null) {
  const target = normTf(timeframe);
  if (!target) return sanitizeRows(rows);
  return sanitizeRows(rows).filter(row => {
    const rowTf = normTf(row?.timeframe);
    return !rowTf || rowTf === target;
  });
}

function historyFor(payload = {}, focus = '', timeframe = null) {
  const source = payload.recentCandles || {};
  const key = Object.keys(source).find(asset => sameMarket(asset, focus));
  return key ? filterTimeframe(source[key], timeframe) : [];
}

function stateHistory(state = {}, asset = '', timeframe = null) {
  const source = state.marketHistory || {};
  const key = Object.keys(source).find(value => sameMarket(value, asset));
  const fromHistory = key ? filterTimeframe(source[key], timeframe) : [];
  return fromHistory.length ? fromHistory : filterTimeframe(state.candles || [], timeframe);
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

  const sameFocusFrame = Number(clock.frameId) === Number(focus.frameId)
    && clean(clock.frameHost).toLowerCase() === clean(focus.frameHost).toLowerCase();
  const boundControlFrame = clock.crossFrameControl === true
    && Number(clock.boundFocusFrameId) === Number(focus.frameId)
    && clean(clock.boundFocusFrameHost).toLowerCase() === clean(focus.frameHost).toLowerCase();
  if (!sameFocusFrame && !boundControlFrame) return null;

  // When validating an incoming/previous clock, compare the sender with the
  // clock source frame. A cross-frame control clock is intentionally not sent
  // by the focused market-data frame.
  if (info && (Number(info.frameId) !== Number(clock.frameId)
    || info.frameHost !== clean(clock.frameHost).toLowerCase())) return null;
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
  const clock = clockMatchesFocus(state, info);
  if (!clock) return null;
  if (clock.verified === true && EXACT_CLOCK_SOURCES.has(clean(clock.source))) return clock;
  const fallback = clock.verified !== true
    && clock.operational === true
    && clean(clock.source) === FALLBACK_CLOCK_SOURCE
    && Number(clock.confidence || 0) >= FALLBACK_MIN_CONFIDENCE;
  return fallback ? clock : null;
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

export function clearUserDeclaredExpirationState(state = {}) {
  const controls = state.platformControls || null;
  const guard = state.diagnostics?.expirationGuard || null;
  const declared = clean(controls?.userDeclaredExpiration || '');
  const expirationSource = clean(controls?.expirationSource || controls?.source || '');
  const observedSource = clean(controls?.observed?.source || '');
  const guardSource = clean(guard?.source || '');
  const declaredDerived = expirationSource === 'user-declared'
    || observedSource === 'user-declared'
    || guardSource === 'user-declared';

  if (!declared && !declaredDerived) return state;

  let nextControls = controls;
  if (controls) {
    const observed = controls.observed ? {
      ...controls.observed,
      observedAt: { ...(controls.observed.observedAt || {}) },
      confidence: { ...(controls.observed.confidence || {}) }
    } : null;

    if (observed && declaredDerived) {
      observed.expiration = null;
      observed.observedAt.expiration = 0;
      observed.confidence.expiration = 0;
      if (clean(observed.source) === 'user-declared') observed.source = '';
    }

    nextControls = {
      ...controls,
      userDeclaredExpiration: null,
      userDeclaredAt: 0,
      ...(observed ? { observed } : {}),
      ...(declaredDerived ? {
        expirationCheckedAt: 0,
        expirationSource: null,
        aligned: false,
        expirationVerified: false,
        liveAuthority: false,
        ...(clean(controls.source) === 'user-declared' ? { source: null } : {})
      } : {})
    };
  }

  const diagnostics = { ...(state.diagnostics || {}) };
  if (guardSource === 'user-declared') delete diagnostics.expirationGuard;
  if (clean(diagnostics.platformTime?.source) === 'user-declared') delete diagnostics.platformTime;

  return {
    ...state,
    ...(declaredDerived ? { expiration: null, targetExpiration: null } : {}),
    platformControls: nextControls,
    diagnostics
  };
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
  // The existing market-session epoch is the asset-boundary authority.
  // When that epoch advances because the confirmed market changed, any
  // user-declared expiration belongs to the previous asset and must not cross
  // into the new session.
  const sessionBase = switched ? clearUserDeclaredExpirationState(state) : state;
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

  const platformStillOnline = clean(sessionBase.connection).toLowerCase() === 'online';

  return {
    ...sessionBase,
    // Switching instrument inside the same live CasaTrade tab is a market-data
    // transition, not a transport disconnect. Keep the connection badge online
    // while asset/price/candles are deliberately cleared and resynchronized.
    connection: platformStillOnline ? 'online' : 'connecting',
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
    lastSeen: null,
    platformControls: sessionBase.platformControls || null,
    diagnostics: {
      ...(sessionBase.diagnostics || {}),
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

function clockRecord(message = {}, info = {}, asset = '', timeframe = null, secondsRemaining = null, focus = null) {
  const verified = message.verified === true;
  const at = Date.now();
  const closeAt = secondsRemaining == null ? null : Math.round((at + Number(secondsRemaining) * 1000) / 1000) * 1000;
  const crossFrameControl = message.crossFrameControl === true;
  return {
    asset, timeframe, secondsRemaining, closeAt, available: true, verified,
    operational: verified || message.operational === true,
    quality: verified ? 'exact' : 'fallback', role: 'candle-close',
    source: clean(message.clockSource), mode: clean(message.clockMode || (verified ? 'exact' : 'fallback')),
    confidence: Number(message.confidence || 0),
    text: clean(message.clockText || ''), token: clean(message.clockToken || ''),
    frameId: info.frameId, frameHost: info.frameHost,
    crossFrameControl,
    boundFocusFrameId: crossFrameControl ? Number(focus?.frameId) : null,
    boundFocusFrameHost: crossFrameControl ? clean(focus?.frameHost).toLowerCase() : null,
    at
  };
}

export async function applyNetworkContext(message = {}, sender = {}) {
  const info = senderMeta(sender);
  if (!info.trusted || !info.tabOwned) return null;
  return updateScannerState(state => {
    if (!licenseActive(state)) return state;
    if (state.targetTabId && Number(state.targetTabId) !== Number(info.tabId)) return state;

    const payload = message.payload && typeof message.payload === 'object' ? message.payload : {};
    const contextKey = clean(payload.contextKey || '');
    if (!contextKey) return state;

    const previous = state.diagnostics?.networkContext || {};
    const previousKey = clean(previous.contextKey || '');
    const hasMarketAuthority = !!state.asset
      || !!state.diagnostics?.focusedAsset?.asset
      || !!state.diagnostics?.marketSession?.asset
      || (Array.isArray(state.candles) && state.candles.length > 0)
      || Object.keys(state.marketHistory || {}).length > 0;
    const changed = !!previousKey && previousKey !== contextKey
      || (!previousKey && hasMarketAuthority);

    const networkContext = {
      contextKey,
      transport: clean(payload.transport || ''),
      endpoint: clean(payload.endpoint || '', 240),
      observedAt: num(payload.observedAt) || Date.now(),
      changed,
      at: Date.now(),
      source: clean(payload.source || 'network-probe')
    };

    if (!changed) {
      return {
        ...state,
        diagnostics: {
          ...(state.diagnostics || {}),
          networkContext
        }
      };
    }

    return clearMarketAuthorityState(state, {
      scanner: 'scanning',
      connection: state.connection === 'offline' ? 'connecting' : state.connection,
      targetTabId: info.tabId,
      diagnostics: {
        ...(state.diagnostics || {}),
        networkContext,
        focusRejected: {
          ...(state.diagnostics?.focusRejected || {}),
          reason: 'network-context-changed',
          previousContextKey: previousKey || null,
          contextKey,
          at: Date.now()
        },
        assetIdentity: {
          ...(state.diagnostics?.assetIdentity || {}),
          contextChanged: true,
          contextChangeSource: 'network-probe',
          contextKey,
          previousContextKey: previousKey || null,
          at: Date.now()
        }
      },
      marketSessionSource: 'network-context-change'
    });
  });
}

export async function applyFocus(message = {}, sender = {}) {
  const info = senderMeta(sender);
  const role = clean(message.frameRole || '');
  const asset = normAsset(message.asset);
  const roleTrusted = ['trader-frame', 'casa-chart-frame'].includes(role);
  const trustedChartFrame = info.trusted && roleTrusted;
  const accepted = trustedChartFrame
    && message.chartScoped === true
    && message.reliable === true
    && message.visualAuthority !== false
    && !!asset;

  if (!accepted) {
    if (!info.tabOwned) return null;
    return updateScannerState(state => {
      if (!licenseActive(state)) return state;
      if (state.targetTabId && state.targetTabId !== info.tabId) return state;
      const session = state.diagnostics?.marketSession || {};
      const expectedAsset = normAsset(state.asset || session.pendingAsset || session.confirmedAsset || session.asset || '');
      const sameMarketCheck = asset && expectedAsset ? sameMarket(asset, expectedAsset) : null;
      const reason = !trustedChartFrame
        ? 'trustedChartFrame=false'
        : message.chartScoped !== true
          ? 'chartScoped=false'
          : message.reliable !== true
            ? clean(message.reliableReason || 'reliable=false')
            : message.visualAuthority === false
              ? 'visualAuthority=false'
              : !asset
                ? 'asset=invalid'
                : 'focus-rejected';

      const existingFocus = state.diagnostics?.focusedAsset || null;
      const existingFocusFresh = existingFocus?.reliable === true
        && Number(existingFocus.at || 0) > 0
        && Date.now() - Number(existingFocus.at) < 7000;
      const contextChanged = message.contextChanged === true;

      if (contextChanged) {
        return clearMarketAuthorityState(state, {
          scanner: 'scanning',
          connection: state.connection === 'offline' ? 'connecting' : state.connection,
          targetTabId: info.tabId,
          diagnostics: {
            ...(state.diagnostics || {}),
            focusDiagnostic: {
              asset: asset || null,
              reliable: false,
              reliableReason: reason,
              contextChanged: true,
              frameId: info.frameId,
              frameHost: info.frameHost,
              at: Number(message.at || Date.now())
            },
            assetIdentity: {
              ...(state.diagnostics?.assetIdentity || {}),
              contextChanged: true,
              contextChangeSource: 'visual-focus',
              at: Number(message.at || Date.now())
            }
          },
          marketSessionSource: 'visual-context-change'
        });
      }

      const rejectedFocus = {
        asset: asset || null,
        at: Number(message.at || Date.now()),
        reliable: false,
        reliableReason: reason,
        reliableChecks: {
          ambiguityCount: Number(message.ambiguityCount || 0),
          explicit: message.explicit === true,
          interactionHint: message.interactionHint === true,
          chartScoped: message.chartScoped === true,
          trustedChartFrame,
          visualAuthority: message.visualAuthority !== false,
          embeddedTrader: info.embeddedTrader === true,
          casaTradeFrame: info.casaOwnedChart === true,
          sameMarket: sameMarketCheck,
          at: Number(message.at || Date.now())
        },
        visual: message.visual !== false,
        explicit: message.explicit === true,
        chartScoped: message.chartScoped === true,
        visualAuthority: message.visualAuthority !== false,
        directChart: message.directChart === true,
        ambiguityCount: Number(message.ambiguityCount || 0),
        runnerUpAsset: normAsset(message.runnerUpAsset || '') || null,
        runnerUpGap: num(message.runnerUpGap),
        interactionHint: message.interactionHint === true,
        interactionAt: num(message.interactionAt),
        trustedChartFrame,
        embeddedTrader: info.embeddedTrader === true,
        casaTradeFrame: info.casaOwnedChart === true,
        frameRole: role || null,
        frameId: info.frameId,
        frameHost: info.frameHost,
        source: clean(message.source || 'focus-diagnostic')
      };

      return {
        ...state,
        diagnostics: {
          ...(state.diagnostics || {}),
          // Never let a rejected secondary-frame observation destroy a live
          // trusted focus. The observation remains available for diagnostics.
          ...(existingFocusFresh
            ? {
                focusedAsset: existingFocus,
                focusDiagnostic: rejectedFocus
              }
            : {
                focusedAsset: rejectedFocus
              }),
          focusRejected: {
            ...(state.diagnostics?.focusRejected || {}),
            asset: asset || null,
            frameId: info.frameId,
            frameHost: info.frameHost,
            reason,
            keptExistingReliableFocus: existingFocusFresh,
            at: Number(message.at || Date.now())
          }
        }
      };
    });
  }

  return updateScannerState(state => {
    if (!licenseActive(state)) return;
    if (state.targetTabId && state.targetTabId !== info.tabId) return;

    const now = Date.now();
    const old = state.diagnostics?.focusedAsset || null;
    const incomingEmbeddedTrader = traderHost(info.frameHost);
    const incomingCasaFrame = casaHost(info.frameHost);
    const assetChanged = !!old?.asset && !sameMarket(old.asset, asset);
    const frameChanged = !!old && (Number(old.frameId) !== Number(info.frameId) || clean(old.frameHost).toLowerCase() !== info.frameHost);
    const interactionAt = Number(message.interactionAt || message.at || 0);
    const userSelected = message.interactionHint === true && interactionAt > 0 && now - interactionAt < 3500;
    const oldFresh = Number(old?.at || 0) > 0 && now - Number(old.at) < 2600;
    const oldEmbeddedTrader = old?.embeddedTrader === true;
    const incomingExplicit = message.explicit === true;
    const incomingStable = Number(message.stableFor || 0) >= 220 || Number(message.samples || 0) >= 3;
    const session = state.diagnostics?.marketSession || {};
    const incomingProtocolOnly = message.visual === false || clean(message.source) === 'protocol-selected';
    const transitionProtectsCurrentFocus = session.transitioning === true
      && !!old?.asset
      && sameMarket(session.pendingAsset || session.asset, old.asset);
    const recentVisualSelection = old?.visual !== false
      && old?.interactionHint === true
      && Number(old?.interactionAt || old?.at || 0) > 0
      && now - Number(old.interactionAt || old.at) < 3500;
    const selectionLock = state.diagnostics?.visualSelectionLock || null;
    const selectionLockFresh = !!selectionLock?.asset
      && Number(selectionLock.at || 0) > 0
      && now - Number(selectionLock.at) < 3500;
    const protocolContradictsSelectionLock = incomingProtocolOnly
      && selectionLockFresh
      && !sameMarket(asset, selectionLock.asset);

    // During a visible market switch, stale protocol/network state from the
    // previous instrument can continue to announce itself as selected for a
    // few seconds. Never let that non-visual source roll the current visible
    // transition back to the old market. This is the guard against mixing
    // USO/USD price/history into a newly selected AUD/CAD session.
    if (assetChanged && incomingProtocolOnly && (transitionProtectsCurrentFocus || recentVisualSelection || protocolContradictsSelectionLock)) {
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
    if (assetChanged && oldFresh && !userSelected && !incomingExplicit && !incomingStable) {
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
    if (assetChanged && frameChanged && oldFresh && !userSelected && !incomingExplicit && !incomingStable) {
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
    if (!assetChanged && frameChanged && oldEmbeddedTrader && incomingCasaFrame && !userSelected) {
      return state;
    }

    // Prefer the embedded trader as the long-lived authority for the same asset.
    // This is a one-way handoff (shell -> trader), avoiding frame ping-pong.
    const traderHandoff = !assetChanged && frameChanged && !oldEmbeddedTrader && incomingEmbeddedTrader;
    const changed = assetChanged || traderHandoff || (!old && frameChanged);
    let next = state;
    if (changed || (state.asset && !sameMarket(state.asset, asset))) {
      next = resetForSession(state, {
        asset, info, source: clean(message.source || 'visible-chart'),
        reason: assetChanged
          ? `Ativo ${asset} confirmado no gráfico. Sincronizando a sessão ao vivo.`
          : `Gráfico ${asset} vinculado ao frame de mercado ativo.`
      });
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
        visualSelectionLock: userSelected
          ? { asset, at: interactionAt || now }
          : (next.diagnostics?.visualSelectionLock || null),
        focusedAsset: {
          asset, at: now, stableSince: changed ? now : previousStableSince,
          score: Number(message.score || 0), samples: Number(message.samples || 0), reliable: true,
          visual: message.visual !== false, explicit: message.explicit === true, chartScoped: true,
          visualAuthority: message.visualAuthority !== false,
          directChart: message.directChart === true,
          ambiguityCount: Number(message.ambiguityCount || 0),
          runnerUpAsset: normAsset(message.runnerUpAsset || '') || null,
          runnerUpGap: num(message.runnerUpGap),
          interactionHint: userSelected,
          interactionAt: userSelected ? interactionAt : null,
          trustedChartFrame: true, embeddedTrader: incomingEmbeddedTrader, casaTradeFrame: incomingCasaFrame,
          frameRole: incomingEmbeddedTrader ? 'trader-frame' : 'casa-chart-frame', frameId: info.frameId, frameHost: info.frameHost,
          reliableReason: 'ok',
          reliableChecks: {
            ambiguityCount: Number(message.ambiguityCount || 0),
            explicit: message.explicit === true,
            interactionHint: userSelected,
            chartScoped: true,
            trustedChartFrame: true,
            visualAuthority: message.visualAuthority !== false,
            embeddedTrader: incomingEmbeddedTrader,
            casaTradeFrame: incomingCasaFrame,
            sameMarket: true,
            at: now
          },
          source: clean(message.source || 'visible-chart')
        }
      }
    };
  });
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
  const fallback = message.verified !== true && message.available !== false && message.operational === true
    && clean(message.clockRole) === 'candle-close' && source === FALLBACK_CLOCK_SOURCE
    && Number(message.confidence || 0) >= FALLBACK_MIN_CONFIDENCE;
  const validRemaining = secondsRemaining != null && secondsRemaining >= 0 && (!duration || secondsRemaining <= duration + 2);

  return updateScannerState(state => {
    if (!licenseActive(state)) return;
    const focus = state.diagnostics?.focusedAsset || null;
    if (!focus?.asset || !sameMarket(focus.asset, asset)) return;

    const sameFocusFrame = Number(focus.frameId) === Number(info.frameId)
      && clean(focus.frameHost).toLowerCase() === info.frameHost;
    const crossFrameControl = message.crossFrameControl === true
      && exact
      && info.casaOwnedChart === true
      && Number(info.frameId) === 0
      && Number(message.boundFocusFrameId) === Number(focus.frameId)
      && clean(message.boundFocusFrameHost).toLowerCase() === clean(focus.frameHost).toLowerCase();
    if (!sameFocusFrame && !crossFrameControl) return;

    // A fallback may keep the analyst moving, but it must never replace a fresh
    // exact CasaTrade clock that is already authoritative for this same frame.
    if (fallback && exactClock(state, info)) return state;

    if ((!exact && !fallback) || !validRemaining) {
      const previousClock = exactClock(state, info);
      // A probe can briefly miss the countdown node at candle rollover or while
      // CasaTrade re-renders controls. Do not erase a still-fresh authoritative
      // clock with that transient pending observation.
      if (previousClock) return state;
      return {
        ...state,
        diagnostics: {
          ...(state.diagnostics || {}),
          marketClock: {
            asset, timeframe, available: false, verified: false, operational: false, role: 'candle-close',
            source: clean(message.clockSource || 'unverified'), mode: clean(message.clockMode || ''),
            frameId: info.frameId, frameHost: info.frameHost,
            crossFrameControl,
            boundFocusFrameId: crossFrameControl ? Number(focus.frameId) : null,
            boundFocusFrameHost: crossFrameControl ? clean(focus.frameHost).toLowerCase() : null,
            at: Date.now()
          },
          acquisition: { ...(state.diagnostics?.acquisition || {}), stage: 'syncing_clock', reason: 'Sincronizando o relógio da vela com a CasaTrade.', at: Date.now() }
        }
      };
    }

    const session = state.diagnostics?.marketSession || {};
    const frameChanged = Number(session.frameId) !== Number(focus.frameId)
      || clean(session.frameHost).toLowerCase() !== clean(focus.frameHost).toLowerCase();
    const sessionChanged = !sameMarket(session.asset, asset)
      || clean(session.timeframe).toUpperCase() !== clean(timeframe).toUpperCase()
      || frameChanged;
    let next = state;
    if (sessionChanged) {
      const sessionInfo = crossFrameControl
        ? { ...info, frameId: Number(focus.frameId), frameHost: clean(focus.frameHost).toLowerCase() }
        : info;
      next = resetForSession(state, {
        asset, timeframe, info: sessionInfo, source: exact ? 'exact-candle-clock' : 'fallback-candle-clock',
        reason: exact
          ? `Sessão ${asset} • ${timeframe || '—'} sincronizada ao fechamento real da vela.`
          : `Sessão ${asset} • ${timeframe || '—'} em leitura ao vivo com clock temporário de contingência.`
      });
    }

    const record = clockRecord(message, info, asset, timeframe, secondsRemaining, focus);
    const keepPlatformOnline = clean(next.connection).toLowerCase() === 'online';
    let clockState = {
      ...next,
      connection: next.price != null || keepPlatformOnline ? 'online' : 'connecting',
      timeframe: timeframe || next.timeframe,
      analysisTimeframe: timeframe || next.analysisTimeframe,
      expiration: message.expiration || next.expiration || null,
      targetExpiration: message.expiration || next.targetExpiration || null,
      diagnostics: {
        ...(next.diagnostics || {}),
        marketClock: record,
        marketSession: {
          ...(next.diagnostics?.marketSession || {}), asset, timeframe,
          frameId: Number(focus.frameId), frameHost: clean(focus.frameHost).toLowerCase(),
          dataMode: next.price != null ? 'live' : 'syncing'
        },
        acquisition: {
          ...(next.diagnostics?.acquisition || {}),
          stage: next.price != null ? 'diagnosing_next_candle' : 'syncing_price',
          reason: exact
            ? 'Relógio exato da vela sincronizado com a CasaTrade.'
            : 'Relógio exato indisponível; análise ao vivo continua com clock temporário identificado como estimado.',
          clockQuality: exact ? 'exact' : 'fallback', at: Date.now()
        }
      }
    };

    return clockState;
  });
}

export async function applyFeed(payload = {}, sender = {}) {
  const info = senderMeta(sender);
  if (!info.trusted) return null;
  return updateScannerState(state => {
    if (!licenseActive(state)) return;
    if (state.targetTabId && state.targetTabId !== info.tabId) return;
    const focus = state.diagnostics?.focusedAsset || null;
    if (!focus?.asset || Number(focus.frameId) !== Number(info.frameId) || clean(focus.frameHost).toLowerCase() !== info.frameHost) return;
    const asset = normAsset(focus.asset);
    const candidate = bestForFocus(payload, asset);
    if (!candidate) return;

    const assetIdentity = {
      networkRawAssetName: clean(candidate.assetRaw || ''),
      networkAsset: clean(candidate.asset || ''),
      finalAsset: clean(asset || ''),
      finalSource: clean(candidate.assetSource || 'network'),
      fallbackUsed: ['network-payload-fallback', 'trusted-visual-fallback'].includes(clean(candidate.assetSource)),
      contextChanged: false,
      at: Date.now()
    };

    const candidateTimeframe = normTf(candidate.timeframe);
    const stateTimeframe = normTf(state.diagnostics?.marketClock?.timeframe || state.analysisTimeframe || state.timeframe);
    if (candidateTimeframe && stateTimeframe && candidateTimeframe !== stateTimeframe) {
      return {
        ...state,
        diagnostics: {
          ...(state.diagnostics || {}),
          rejectedMarketData: {
            asset,
            candidateAsset: candidate.asset || null,
            candidateTimeframe,
            expectedTimeframe: stateTimeframe,
            reason: 'timeframe_identity_mismatch',
            at: Date.now()
          }
        }
      };
    }
    const feedTimeframe = stateTimeframe || candidateTimeframe || null;
    const incomingHistory = historyFor(payload, asset, feedTimeframe);
    // During a market switch the previous state may still contain candles from
    // the old instrument. Never merge them into the newly focused asset. A new
    // session must bootstrap exclusively from history explicitly keyed/tagged
    // for the focused instrument.
    const sessionBeforeFeed = state.diagnostics?.marketSession || {};
    const sessionOwnsFocus = sameMarket(sessionBeforeFeed.confirmedAsset || sessionBeforeFeed.asset, asset)
      && sessionBeforeFeed.transitioning !== true;
    const stateOwnsFocus = sameMarket(state.asset, asset);
    const previousHistory = sessionOwnsFocus && stateOwnsFocus ? stateHistory(state, asset, feedTimeframe) : [];
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
        inspector: state.diagnostics?.inspector || null,
        assetIdentity: {
          ...(state.diagnostics?.assetIdentity || {}),
          ...assetIdentity,
          contextKey: clean(state.diagnostics?.networkContext?.contextKey || ''),
          fallbackSource: clean(candidate.assetSource || ''),
          at: Date.now()
        }
      }
    };
  });
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
    if (!focus?.asset || Number(focus.frameId) !== Number(info.frameId) || clean(focus.frameHost).toLowerCase() !== info.frameHost) return;
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
  if (message?.type === 'ATS_NETWORK_CONTEXT_CHANGED') task = applyNetworkContext(message, sender);
  else if (message?.type === 'ATS_VISUAL_FOCUS_V2') task = applyFocus(message, sender);
  else if (message?.type === 'ATS_MARKET_CLOCK_V2') task = applyClock(message, sender);
  else if (message?.type === 'ATS_EMBEDDED_FEED') task = applyFeed(message.payload || {}, sender);
  else if (message?.type === 'ATS_CHART_FRAME_MARKET') task = applyChartPrice(message, sender);
  else if (message?.type === 'ATS_DATA_INSPECTOR') task = applyInspector(message, sender);
  if (!task) return false;
  Promise.resolve(task).then(state => sendResponse({ ok: true, state })).catch(error => sendResponse({ ok: false, error: String(error?.message || error) }));
  return true;
});
