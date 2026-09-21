import { fastLiveDecision } from './core/live-fast-decision.js';
import { updateScannerState } from './services/scanner-state-atomic.js';
import { marketSessionEpoch, withMarketSessionEpoch } from './background-market-session.js';

let writing = false;
const clean = value => String(value ?? '').trim();
const activeAccess = state => {
  const status = clean(state?.license?.status).toLowerCase();
  return ['active', 'valid'].includes(status);
};

function marketFresh(state = {}) {
  const at = Number(state.lastSeen || 0);
  return at > 0 && Date.now() - at <= 6000;
}

const EXACT_CLOCK_SOURCES = new Set(['trader-dom-countdown', 'network-server-cycle']);

function sameMarket(a = '', b = '') {
  const norm = value => clean(value).toUpperCase().replace(/\s*\(\s*OTC\s*\)\s*$/i, '');
  return !!norm(a) && norm(a) === norm(b);
}

function exactClockReady(state = {}) {
  const clock = state.diagnostics?.marketClock || {};
  const focus = state.diagnostics?.focusedAsset || {};
  const sameFrame = Number(clock.frameId) === Number(focus.frameId)
    && clean(clock.frameHost).toLowerCase() === clean(focus.frameHost).toLowerCase();
  const boundControlFrame = clock.crossFrameControl === true
    && Number(clock.boundFocusFrameId) === Number(focus.frameId)
    && clean(clock.boundFocusFrameHost).toLowerCase() === clean(focus.frameHost).toLowerCase();

  return focus.reliable === true
    && focus.chartScoped === true
    && focus.trustedChartFrame === true
    && sameMarket(focus.asset, state.asset)
    && clock.verified === true
    && clock.available !== false
    && clock.role === 'candle-close'
    && EXACT_CLOCK_SOURCES.has(clean(clock.source))
    && sameMarket(clock.asset, state.asset)
    && (sameFrame || boundControlFrame)
    && Number(clock.at || 0) > 0
    && Date.now() - Number(clock.at) < 3200
    && Number.isFinite(Number(clock.secondsRemaining));
}

function sameSignal(a = {}, b = {}) {
  return a.uiState === b.uiState
    && a.direction === b.direction
    && Number(a.score || 0) === Number(b.score || 0)
    && clean(a.reason) === clean(b.reason);
}

function decisionRank(signal = {}) {
  const ui = clean(signal?.uiState).toUpperCase();
  if (ui === 'ENTER_BUY' || ui === 'ENTER_SELL' || clean(signal?.state).toUpperCase() === 'CONFIRM') return 3;
  if (ui === 'POSSIBLE_BUY' || ui === 'POSSIBLE_SELL') return 2;
  if (ui === 'DECIDING') return 1;
  return 0;
}

function canFastApply(current = {}, decided = {}) {
  const currentRank = decisionRank(current);
  const nextRank = decisionRank(decided);
  if (nextRank < currentRank) return false;
  if (currentRank >= 2 && nextRank === currentRank) {
    const a = clean(current.direction).toUpperCase();
    const b = clean(decided.direction).toUpperCase();
    if (a && b && a !== b) return false;
  }
  return true;
}

async function applyFastDecision(observed = {}) {
  if (writing || !activeAccess(observed) || observed.scanner !== 'scanning' || observed.connection !== 'online') return;
  if (!marketFresh(observed) || !exactClockReady(observed) || !observed.asset || !Array.isArray(observed.candles) || observed.candles.length < 3 || !observed.signal) return;

  const observedEpoch = marketSessionEpoch(observed);
  const nextSignal = fastLiveDecision(observed.signal, {
    asset: observed.asset,
    timeframe: observed.analysisTimeframe || observed.timeframe || 'M1',
    operationMode: observed.analystPreferences?.operationMode || 'M1',
    sensitivityProfile: observed.analystPreferences?.sensitivityProfile || 'MEDIO',
    confirmationMode: observed.analystPreferences?.confirmationMode || 'SIMPLES',
    secondsRemaining: observed.diagnostics?.marketClock?.secondsRemaining ?? observed.signal?.secondsRemaining,
    targetStart: observed.diagnostics?.marketClock?.closeAt ?? observed.signal?.targetStart,
    serverTime: observed.serverTime || Date.now()
  });
  if (!nextSignal || sameSignal(nextSignal, observed.signal) || !canFastApply(observed.signal, nextSignal)) return;

  writing = true;
  try {
    await updateScannerState(current => withMarketSessionEpoch(current, observedEpoch, epochState => {
      if (!activeAccess(epochState) || epochState.scanner !== 'scanning' || epochState.connection !== 'online') return epochState;
      if (clean(epochState.asset) !== clean(observed.asset)) return epochState;
      const decided = nextSignal;
      if (!decided || sameSignal(decided, epochState.signal || {}) || !canFastApply(epochState.signal || {}, decided)) return epochState;
      return {
        ...epochState,
        signal: decided,
        diagnostics: {
          ...(epochState.diagnostics || {}),
          fastDecision: {
            active: true,
            mode: 'live-core',
            epoch: observedEpoch,
            uiState: decided.uiState || '',
            direction: decided.direction || '',
            score: Number(decided.score || 0),
            confirmationMode: observed.analystPreferences?.confirmationMode || 'SIMPLES',
            at: Date.now()
          }
        }
      };
    }));
  } finally {
    writing = false;
  }
}

chrome.storage?.onChanged?.addListener?.((changes, area) => {
  if (area !== 'local' || !changes.scannerState?.newValue) return;
  applyFastDecision(changes.scannerState.newValue).catch(() => {});
});

chrome.storage?.local?.get?.(['scannerState']).then?.(data => {
  applyFastDecision(data?.scannerState || {}).catch(() => {});
}).catch?.(() => {});
