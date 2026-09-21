import { processSnapshot, resetOrchestrator } from './core/orchestrator.js';
import { readScannerState, updateScannerState } from './services/scanner-state-atomic.js';
import { resolveSignalHistory, signalPerformance, resolveSignalOutcome, diagnoseSignalOutcomePending } from './core/signal-outcomes.js';
import { getThresholds, getOperationMode } from './core/analysis.js';
import { storageLocalGet, storageLocalSet } from './services/chrome-compat.js';
import { track as telemetryEvent, heartbeat as telemetryHeartbeat } from './services/telemetry.js';
import { consumeSignal, validateLicense } from './services/license.js';

// Single owner of technical analysis.
// All acquisition modules only update scannerState. This loop coalesces those
// updates and is the only runtime path allowed to invoke the technical orchestrator.
const ANALYSIS_CADENCE_MS = 650;
const BURST_COALESCE_MS = 80;
const CLOCK_FRESH_MS = 3200;
const EXACT_CLOCK_SOURCES = new Set(['trader-dom-countdown', 'network-server-cycle']);

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

function performanceTimeframeMs(value = 'M1') {
  const tf = normTf(value) || 'M1';
  if (tf.startsWith('S')) return Math.max(1, Number(tf.slice(1))) * 1000;
  if (tf.startsWith('M')) return Math.max(1, Number(tf.slice(1))) * 60_000;
  if (tf.startsWith('H')) return Math.max(1, Number(tf.slice(1))) * 3_600_000;
  return 60_000;
}

function performanceTargetBucket(targetStart, timeframe = 'M1') {
  const value = num(targetStart);
  if (value == null) return null;
  const tfMs = performanceTimeframeMs(timeframe);
  return Math.round(value / tfMs) * tfMs;
}

function median(values = []) {
  const rows = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!rows.length) return null;
  const middle = Math.floor(rows.length / 2);
  return rows.length % 2 ? rows[middle] : (rows[middle - 1] + rows[middle]) / 2;
}

function closedM1ForShadow(state = {}, now = Date.now()) {
  const rows = historyFor(state, state.asset)
    .map(row => ({ ...row, __time: candleTimestamp(row) }))
    .filter(row => row.__time != null)
    .sort((a, b) => a.__time - b.__time);

  const unique = [...new Map(rows.map(row => [row.__time, row])).values()];
  const diffs = [];
  for (let index = 1; index < unique.length; index += 1) {
    const diff = unique[index].__time - unique[index - 1].__time;
    if (diff >= 30_000 && diff <= 120_000) diffs.push(diff);
  }
  const cadence = median(diffs);
  if (cadence == null || cadence < 45_000 || cadence > 90_000) return [];

  return unique.filter(row => row.__time + 60_000 <= now);
}

function aggregateClosedM5(m1Rows = [], now = Date.now()) {
  const groups = new Map();
  for (const row of m1Rows) {
    const time = Number(row?.__time ?? candleTimestamp(row));
    if (!Number.isFinite(time)) continue;
    const bucket = Math.floor(time / 300_000) * 300_000;
    if (bucket + 300_000 > now) continue;
    const group = groups.get(bucket) || new Map();
    group.set(Math.floor(time / 60_000) * 60_000, row);
    groups.set(bucket, group);
  }

  return [...groups.entries()]
    .sort((a, b) => a[0] - b[0])
    .filter(([, group]) => group.size >= 5)
    .map(([time, group]) => {
      const rows = [...group.values()].sort((a, b) => Number(a.__time) - Number(b.__time)).slice(0, 5);
      return {
        time,
        open: num(rows[0]?.open),
        high: Math.max(...rows.map(row => Number(row.high))),
        low: Math.min(...rows.map(row => Number(row.low))),
        close: num(rows.at(-1)?.close)
      };
    })
    .filter(row => [row.open, row.high, row.low, row.close].every(value => num(value) != null));
}

function emaLast(values = [], period = 5) {
  const rows = values.map(num).filter(value => value != null);
  if (!rows.length) return null;
  const alpha = 2 / (period + 1);
  let value = rows[0];
  for (let index = 1; index < rows.length; index += 1) value = rows[index] * alpha + value * (1 - alpha);
  return value;
}

