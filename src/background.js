import { processSnapshot, resetOrchestrator } from './core/orchestrator.js';
import { readScannerState, updateScannerState } from './services/scanner-state-atomic.js';
import { resolveSignalHistory, signalPerformance, resolveSignalOutcome } from './core/signal-outcomes.js';
import { getThresholds } from './core/analysis.js';
import { storageLocalGet, storageLocalSet } from './services/chrome-compat.js';
import { track as telemetryEvent } from './services/telemetry.js';

// Single owner of technical analysis.
// All acquisition modules only update scannerState. This loop coalesces those
// updates and is the only runtime path allowed to invoke the technical orchestrator.
const ANALYSIS_CADENCE_MS = 650;
const BURST_COALESCE_MS = 80;
const CLOCK_FRESH_MS = 3200;
const ALLOWED_CLOCK_SOURCES = new Set(['trader-dom-countdown', 'network-server-cycle', 'platform-cycle-derived']);

const clean = value => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
const num = value => value == null || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null;
const normTf = value => {
  const raw = clean(value).toUpperCase().replace(/\s+/g, '');
  let match = raw.match(/^([SMH])(\d{1,5})$/);
  if (match && Number(match[2]) > 0) return `${match[1]}${Number(match[2])}`;
  match = raw.match(/^(\d{1,4})(?:M|MIN)$/);
  if (match && Number(match[1]) > 0) return `M${Number(match[1])}`;
  return null;
};
const marketId = value => {
  const raw = clean(value).toUpperCase();
  if (!raw) return '';
  const otc = /(?:\(|\b|[_-])OTC(?:\)|\b)?/i.test(raw);
  const pair = raw.match(/\b([A-Z0-9]{2,20})\s*[\/_-]\s*([A-Z0-9]{2,12})/i);
  return pair ? `${pair[1]}/${pair[2]}${otc ? ' (OTC)' : ''}` : raw;
};
const sameMarket = (a, b) => !!marketId(a) && marketId(a) === marketId(b);
const normExp = value => {
  const raw = clean(value).toLowerCase().replace(/\s+/g, '');
  let match = raw.match(/^(\d{1,5})(?:s|seg|segundo|segundos)$/);
  if (match) return `${Number(match[1])}s`;
  match = raw.match(/^(\d{1,4})(?:m|min|minuto|minutos)$/);
  if (match) return `${Number(match[1]) * 60}s`;
  return null;
};

const SIGNAL_PERFORMANCE_KEY = 'atsSignalPerformanceLedgerV1';
const SIGNAL_PERFORMANCE_MAX = 2000;
let signalPerformanceQueue = Promise.resolve();
let lastSignalPerformanceSignature = '';

const candleTimestamp = row => {
  let value = Number(row?.time ?? row?.timestamp);
  if (Number.isFinite(value) && value > 0 && value < 1e12) value *= 1000;
  return Number.isFinite(value) && value > 0 ? value : null;
};

