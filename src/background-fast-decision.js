import { fastLiveDecision } from './core/live-fast-decision.js';
import { updateScannerState } from './services/scanner-state-atomic.js';

let writing = false;
const clean = value => String(value ?? '').trim();
const activeAccess = state => {
  const status = clean(state?.license?.status).toLowerCase();
  return ['active', 'valid'].includes(status)
    || state?.license?.devMode === true
    || state?.license?.plan === 'OWNER_DEV'
    || state?.diagnostics?.access?.ownerDev === true
    || state?.diagnostics?.access?.state === 'owner_dev';
};

function marketFresh(state = {}) {
  const at = Number(state.lastSeen || 0);
  return at > 0 && Date.now() - at <= 6000;
}

function sameSignal(a = {}, b = {}) {
  return a.uiState === b.uiState
    && a.direction === b.direction
    && Number(a.score || 0) === Number(b.score || 0)
    && clean(a.reason) === clean(b.reason);
}

async function applyFastDecision(observed = {}) {
  if (writing || !activeAccess(observed) || observed.scanner !== 'scanning' || observed.connection !== 'online') return;
  if (!marketFresh(observed) || !observed.asset || !Array.isArray(observed.candles) || observed.candles.length < 3 || !observed.signal) return;

  const nextSignal = fastLiveDecision(observed.signal, {
    asset: observed.asset,
    timeframe: observed.analysisTimeframe || observed.timeframe || 'M1',
    secondsRemaining: observed.signal?.secondsRemaining,
    serverTime: observed.serverTime || Date.now()
  });
  if (!nextSignal || sameSignal(nextSignal, observed.signal)) return;

  writing = true;
  try {
    await updateScannerState(current => {
      if (!activeAccess(current) || current.scanner !== 'scanning' || current.connection !== 'online') return current;
      if (clean(current.asset) !== clean(observed.asset)) return current;
      const decided = nextSignal;
      if (!decided || sameSignal(decided, current.signal || {})) return current;
      return {
        ...current,
        signal: decided,
        diagnostics: {
          ...(current.diagnostics || {}),
          fastDecision: {
            active: true,
            mode: 'live-core',
            uiState: decided.uiState || '',
            direction: decided.direction || '',
            score: Number(decided.score || 0),
            at: Date.now()
          }
        }
      };
    });
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