function kaufmanEfficiency(values = []) {
  const rows = values.map(num).filter(value => value != null).slice(-20);
  if (rows.length < 20) return null;
  const change = Math.abs(rows.at(-1) - rows[0]);
  let volatility = 0;
  for (let index = 1; index < rows.length; index += 1) volatility += Math.abs(rows[index] - rows[index - 1]);
  return volatility > 0 ? change / volatility : 0;
}

function shadowMeasurements(state = {}, direction = '') {
  const now = Date.now();
  const m1 = closedM1ForShadow(state, now);
  const m5 = aggregateClosedM5(m1, now);
  const side = clean(direction).toUpperCase();
  let fM5 = 'NEUTRO';
  let fExtremo = 'NEUTRO';

  if (m5.length >= 12) {
    const closes = m5.map(row => Number(row.close));
    const ema5 = emaLast(closes, 5);
    const ema10 = emaLast(closes, 10);
    if (ema5 != null && ema10 != null && ema5 !== ema10) {
      const trend = ema5 > ema10 ? 'BUY' : 'SELL';
      fM5 = trend === side ? 'PASSA' : 'FALHA';
    }
  }

  let percentB = null;
  if (m1.length >= 20) {
    const closes = m1.slice(-20).map(row => Number(row.close));
    const mean = closes.reduce((sum, value) => sum + value, 0) / closes.length;
    const variance = closes.reduce((sum, value) => sum + (value - mean) ** 2, 0) / closes.length;
    const deviation = Math.sqrt(variance);
    const upper = mean + 2 * deviation;
    const lower = mean - 2 * deviation;
    const width = upper - lower;
    const price = num(state.price);
    if (price != null && width > 0) {
      percentB = (price - lower) / width;
      if (side === 'BUY') fExtremo = percentB < 0.85 ? 'PASSA' : 'FALHA';
      else if (side === 'SELL') fExtremo = percentB > 0.15 ? 'PASSA' : 'FALHA';
    }
  }

  const erM1 = kaufmanEfficiency(m1.map(row => row.close));
  const erM5 = kaufmanEfficiency(m5.map(row => row.close));
  const suggestion = erM1 != null && erM5 != null && Math.abs(erM5 - erM1) >= 0.10
    ? (erM5 > erM1 ? 'M5' : 'M1')
    : 'SEM_DIFERENCA_CLARA';

  return {
    f_m5: fM5,
    f_extremo: fExtremo,
    f_extremo_percentB: percentB,
    er_m1: erM1,
    er_m5: erM5,
    sugestao_timeframe: suggestion
  };
}