function performanceEmission(state = {}) {
  const signal = state.signal || {};
  const professional = state.professionalDecision || {};
  const professionalUi = clean(professional.uiState).toUpperCase();
  const technicalUi = clean(signal.uiState).toUpperCase();
  const ui = ['ENTER_BUY','ENTER_SELL','POSSIBLE_BUY','POSSIBLE_SELL'].includes(professionalUi)
    ? professionalUi
    : ['ENTER_BUY','ENTER_SELL','POSSIBLE_BUY','POSSIBLE_SELL'].includes(technicalUi)
      ? technicalUi
      : '';
  if (!ui) return null;

  const type = ui.startsWith('ENTER_') ? 'ENTER' : 'POSSIBLE';
  const direction = ui.endsWith('_BUY') ? 'BUY' : ui.endsWith('_SELL') ? 'SELL' : '';
  if (!direction) return null;

  const focus = state.diagnostics?.focusedAsset || {};
  const clock = state.diagnostics?.marketClock || {};
  if (focus.reliable !== true || focus.chartScoped !== true || focus.trustedChartFrame !== true) return null;
  if (clock.verified !== true || clock.available === false || clock.role !== 'candle-close') return null;

  const timeframe = normTf(state.analysisTimeframe || state.timeframe || professional.timeframe || signal.timeframe || clock.timeframe);
  const expiration = normExp(state.platformControls?.observed?.expiration || state.targetExpiration || state.expiration || professional.actualExpiration);
  if (timeframe !== 'M1' || expiration !== '60s') return null;

  const complete = (Array.isArray(state.candles) ? state.candles : []).filter(row =>
    [row?.open,row?.high,row?.low,row?.close].every(value => num(value) != null)
  );
  if (complete.length < 2) return null;

  const analytics = signal.analytics || {};
  const power = Number(direction === 'BUY' ? analytics.buyPower : analytics.sellPower) || 0;
  if (power < 50) return null;

  const targetStart = num(signal.targetStart ?? state.decisionCycle?.targetStart);
  if (targetStart == null) return null;

  const thresholds = getThresholds(state.analystPreferences?.sensitivityProfile || 'MEDIO');
  const emittedAt = Date.now();
  const score = num(professional.score ?? signal.analysisScore ?? signal.score) ?? 0;
  const secondsRemaining = num(professional.secondsRemaining ?? signal.secondsRemaining ?? clock.secondsRemaining);
  const referencePrice = num(state.price);
  const id = [marketId(state.asset), 'M1', Number(targetStart), direction, type].join('|');

  return {
    id,
    asset: marketId(state.asset),
    direction,
    type,
    score,
    candleStrength: num(analytics.currentStrength),
    secondsRemaining,
    emittedAt,
    referencePrice,
    timeframe: 'M1',
    expiration: '60s',
    profile: thresholds.label,
    profileKey: thresholds.profile,
    targetStart: Number(targetStart),
    entryPrice: null,
    exitPrice: null,
    result: null,
    status: 'pending'
  };
}

function performanceFeedAdvancedPastTarget(candles = [], targetStart = 0) {
  const end = Number(targetStart || 0) + 60_000;
  return (Array.isArray(candles) ? candles : []).some(row => Number(candleTimestamp(row) || 0) >= end);
}

async function updateSignalPerformanceLedger(state = {}) {
  const emission = performanceEmission(state);
  const candles = Array.isArray(state.candles) ? state.candles : [];
  const stored = await storageLocalGet(SIGNAL_PERFORMANCE_KEY).catch(() => ({}));
  const current = stored?.[SIGNAL_PERFORMANCE_KEY];
  let rows = Array.isArray(current?.rows) ? current.rows.slice(-SIGNAL_PERFORMANCE_MAX) : [];
  let changed = false;

  if (emission && !rows.some(row => row?.id === emission.id)) {
    rows.push(emission);
    changed = true;
  }

  const now = Date.now();
  rows = rows.map(row => {
    if (!row || row.status === 'resolved' || row.result) return row;
    if (!sameMarket(row.asset, state.asset)) return row;

    const outcome = resolveSignalOutcome(row, candles, { now });
    if (outcome) {
      changed = true;
      return {
        ...row,
        entryPrice: outcome.entryPrice,
        exitPrice: outcome.exitPrice,
        result: outcome.result === 'DRAW' ? 'EMPATE' : outcome.result,
        status: 'resolved',
        resolvedAt: outcome.resolvedAt,
        outcomeBasis: outcome.outcomeBasis
      };
    }

    const due = now >= Number(row.targetStart || 0) + 60_000;
    if (due && performanceFeedAdvancedPastTarget(candles, row.targetStart)) {
      changed = true;
      return {
        ...row,
        result: 'INDETERMINADO',
        status: 'resolved',
        resolvedAt: now,
        outcomeBasis: 'target_candle_data_unavailable'
      };
    }
    return row;
  });

  if (!changed) return;
  rows = rows.slice(-SIGNAL_PERFORMANCE_MAX);
  await storageLocalSet({
    [SIGNAL_PERFORMANCE_KEY]: {
      rows,
      updatedAt: Date.now()
    }
  });
}