function performanceEmission(state = {}) {
  const signal = state.signal || {};
  const professional = state.professionalDecision || {};
  const professionalUi = clean(professional.uiState).toUpperCase();
  const technicalUi = clean(signal.uiState).toUpperCase();
  const hasProfessionalDecision = !!professionalUi || Number(professional.updatedAt || 0) > 0;
  // Performance follows the user-facing professional decision. Once that layer
  // exists, a technical ENTER blocked by time/expiration/hold is not a signal.
  const ui = hasProfessionalDecision
    ? (['ENTER_BUY','ENTER_SELL','POSSIBLE_BUY','POSSIBLE_SELL'].includes(professionalUi) ? professionalUi : '')
    : (['ENTER_BUY','ENTER_SELL','POSSIBLE_BUY','POSSIBLE_SELL'].includes(technicalUi) ? technicalUi : '');
  if (!ui) return null;

  const type = ui.startsWith('ENTER_') ? 'ENTER' : 'POSSIBLE';
  const direction = ui.endsWith('_BUY') ? 'BUY' : ui.endsWith('_SELL') ? 'SELL' : '';
  if (!direction) return null;

  const focus = state.diagnostics?.focusedAsset || {};
  const clock = state.diagnostics?.marketClock || {};
  if (focus.reliable !== true || focus.chartScoped !== true || focus.trustedChartFrame !== true) return null;
  if (clock.verified !== true || clock.available === false || clock.role !== 'candle-close') return null;

  const operationMode = getOperationMode(state.analystPreferences?.operationMode || 'M1');
  const timeframe = normTf(state.analysisTimeframe || state.timeframe || professional.timeframe || signal.timeframe || clock.timeframe);
  const expiration = normExp(state.platformControls?.observed?.expiration || state.targetExpiration || state.expiration || professional.actualExpiration);
  if (timeframe !== operationMode.timeframe || expiration !== operationMode.expiration) return null;

  const complete = (Array.isArray(state.candles) ? state.candles : []).filter(row =>
    [row?.open,row?.high,row?.low,row?.close].every(value => num(value) != null)
  );
  if (complete.length < 2) return null;

  const analytics = signal.analytics || {};
  const power = Number(direction === 'BUY' ? analytics.buyPower : analytics.sellPower) || 0;
  if (power < 50) return null;

  const rawTargetStart = num(signal.targetStart ?? state.decisionCycle?.targetStart);
  if (rawTargetStart == null) return null;
  const targetStart = performanceTargetBucket(rawTargetStart, operationMode.timeframe);
  if (targetStart == null) return null;

  const shadow = shadowMeasurements(state, direction);
  const thresholds = getThresholds(state.analystPreferences?.sensitivityProfile || 'MEDIO');
  const emittedAt = Date.now();
  const score = num(professional.score ?? signal.analysisScore ?? signal.score) ?? 0;
  const secondsRemaining = num(professional.secondsRemaining ?? signal.secondsRemaining ?? clock.secondsRemaining);
  const referencePrice = num(state.price);
  const id = [marketId(state.asset), operationMode.timeframe, Number(targetStart), direction].join('|');

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
    timeframe: operationMode.timeframe,
    expiration: operationMode.expiration,
    mode: operationMode.timeframe,
    profile: thresholds.label,
    profileKey: thresholds.profile,
    confirmation: clean(state.analystPreferences?.confirmationMode).toUpperCase() === 'EXIGENTE' ? 'EXIGENTE' : 'SIMPLES',
    targetStart: Number(targetStart),
    f_m5: shadow.f_m5,
    f_extremo: shadow.f_extremo,
    f_extremo_percentB: shadow.f_extremo_percentB,
    er_m1: shadow.er_m1,
    er_m5: shadow.er_m5,
    sugestao_timeframe: shadow.sugestao_timeframe,
    entryPrice: null,
    exitPrice: null,
    result: null,
    status: 'pending'
  };
}

function performanceFeedAdvancedPastTarget(candles = [], targetStart = 0, durationMs = 60_000) {
  const end = Number(targetStart || 0) + Number(durationMs || 60_000);
  return (Array.isArray(candles) ? candles : []).some(row => Number(candleTimestamp(row) || 0) >= end);
}

async function updateSignalPerformanceLedger(state = {}) {
  const emission = performanceEmission(state);
  const candles = Array.isArray(state.candles) ? state.candles : [];
  const stored = await storageLocalGet(SIGNAL_PERFORMANCE_KEY).catch(() => ({}));
  const current = stored?.[SIGNAL_PERFORMANCE_KEY];
  let rows = Array.isArray(current?.rows) ? current.rows.slice(-SIGNAL_PERFORMANCE_MAX) : [];
  let changed = false;

  if (emission) {
    const index = rows.findIndex(row => row?.id === emission.id);
    if (index < 0) {
      rows.push(emission);
      changed = true;
    } else if (rows[index]?.type === 'POSSIBLE' && emission.type === 'ENTER' && rows[index]?.status !== 'resolved') {
      rows[index] = { ...rows[index], ...emission };
      changed = true;
    }
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

    const rowMode = getOperationMode(row.mode || row.timeframe || 'M1');
    const durationMs = rowMode.durationSeconds * 1000;
    const target = performanceTargetBucket(row.targetStart, row.timeframe || row.mode || 'M1') ?? Number(row.targetStart || 0);
    const threeCandlesLater = target + durationMs * 3;
    const feedAdvancedThree = performanceFeedAdvancedPastTarget(candles, target, durationMs * 3);
    if (now >= threeCandlesLater && feedAdvancedThree) {
      const reason = diagnoseSignalOutcomePending(row, candles);
      if (row.resultPendingAfter3 !== true || row.resultPendingReason !== reason) {
        changed = true;
        return {
          ...row,
          resultPendingAfter3: true,
          resultPendingReason: reason,
          resultPendingCheckedAt: now
        };
      }
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
    emission?.type || null,
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
  return ['active', 'valid'].includes(status);
};

const utcDay = () => new Date().toISOString().slice(0, 10);
const USAGE_RETRY_MS = 15_000;
const USAGE_IN_FLIGHT_TIMEOUT_MS = 30_000;
const RETRYABLE_USAGE_ERRORS = new Set(['backend_unreachable', 'telemetry_unreachable', 'client_token_missing', 'request_timeout']);
const AUTHORITATIVE_LICENSE_ERRORS = new Set(['license_not_found', 'license_inactive', 'license_expired', 'device_limit_reached', 'device_locked']);

function signalAllowance(state = {}) {
  const license = state.license || {};
  const remainingTotal = license.remainingTotal;
  const remainingToday = license.remainingToday;
  if (remainingTotal != null && Number(remainingTotal) <= 0) return { allowed: false, reason: 'limite total de sinais do plano atingido' };
  // A cached zero only belongs to the server UTC usage day that produced it.
  // After rollover, allow the candidate to reach consumeSignal(), where the
  // backend refreshes/enforces the new day's allowance authoritatively.
  if (remainingToday != null && Number(remainingToday) <= 0 && clean(license.usageDay) === utcDay()) {
    return { allowed: false, reason: 'limite diário de sinais do plano atingido' };
  }
  return { allowed: true, reason: '' };
}

function blockEntrySignal(signal = {}, reason = 'limite de sinais atingido') {
  const text = `AGUARDAR — ${reason}. Renove ou ajuste seu plano para liberar novas entradas.`;
  return {
    ...signal,
    state: 'NO_TRADE',
    direction: null,
    diagnosis: 'WAIT',
    uiState: 'WAIT',
    provisional: false,
    phase: 'FINAL',
    reason: text,
    hint: text
  };
}

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
  if (!clock || clock.available === false || clock.verified !== true) return null;
  if (!EXACT_CLOCK_SOURCES.has(clean(clock.source))) return null;
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
      clockQuality: 'exact',
      feedQuality: Number(state.diagnostics?.acquisition?.feedQuality || 0)
    }
  };
}

function signalRecordId(asset, timeframe, targetStart, direction) {
  return [marketId(asset), clean(timeframe).toUpperCase(), Number(targetStart || 0), clean(direction).toUpperCase()].join('|');
}