function observeSignalPerformance(state = {}) {
  const emission = performanceEmission(state);
  const lastCandle = (Array.isArray(state.candles) ? state.candles : []).at(-1) || null;
  const signature = JSON.stringify([
    emission?.id || null,
    candleTimestamp(lastCandle),
    state.asset || null,
    state.diagnostics?.marketSession?.epoch || 0
  ]);
  if (signature === lastSignalPerformanceSignature) return;
  lastSignalPerformanceSignature = signature;
  signalPerformanceQueue = signalPerformanceQueue
    .then(() => updateSignalPerformanceLedger(state))
    .catch(() => {});
}
const clockBoundToFocus = (clock = {}, focus = {}) => {
  const sameFrame = Number(clock.frameId) === Number(focus.frameId)
    && clean(clock.frameHost).toLowerCase() === clean(focus.frameHost).toLowerCase();
  const boundControlFrame = clock.crossFrameControl === true
    && Number(clock.boundFocusFrameId) === Number(focus.frameId)
    && clean(clock.boundFocusFrameHost).toLowerCase() === clean(focus.frameHost).toLowerCase();
  return sameFrame || boundControlFrame;
};
const activeAccess = state => {
  const status = clean(state?.license?.status).toLowerCase();
  return ['active', 'valid'].includes(status)
    || state?.license?.devMode === true
    || state?.license?.plan === 'OWNER_DEV'
    || state?.diagnostics?.access?.ownerDev === true
    || state?.diagnostics?.access?.state === 'owner_dev';
};

function historyFor(state = {}, asset = '') {
  const history = state.marketHistory || {};
  const key = Object.keys(history).find(value => sameMarket(value, asset));
  const rows = key && Array.isArray(history[key]) ? history[key] : Array.isArray(state.candles) ? state.candles : [];
  return rows.filter(row => [row?.open, row?.high, row?.low, row?.close].every(value => num(value) != null)).slice(-180);
}

function consolidatedSnapshot(state = {}) {
  if (!activeAccess(state) || state.scanner !== 'scanning' || state.connection !== 'online') return null;
  const asset = marketId(state.asset);
  const price = num(state.price);
  const focus = state.diagnostics?.focusedAsset || null;
  const clock = state.diagnostics?.marketClock || null;
  if (!asset || price == null || !focus?.asset || !sameMarket(focus.asset, asset)) return null;
  if (focus.reliable !== true || focus.chartScoped !== true || focus.trustedChartFrame !== true) return null;
  if (!clock || clock.available === false || (!clock.verified && clock.operational !== true)) return null;
  if (!ALLOWED_CLOCK_SOURCES.has(clean(clock.source))) return null;
  if (!sameMarket(clock.asset, asset)) return null;
  if (!clockBoundToFocus(clock, focus)) return null;
  if (Number(clock.at || 0) <= 0 || Date.now() - Number(clock.at) > CLOCK_FRESH_MS) return null;

  const secondsRemaining = num(clock.secondsRemaining);
  if (secondsRemaining == null || secondsRemaining < 0) return null;
  const timeframe = normTf(clock.timeframe || state.analysisTimeframe || state.timeframe);
  if (!timeframe) return null;
  const candles = historyFor(state, asset);
  if (candles.length < 2) return null;

  return {
    platformId: state.platformId || 'casatrade',
    platformName: state.platformName || 'CasaTrade',
    connection: 'online',
    asset,
    price,
    timeframe,
    analysisTimeframe: timeframe,
    expiration: state.platformControls?.observed?.expiration || state.targetExpiration || state.expiration || clock.expiration || null,
    targetExpiration: state.platformControls?.observed?.expiration || state.targetExpiration || state.expiration || clock.expiration || null,
    secondsRemaining,
    serverTime: Date.now(),
    candles,
    capabilities: {
      ...(state.capabilities || {}),
      structuredQuotes: true,
      candles: true
    },
    diagnostics: {
      capture: 'central-consolidated-state',
      clockQuality: clock.verified === true ? 'exact' : 'fallback',
      feedQuality: Number(state.diagnostics?.acquisition?.feedQuality || 0)
    }
  };
}