function reconcileSignalHistory(state = {}, next = {}, snapshot = {}) {
  let rows = Array.isArray(state.signalHistory) ? state.signalHistory.slice(-99) : [];
  const created = [];
  const signal = next.signal || {};
  const direction = clean(signal.direction || next.decisionCycle?.direction).toUpperCase();
  const rawTargetStart = num(signal.targetStart ?? next.decisionCycle?.targetStart);
  const timeframe = normTf(snapshot.analysisTimeframe || snapshot.timeframe || signal.timeframe);
  const targetStart = rawTargetStart == null || !timeframe ? rawTargetStart : performanceTargetBucket(rawTargetStart, timeframe);
  const technicalConfirmed = signal.state === 'CONFIRM'
    || ['ENTER_BUY', 'ENTER_SELL'].includes(clean(signal.uiState).toUpperCase());
  const professional = state.professionalDecision || {};
  const professionalUi = clean(professional.uiState).toUpperCase();
  const professionalConfirmed = professional.actionable === true
    && ['ENTER_BUY', 'ENTER_SELL'].includes(professionalUi)
    && clean(professional.direction).toUpperCase() === direction;
  const confirmed = technicalConfirmed && professionalConfirmed;

  if (confirmed && ['BUY', 'SELL'].includes(direction) && targetStart != null && timeframe) {
    const id = signalRecordId(snapshot.asset, timeframe, targetStart, direction);
    if (!rows.some(row => row?.id === id)) {
      const record = {
        id,
        signalId: id,
        platformId: snapshot.platformId || next.platformId || state.platformId || 'casatrade',
        platformName: snapshot.platformName || next.platformName || state.platformName || 'CasaTrade',
        asset: snapshot.asset,
        timeframe,
        expiration: snapshot.expiration || snapshot.targetExpiration || null,
        direction,
        targetStart,
        score: num(signal.analysisScore ?? signal.score),
        setup: signal.setup || null,
        createdAt: Date.now(),
        entryPrice: null,
        exitPrice: null,
        result: null,
        status: 'pending',
        usageStatus: 'pending',
        usageAttempts: 0,
        usageRetryAt: 0,
        usageError: null,
        telemetryConfirmedAt: null
      };
      rows.push(record);
      created.push(record);
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
    created,
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
    getOperationMode(state.analystPreferences?.operationMode || 'M1').timeframe,
    clean(state.analystPreferences?.confirmationMode).toUpperCase() === 'EXIGENTE' ? 'EXIGENTE' : 'SIMPLES',
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

async function sendConfirmedSignalTelemetry(row = {}) {
  if (!row?.id || num(row.entryPrice) == null || row.telemetryConfirmedAt) return false;
  const sent = await telemetryEvent('signal_confirmed', {
    signalId: row.signalId || row.id,
    asset: row.asset,
    platformId: row.platformId || 'casatrade',
    platformName: row.platformName || 'CasaTrade',
    timeframe: row.timeframe,
    expiration: row.expiration || null,
    direction: row.direction,
    targetStart: row.targetStart,
    entryTime: row.entryTime ?? row.targetStart,
    entryPrice: row.entryPrice,
    score: row.score,
    setup: row.setup || null
  }).catch(() => ({ ok: false, error: 'telemetry_unreachable' }));
  if (!sent?.ok) return false;
  await updateScannerState(current => ({
    ...current,
    signalHistory: (Array.isArray(current.signalHistory) ? current.signalHistory : []).map(item =>
      item?.id === row.id ? { ...item, telemetryConfirmedAt: Date.now(), telemetryError: null } : item
    )
  })).catch(() => {});
  return true;
}

async function runCentralAnalysis(force = false) {
  if (analysisRunning) {
    scheduleAnalysis(force);
    return;
  }
  analysisRunning = true;
  let needsConfirmationFollowup = false;
  let resolvedForTelemetry = [];
  let confirmedForUsage = [];
  let confirmedForTelemetry = [];
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
        getOperationMode(current.analystPreferences?.operationMode || 'M1').timeframe,
        Number(focus.frameId ?? -1),
        clean(focus.frameHost).toLowerCase()
      ].join('|');
      if (lastMarketKey && lastMarketKey !== marketKey) resetOrchestrator();
      lastMarketKey = marketKey;

      let processed = processSnapshot(snapshot, current);
      const allowance = signalAllowance(current);
      const processedUi = clean(processed?.signal?.uiState).toUpperCase();
      const processedConfirmed = processed?.signal?.state === 'CONFIRM' || processedUi === 'ENTER_BUY' || processedUi === 'ENTER_SELL';
      if (processedConfirmed && !allowance.allowed) {
        processed = {
          ...processed,
          signal: blockEntrySignal(processed.signal, allowance.reason),
          decisionCycle: {
            ...(processed.decisionCycle || {}),
            locked: 'WAIT',
            reason: allowance.reason
          }
        };
      }
      const confirmationMode = clean(current.analystPreferences?.confirmationMode).toUpperCase() === 'EXIGENTE' ? 'EXIGENTE' : 'SIMPLES';
      lastInputSignature = inputSignature;
      lastRunAt = Date.now();
      revision += 1;

      const next = {
        ...current,
        ...processed,
        signal: processed?.signal ? { ...processed.signal, confirmationMode } : processed?.signal,
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
      const usageNow = Date.now();
      confirmedForUsage = history.rows.filter(row => {
        const status = clean(row?.usageStatus).toLowerCase();
        const retryReady = ['pending', 'retry'].includes(status) && usageNow >= Number(row?.usageRetryAt || 0);
        const staleInFlight = status === 'in_flight' && usageNow - Number(row?.usageStartedAt || 0) >= USAGE_IN_FLIGHT_TIMEOUT_MS;
        return retryReady || staleInFlight;
      });
      confirmedForTelemetry = history.rows.filter(row =>
        clean(row?.usageStatus).toLowerCase() === 'consumed'
        && num(row?.entryPrice) != null
        && !row?.telemetryConfirmedAt
      );
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

  for (const row of confirmedForUsage) {
    let claimed = false;
    await updateScannerState(current => {
      const now = Date.now();
      const rows = (Array.isArray(current.signalHistory) ? current.signalHistory : []).map(item => {
        if (item?.id !== row.id) return item;
        const status = clean(item?.usageStatus).toLowerCase();
        const retryReady = ['pending', 'retry'].includes(status) && now >= Number(item?.usageRetryAt || 0);
        const staleInFlight = status === 'in_flight' && now - Number(item?.usageStartedAt || 0) >= USAGE_IN_FLIGHT_TIMEOUT_MS;
        if (!retryReady && !staleInFlight) return item;
        claimed = true;
        return {
          ...item,
          usageStatus: 'in_flight',
          usageStartedAt: now,
          usageRetryAt: 0,
          usageError: null,
          usageAttempts: Number(item.usageAttempts || 0) + 1
        };
      });
      return claimed ? { ...current, signalHistory: rows, performance: signalPerformance(rows) } : current;
    }).catch(() => {});
    if (!claimed) continue;

    const { settings = {} } = await storageLocalGet('settings').catch(() => ({}));
    const usage = await consumeSignal(settings, row.signalId || row.id).catch(() => ({ ok: false, error: 'backend_unreachable' }));
    let consumedRow = null;
    if (usage?.license || usage?.ok) {
      await updateScannerState(current => {
        const rows = (Array.isArray(current.signalHistory) ? current.signalHistory : []).map(item => {
          if (item?.id !== row.id) return item;
          const nextRow = usage?.ok
            ? { ...item, usageStatus: 'consumed', usageStartedAt: 0, usageRetryAt: 0, usageError: null, usageConsumedAt: Date.now(), usageDuplicate: usage?.duplicate === true }
            : item;
          if (usage?.ok) consumedRow = nextRow;
          return nextRow;
        });
        return {
          ...current,
          signalHistory: rows,
          performance: signalPerformance(rows),
          license: usage?.license ? {
            ...(current.license || {}),
            ...usage.license,
            error: usage.ok ? null : (usage.error || current.license?.error || null),
            syncPending: usage.ok ? false : RETRYABLE_USAGE_ERRORS.has(clean(usage.error).toLowerCase())
          } : current.license
        };
      }).catch(() => {});
    }

    if (usage?.ok) {
      if (consumedRow && num(consumedRow.entryPrice) != null) await sendConfirmedSignalTelemetry(consumedRow);
    } else if (usage?.error === 'daily_limit_reached' || usage?.error === 'trial_limit_reached') {
      await updateScannerState(current => {
        const currentSignal = current.signal || {};
        const sameSignal = sameMarket(current.asset, row.asset)
          && clean(currentSignal.direction).toUpperCase() === clean(row.direction).toUpperCase()
          && Number(currentSignal.targetStart || current.decisionCycle?.targetStart || 0) === Number(row.targetStart || 0);
        const rows = (Array.isArray(current.signalHistory) ? current.signalHistory : []).filter(item => item?.id !== row.id);
        return {
          ...current,
          signal: sameSignal ? blockEntrySignal(currentSignal, 'limite de sinais do plano atingido') : currentSignal,
          signalHistory: rows,
          performance: signalPerformance(rows),
          diagnostics: {
            ...(current.diagnostics || {}),
            usageGate: { blocked: true, error: usage.error, at: Date.now() }
          }
        };
      }).catch(() => {});
    } else if (RETRYABLE_USAGE_ERRORS.has(clean(usage?.error).toLowerCase())) {
      const retryAt = Date.now() + USAGE_RETRY_MS;
      await updateScannerState(current => ({
        ...current,
        signalHistory: (Array.isArray(current.signalHistory) ? current.signalHistory : []).map(item =>
          item?.id === row.id ? {
            ...item,
            usageStatus: 'retry',
            usageStartedAt: 0,
            usageRetryAt: retryAt,
            usageError: usage?.error || 'backend_unreachable'
          } : item
        ),
        diagnostics: {
          ...(current.diagnostics || {}),
          usageGate: { blocked: false, retryPending: true, error: usage?.error || 'backend_unreachable', retryAt, at: Date.now() }
        }
      })).catch(() => {});
      setTimeout(() => scheduleAnalysis(true), USAGE_RETRY_MS + 250);
    } else {
      await updateScannerState(current => ({
        ...current,
        signalHistory: (Array.isArray(current.signalHistory) ? current.signalHistory : []).map(item =>
          item?.id === row.id ? {
            ...item,
            usageStatus: 'failed',
            usageStartedAt: 0,
            usageRetryAt: 0,
            usageError: usage?.error || 'usage_failed'
          } : item
        ),
        diagnostics: {
          ...(current.diagnostics || {}),
          usageGate: { blocked: true, error: usage?.error || 'usage_failed', at: Date.now() }
        }
      })).catch(() => {});
    }
  }

  for (const row of confirmedForTelemetry) await sendConfirmedSignalTelemetry(row);

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

async function blockRuntimeForLicense(error = 'license_required', serverLicense = null) {
  resetOrchestrator();
  await updateScannerState(current => ({
    ...current,
    scanner: 'idle',
    connection: 'offline',
    signal: null,
    professionalDecision: null,
    tradeIntent: null,
    decisionCycle: null,
    asset: null,
    price: null,
    candles: [],
    currentCandle: null,
    marketHistory: {},
    expiration: null,
    targetExpiration: null,
    license: {
      ...(current.license || {}),
      ...(serverLicense || {}),
      status: error === 'license_expired' ? 'expired' : error === 'device_locked' || error === 'device_limit_reached' ? 'device_locked' : 'unconfigured',
      error,
      syncPending: false
    },
    diagnostics: {
      ...(current.diagnostics || {}),
      access: { state: 'license_required', ownerDev: false, error, at: Date.now() },
      acquisition: { stage: 'license_blocked', reason: `Acesso bloqueado: ${error}`, at: Date.now() }
    }
  })).catch(() => {});
}

const HEARTBEAT_INTERVAL_MS = 5000;
let heartbeatBusy = false;
let lastHeartbeatAt = 0;

async function pushLiveHeartbeat(state = {}) {
  if (heartbeatBusy || !activeAccess(state) || state.connection !== 'online') return;
  const now = Date.now();
  if (now - lastHeartbeatAt < HEARTBEAT_INTERVAL_MS) return;
  lastHeartbeatAt = now;
  heartbeatBusy = true;
  try {
    const { settings = {} } = await storageLocalGet('settings').catch(() => ({}));
    let result = await telemetryHeartbeat(state, settings).catch(() => ({ ok: false, error: 'telemetry_unreachable' }));
    if (!result?.ok && (result?.error === 'client_token_missing' || result?.error === 'client_token_invalid' || result?.status === 401)) {
      const refreshed = await validateLicense(settings, { forceServer: true }).catch(() => null);
      if (refreshed?.ok && refreshed?.license) {
        const refreshedState = await updateScannerState(current => ({
          ...current,
          license: {
            ...(current.license || {}),
            ...refreshed.license,
            status: 'active',
            error: null,
            syncPending: false
          }
        })).catch(() => state);
        result = await telemetryHeartbeat(refreshedState || state, settings).catch(() => result);
      } else {
        const error = clean(refreshed?.error).toLowerCase();
        if (AUTHORITATIVE_LICENSE_ERRORS.has(error)) {
          await blockRuntimeForLicense(error, refreshed?.license || null);
          return;
        }
      }
    }
  } finally {
    heartbeatBusy = false;
  }
}

function observeState(state = {}) {
  pushLiveHeartbeat(state).catch(() => {});
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

setInterval(() => {
  readScannerState().then(state => pushLiveHeartbeat(state)).catch(() => {});
}, HEARTBEAT_INTERVAL_MS);

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
    && clock.verified === true
    && clock.role === 'candle-close'
    && EXACT_CLOCK_SOURCES.has(clean(clock.source))
    && sameMarket(clock.asset, state.asset)
    && clockBoundToFocus(clock, focus)
    && Number.isFinite(Number(clock.secondsRemaining))
    && Number(clock.at || 0) > 0
    && Date.now() - Number(clock.at) < CLOCK_FRESH_MS;
  if (!clockFresh) gaps.push('countdown exato');
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