function signalRecordId(asset, timeframe, targetStart, direction) {
  return [marketId(asset), clean(timeframe).toUpperCase(), Number(targetStart || 0), clean(direction).toUpperCase()].join('|');
}

function reconcileSignalHistory(state = {}, next = {}, snapshot = {}) {
  let rows = Array.isArray(state.signalHistory) ? state.signalHistory.slice(-99) : [];
  const signal = next.signal || {};
  const direction = clean(signal.direction || next.decisionCycle?.direction).toUpperCase();
  const targetStart = num(signal.targetStart ?? next.decisionCycle?.targetStart);
  const timeframe = normTf(snapshot.analysisTimeframe || snapshot.timeframe || signal.timeframe);
  const confirmed = signal.state === 'CONFIRM'
    || ['ENTER_BUY', 'ENTER_SELL'].includes(clean(signal.uiState).toUpperCase());

  if (confirmed && ['BUY', 'SELL'].includes(direction) && targetStart != null && timeframe) {
    const id = signalRecordId(snapshot.asset, timeframe, targetStart, direction);
    if (!rows.some(row => row?.id === id)) {
      rows.push({
        id,
        asset: snapshot.asset,
        timeframe,
        direction,
        targetStart,
        score: num(signal.analysisScore ?? signal.score),
        setup: signal.setup || null,
        createdAt: Date.now(),
        entryPrice: null,
        exitPrice: null,
        result: null,
        status: 'pending'
      });
    }
  }

  const outcome = resolveSignalHistory(rows, {
    asset: snapshot.asset,
    candles: snapshot.candles,
    serverTime: snapshot.serverTime
  });
  rows = outcome.rows.slice(-100);
  return {
    rows,
    resolved: outcome.resolved,
    captured: outcome.captured,
    performance: signalPerformance(rows)
  };
}

function rawInputSignature(state = {}, snapshot = null) {
  if (!snapshot) return '';
  const clock = state.diagnostics?.marketClock || {};
  const rows = snapshot.candles || [];
  const tail = rows.slice(-3).map(row => [
    Number(row?.time ?? row?.timestamp ?? 0),
    Number(row?.open ?? 0), Number(row?.high ?? 0), Number(row?.low ?? 0), Number(row?.close ?? 0)
  ]);
  return JSON.stringify([
    snapshot.asset, snapshot.price, snapshot.timeframe, snapshot.expiration,
    snapshot.secondsRemaining, Number(clock.at || 0), clean(clock.source),
    getThresholds(state.analystPreferences?.sensitivityProfile || 'MEDIO').profile,
    Number(state.lastSeen || 0), tail
  ]);
}

let analysisTimer = null;
let analysisRunning = false;
let pendingForce = false;
let pendingAfterRun = false;
let lastRunAt = 0;
let lastInputSignature = '';
let lastMarketKey = '';
let revision = 0;

function scheduleAnalysis(force = false) {
  pendingForce ||= force;
  if (analysisRunning) {
    pendingAfterRun = true;
    return;
  }
  if (analysisTimer) return;
  const sinceLast = Date.now() - lastRunAt;
  const cadenceDelay = Math.max(0, ANALYSIS_CADENCE_MS - sinceLast);
  const delay = Math.max(BURST_COALESCE_MS, cadenceDelay);
  analysisTimer = setTimeout(() => {
    analysisTimer = null;
    const runForced = pendingForce;
    pendingForce = false;
    runCentralAnalysis(runForced).catch(() => {});
  }, delay);
}

async function runCentralAnalysis(force = false) {
  if (analysisRunning) {
    scheduleAnalysis(force);
    return;
  }
  analysisRunning = true;
  let needsConfirmationFollowup = false;
  let resolvedForTelemetry = [];
  try {
    await updateScannerState(current => {
      const snapshot = consolidatedSnapshot(current);
      if (!snapshot) return current;

      const inputSignature = rawInputSignature(current, snapshot);
      if (!force && inputSignature === lastInputSignature) return current;

      const session = current.diagnostics?.marketSession || {};
      const focus = current.diagnostics?.focusedAsset || {};
      const marketKey = [
        snapshot.asset,
        snapshot.analysisTimeframe,
        Number(session.epoch || 0),
        getThresholds(current.analystPreferences?.sensitivityProfile || 'MEDIO').profile,
        Number(focus.frameId ?? -1),
        clean(focus.frameHost).toLowerCase()
      ].join('|');
      if (lastMarketKey && lastMarketKey !== marketKey) resetOrchestrator();
      lastMarketKey = marketKey;

      const processed = processSnapshot(snapshot, current);
      lastInputSignature = inputSignature;
      lastRunAt = Date.now();
      revision += 1;

      const next = {
        ...current,
        ...processed,
        // Raw acquisition state remains authoritative.
        asset: current.asset,
        price: current.price,
        timeframe: current.timeframe || snapshot.timeframe,
        analysisTimeframe: current.analysisTimeframe || snapshot.analysisTimeframe,
        expiration: current.expiration,
        targetExpiration: current.targetExpiration,
        candles: current.candles,
        currentCandle: current.currentCandle || processed?.currentCandle || null,
        marketHistory: current.marketHistory,
        lastSeen: current.lastSeen,
        connection: current.connection,
        platformControls: current.platformControls,
        diagnostics: {
          ...(current.diagnostics || {}),
          ...(processed?.diagnostics || {}),
          focusedAsset: current.diagnostics?.focusedAsset || null,
          marketClock: current.diagnostics?.marketClock || null,
          marketSession: current.diagnostics?.marketSession || null,
          analysisLoop: {
            owner: 'background.js',
            revision,
            cadenceMs: ANALYSIS_CADENCE_MS,
            inputSignature,
            at: lastRunAt
          }
        }
      };

      const history = reconcileSignalHistory(current, next, snapshot);
      resolvedForTelemetry = history.resolved;
      const nextWithHistory = {
        ...next,
        signalHistory: history.rows,
        performance: history.performance,
        diagnostics: {
          ...(next.diagnostics || {}),
          outcomes: {
            pending: history.performance.pending,
            resolved: history.performance.resolved,
            lastCapturedAt: history.captured.at(-1)?.entryCapturedAt || null,
            lastResolvedAt: history.resolved.at(-1)?.resolvedAt || null
          }
        }
      };

      const seconds = num(snapshot.secondsRemaining);
      const activeThresholds = getThresholds(current.analystPreferences?.sensitivityProfile || 'MEDIO');
      const locked = clean(nextWithHistory.decisionCycle?.locked).toUpperCase();
      const confirmed = nextWithHistory.signal?.state === 'CONFIRM' || ['ENTER_BUY', 'ENTER_SELL'].includes(clean(nextWithHistory.signal?.uiState).toUpperCase());
      needsConfirmationFollowup = seconds != null && seconds > 0 && seconds <= activeThresholds.entryWindowSeconds && !confirmed && locked !== 'WAIT';
      return nextWithHistory;
    });
  } finally {
    analysisRunning = false;
  }

  for (const row of resolvedForTelemetry) {
    telemetryEvent('signal_resolved', {
      id: row.id,
      asset: row.asset,
      timeframe: row.timeframe,
      direction: row.direction,
      targetStart: row.targetStart,
      entryPrice: row.entryPrice,
      exitPrice: row.exitPrice,
      result: row.result
    }).catch(() => {});
  }

  if (pendingAfterRun) {
    pendingAfterRun = false;
    scheduleAnalysis(pendingForce);
  }
  if (needsConfirmationFollowup) scheduleAnalysis(true);
}

function observeState(state = {}) {
  const snapshot = consolidatedSnapshot(state);
  if (!snapshot) return;
  const signature = rawInputSignature(state, snapshot);
  if (signature !== lastInputSignature) scheduleAnalysis(false);
}

globalThis.__ATS_RUN_CENTRAL_ANALYSIS__ = runCentralAnalysis;
globalThis.__ATS_SCHEDULE_CENTRAL_ANALYSIS__ = scheduleAnalysis;

chrome.storage?.onChanged?.addListener?.((changes, area) => {
  if (area !== 'local' || !changes.scannerState?.newValue) return;
  observeState(changes.scannerState.newValue);
  observeSignalPerformance(changes.scannerState.newValue);
});

readScannerState().then(state => {
  observeState(state);
  observeSignalPerformance(state);
}).catch(() => {});

const HEALTH_CHECK_MS = 1000;
const RECOVERY_AFTER_MS = 4500;
const RECOVERY_COOLDOWN_MS = 10000;
let lastRecoveryAt = 0;

function acquisitionGaps(state = {}) {
  const gaps = [];
  const focus = state.diagnostics?.focusedAsset || {};
  const clock = state.diagnostics?.marketClock || {};
  const controls = state.platformControls || {};
  const rows = historyFor(state, state.asset || '');
  if (!state.asset || focus.reliable !== true || !sameMarket(focus.asset, state.asset)) gaps.push('ativo');
  if (num(state.price) == null) gaps.push('preço');
  if (rows.length < 10) gaps.push('histórico 10 velas');
  const clockFresh = clock.available !== false
    && Number.isFinite(Number(clock.secondsRemaining))
    && Number(clock.at || 0) > 0
    && Date.now() - Number(clock.at) < CLOCK_FRESH_MS;
  if (!clockFresh) gaps.push('countdown');
  const expirationAt = Number(controls.expirationCheckedAt || controls.observed?.observedAt?.expiration || 0);
  const expirationFresh = expirationAt > 0 && Date.now() - expirationAt < 7000;
  if (!expirationFresh || !clean(controls.observed?.expiration)) gaps.push('expiração');
  return gaps;
}

async function recoverAcquisition() {
  const state = await readScannerState().catch(() => null);
  if (!state || !activeAccess(state) || !state.targetTabId) return;
  if (!['scanning','idle'].includes(clean(state.scanner))) return;

  const startedAt = Number(state.diagnostics?.target?.connectedAt || state.diagnostics?.marketSession?.startedAt || 0);
  if (!startedAt || Date.now() - startedAt < RECOVERY_AFTER_MS) return;

  const gaps = acquisitionGaps(state);
  if (!gaps.length) return;

  await updateScannerState(current => ({
    ...current,
    diagnostics: {
      ...(current.diagnostics || {}),
      health: {
        state: 'recovering',
        missing: gaps,
        at: Date.now()
      },
      acquisition: {
        ...(current.diagnostics?.acquisition || {}),
        stage: 'recovering_live_readers',
        reason: `Recuperando leitura real: ${gaps.join(', ')}.`,
        at: Date.now()
      }
    }
  })).catch(() => {});

  if (Date.now() - lastRecoveryAt < RECOVERY_COOLDOWN_MS) return;
  const inject = globalThis.__ATS_INJECT_MODERN_PIPELINE__;
  if (typeof inject !== 'function') return;
  lastRecoveryAt = Date.now();
  await inject(Number(state.targetTabId)).catch(() => false);
}

setInterval(() => recoverAcquisition().catch(() => {}), HEALTH_CHECK_MS);

