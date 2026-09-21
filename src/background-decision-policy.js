import { readScannerState, updateScannerState } from './services/scanner-state-atomic.js';
import { getThresholds, getOperationMode } from './core/analysis.js';

// Product policy layer. The technical engine can keep collecting evidence with an
// estimated clock, but the user-facing decision is never promoted while CasaTrade
// time is not authoritative. This also owns Normal/A+ confluence and the stable hold.
const EXACT_CLOCK_SOURCES = new Set(['trader-dom-countdown', 'network-server-cycle']);
const CLOCK_FRESH_MS = 3000;
const FOCUS_FRESH_MS = 5500;
const DEFAULT_PREFS = Object.freeze({ mode: 'NORMAL', geminiEnabled: true, sensitivityProfile: 'MEDIO', operationMode: 'M1', preferredExpiration: null });

const num = value => value == null || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null;
const text = value => String(value ?? '').trim();
const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value) || 0));
const marketId = value => {
  const raw = text(value).normalize('NFKC').toUpperCase().replace(/\s+/g, ' ');
  if (!raw) return '';
  const otc = /(?:\(|\b|[_-])OTC(?:\)|\b)?/i.test(raw);
  const pair = raw.match(/\b([A-Z0-9]{2,20})\s*[\/_-]\s*([A-Z0-9]{2,12})/i);
  return pair ? `${pair[1]}/${pair[2]}${otc ? ' (OTC)' : ''}` : raw;
};
const sameMarket = (a, b) => !!marketId(a) && marketId(a) === marketId(b);
const clockBoundToFocus = (clock = {}, focus = {}) => {
  const sameFrame = Number(clock.frameId) === Number(focus.frameId)
    && text(clock.frameHost).toLowerCase() === text(focus.frameHost).toLowerCase();
  const boundControlFrame = clock.crossFrameControl === true
    && Number(clock.boundFocusFrameId) === Number(focus.frameId)
    && text(clock.boundFocusFrameHost).toLowerCase() === text(focus.frameHost).toLowerCase();
  return sameFrame || boundControlFrame;
};
const normTf = value => {
  const raw = text(value).toUpperCase().replace(/\s+/g, '');
  let match = raw.match(/^([SMH])(\d{1,5})$/);
  if (match && Number(match[2]) > 0) return `${match[1]}${Number(match[2])}`;
  match = raw.match(/^(\d{1,4})(?:M|MIN)$/);
  if (match && Number(match[1]) > 0) return `M${Number(match[1])}`;
  match = raw.match(/^(\d{1,5})S$/);
  if (match && Number(match[1]) > 0) return `S${Number(match[1])}`;
  return null;
};
const normExp = value => {
  const raw = text(value).toLowerCase().replace(/\s+/g, '');
  let match = raw.match(/^(\d{1,5})(?:s|seg|segundo|segundos)$/);
  if (match) return `${Number(match[1])}s`;
  match = raw.match(/^(\d{1,4})(?:m|min|minuto|minutos)$/);
  if (match) return `${Number(match[1]) * 60}s`;
  match = raw.match(/^(\d{1,3}):(\d{2})$/);
  if (match) return `${Number(match[1]) * 60 + Number(match[2])}s`;
  return null;
};

function preferences(state = {}) {
  const raw = state.analystPreferences || {};
  const thresholds = getThresholds(raw.sensitivityProfile || DEFAULT_PREFS.sensitivityProfile);
  const operationMode = getOperationMode(raw.operationMode || DEFAULT_PREFS.operationMode);
  return {
    mode: 'NORMAL',
    geminiEnabled: raw.geminiEnabled !== false,
    operationMode: operationMode.timeframe,
    operation: operationMode,
    sensitivityProfile: thresholds.profile,
    sensitivityLabel: thresholds.label,
    thresholds,
    holdSeconds: thresholds.holdSeconds,
    preferredExpiration: null
  };
}

function focusReady(state = {}) {
  const focus = state.diagnostics?.focusedAsset || null;
  if (!focus?.asset || !state.asset) return false;
  return focus.reliable === true
    && focus.chartScoped === true
    && focus.trustedChartFrame === true
    && (focus.embeddedTrader === true || focus.casaTradeFrame === true)
    && sameMarket(focus.asset, state.asset)
    && Number(focus.at || 0) > 0
    && Date.now() - Number(focus.at) < FOCUS_FRESH_MS;
}

export function exactCasaTradeTime(state = {}) {
  const focus = state.diagnostics?.focusedAsset || null;
  const clock = state.diagnostics?.marketClock || null;
  if (!focusReady(state) || !clock) return { ready: false, reason: 'Ativo/gráfico ainda não confirmado.' };
  if (clock.available === false || clock.verified !== true || clock.role !== 'candle-close') {
    return { ready: false, reason: 'Relógio exato da vela ainda não foi confirmado.' };
  }
  if (!EXACT_CLOCK_SOURCES.has(text(clock.source))) return { ready: false, reason: 'Fonte de tempo não autoritativa.' };
  if (!sameMarket(clock.asset, state.asset)) return { ready: false, reason: 'Relógio pertence a outro ativo.' };
  if (!clockBoundToFocus(clock, focus)) return { ready: false, reason: 'Relógio ainda não foi vinculado ao gráfico ativo.' };
  if (Date.now() - Number(clock.at || 0) >= CLOCK_FRESH_MS) return { ready: false, reason: 'Relógio da CasaTrade ficou desatualizado.' };
  if (num(clock.secondsRemaining) == null) return { ready: false, reason: 'Countdown da CasaTrade indisponível.' };

  const operationMode = getOperationMode(state.analystPreferences?.operationMode || 'M1');
  const liveTf = normTf(clock.timeframe);
  const stateTf = normTf(state.analysisTimeframe || state.timeframe);
  const controlTf = normTf(state.platformControls?.observed?.timeframe);
  if (!liveTf) return { ready: false, reason: 'Timeframe real ainda não foi confirmado.' };
  if (liveTf !== operationMode.timeframe) return { ready: false, reason: `Ajuste o timeframe da CasaTrade para ${operationMode.timeframe}.` };
  if (stateTf && liveTf !== stateTf) return { ready: false, reason: 'Timeframe interno divergiu do gráfico.' };
  if (controlTf && liveTf !== controlTf) return { ready: false, reason: 'Timeframe visível divergiu do clock da vela.' };
  return { ready: true, timeframe: liveTf, secondsRemaining: Number(clock.secondsRemaining), source: clock.source, operationMode: operationMode.timeframe };
}

export function CasaTradeExpiration(state = {}, timeframe = null) {
  const operationMode = getOperationMode(state.analystPreferences?.operationMode || 'M1');
  const controls = state.platformControls || {};
  const expirationAt = Number(controls.expirationCheckedAt || controls.observed?.observedAt?.expiration || 0);
  const fresh = expirationAt > 0 && Date.now() - expirationAt < 7000;
  const observed = fresh ? normExp(controls.observed?.expiration) : null;
  const startedAt = Number(state.diagnostics?.marketSession?.startedAt || state.diagnostics?.target?.connectedAt || 0);
  const waiting = startedAt > 0 && Date.now() - startedAt < 5000;
  const expirationLabel = operationMode.expiration === '300s' ? '5 minutos' : '1 minuto';
  if (!observed || !fresh) return {
    ready: false,
    actual: null,
    required: operationMode.expiration,
    reason: waiting
      ? 'Lendo expiração real da CasaTrade'
      : 'Não foi possível ler a expiração — informe a expiração no campo do topo do painel'
  };
  if (normTf(timeframe || state.analysisTimeframe || state.timeframe) === operationMode.timeframe && observed !== operationMode.expiration) {
    return { ready: false, actual: observed, required: operationMode.expiration, reason: `Ajuste a expiração da CasaTrade para ${expirationLabel}` };
  }
  return { ready: true, actual: observed, required: operationMode.expiration, reason: `Expiração de ${expirationLabel} confirmada para o modo ${operationMode.timeframe}.` };
}

function completeCandles(state = {}) {
  return (Array.isArray(state.candles) ? state.candles : []).filter(row =>
    [row?.open, row?.high, row?.low, row?.close].every(value => num(value) != null)
  );
}

function signalDirection(signal = {}) {
  const ui = text(signal.uiState).toUpperCase();
  if (ui.includes('BUY')) return 'BUY';
  if (ui.includes('SELL')) return 'SELL';
  const direction = text(signal.analysisDirection || signal.direction).toUpperCase();
  return ['BUY', 'SELL'].includes(direction) ? direction : null;
}

function confluence(signal = {}, direction = null, thresholds = getThresholds()) {
  if (!direction) return { count: 0, factors: [] };
  const a = signal.analytics || {};
  const factors = [];
  const power = Number(direction === 'BUY' ? a.buyPower : a.sellPower) || 0;
  if (power >= 50) factors.push(direction === 'BUY' ? 'poder comprador' : 'poder vendedor');
  if (Number(a.currentStrength || 0) >= thresholds.candleStrength) factors.push('força da vela');
  if (text(a.rejectionDirection).toUpperCase() === direction && Number(a.rejectionStrength || 0) >= thresholds.rejectionStrength) factors.push('rejeição');
  if (text(a.continuationDirection).toUpperCase() === direction && Number(a.continuationScore || 0) >= 60) factors.push('continuação');
  if (text(a.momentumDirection).toUpperCase() === direction && Number(a.momentumScore || 0) >= 45) factors.push('momentum');
  const setup = text(signal.setup).toLowerCase();
  if (/romp|breakout|support|resist|suporte|resistência|resistencia/.test(setup)) factors.push('estrutura');
  return { count: new Set(factors).size, factors: [...new Set(factors)] };
}

function shortReason(direction, factors = [], fallback = '') {
  if (factors.length >= 2) {
    const labels = factors.slice(0, 2).join(' + ');
    return `${labels.charAt(0).toUpperCase()}${labels.slice(1)} alinhados para ${direction === 'BUY' ? 'compra' : 'venda'}.`;
  }
  const cleanFallback = text(fallback).replace(/^Aguardando\s+/i, '').replace(/\.$/, '');
  return cleanFallback ? `${cleanFallback}.` : 'Confluência técnica ainda insuficiente.';
}

function cycleKey(state = {}, signal = {}) {
  // The orchestrator already owns a stable candle-cycle key. Reuse it here so
  // possibleSince/hold cannot restart when signal.targetStart jitters by a few
  // hundred milliseconds as the live countdown updates.
  const technicalCycleKey = text(state.decisionCycle?.key);
  if (technicalCycleKey) return technicalCycleKey;

  const asset = marketId(state.asset || '');
  const timeframe = normTf(state.analysisTimeframe || state.timeframe || signal.timeframe) || 'UNCONFIRMED';
  const target = num(state.diagnostics?.marketClock?.closeAt) ?? num(state.decisionCycle?.targetStart) ?? num(signal.targetStart);
  return `${asset}|${timeframe}|${target == null ? 'pending' : Math.round(target / 1000) * 1000}`;
}

function baseDecision(state = {}) {
  const pref = preferences(state);
  const signal = state.signal || {};
  const now = Date.now();
  const time = exactCasaTradeTime(state);
  const expiration = CasaTradeExpiration(state, time.timeframe || state.analysisTimeframe || state.timeframe);
  const rows = completeCandles(state);
  const direction = signalDirection(signal);
  const score = Number(signal.analysisScore ?? signal.score ?? 0) || 0;
  const ui = text(signal.uiState).toUpperCase();
  const cycle = cycleKey(state, signal);
  const factors = confluence(signal, direction, pref.thresholds);
  // NORMAL already passed the technical engine's own quality gates. Requiring
  // another independent confluence count here was suppressing valid POSSIBLE/
  // ENTER decisions and leaving the product stuck on AGUARDAR. Only A+ applies
  // this extra presentation-policy filter.
  const additionalConfluenceReady = true;
  const possibleScore = pref.thresholds.possibleScore;
  const finalScore = pref.thresholds.finalScore;
  const entryWindowSeconds = pref.thresholds.entryWindowSeconds;
  const preSignalWindowSeconds = pref.operation.timeframe === 'M5' ? 90 : 30;
  const rawDirectionalPower = Number(direction === 'BUY' ? signal.analytics?.buyPower : signal.analytics?.sellPower) || 0;
  const technicalCandidate = ['POSSIBLE_BUY', 'POSSIBLE_SELL', 'ENTER_BUY', 'ENTER_SELL'].includes(ui);
  const technicalFinal = ['ENTER_BUY', 'ENTER_SELL'].includes(ui);
  const previous = state.professionalDecision || {};
  const previousUi = text(previous.uiState).toUpperCase();
  const sameCandidate = previous.cycleKey === cycle
    && previous.direction === direction
    && ['POSSIBLE_BUY','POSSIBLE_SELL','ENTER_BUY','ENTER_SELL'].includes(previousUi);
  const continuityActive = technicalCandidate && sameCandidate;

  // The technical orchestrator owns candidate hysteresis. While it still says
  // POSSÍVEL for the same candle/direction, a single weak live tick must not
  // make this presentation policy independently erase the score/power and
  // restart hold. Once the technical candidate actually drops, these values
  // immediately return to the raw live reading.
  const previousScore = Number(previous.score || 0);
  const previousPower = Number(previous.candidateBlockerPolicy?.effectiveDirectionalPower
    ?? previous.candidateBlockerPolicy?.directionalPower
    ?? 0);
  const effectiveScore = continuityActive ? Math.max(score, previousScore) : score;
  const effectiveDirectionalPower = continuityActive
    ? Math.max(rawDirectionalPower, previousPower)
    : rawDirectionalPower;
  const mandatoryPowerReady = effectiveDirectionalPower >= 50;

  const diagnosticCycleKey = state.decisionCycle?.key || cycle;
  const candidateBlockerPolicy = {
    cycleKey: diagnosticCycleKey,
    technicalCandidate,
    technicalFinal,
    mandatoryPowerReady,
    directionalPower: rawDirectionalPower,
    effectiveDirectionalPower,
    rawScore: score,
    effectiveScore,
    continuityActive,
    expirationReady: expiration.ready,
    timeReady: time.ready,
    secondsRemaining: time.secondsRemaining ?? num(state.diagnostics?.marketClock?.secondsRemaining),
    preSignalWindowSeconds,
    entryWindowSeconds,
    possibleScore,
    finalScore,
    secondsVsWindow: {
      insidePreSignal: Number.isFinite(Number(time.secondsRemaining)) && Number(time.secondsRemaining) <= preSignalWindowSeconds,
      insideEntryWindow: Number.isFinite(Number(time.secondsRemaining)) && Number(time.secondsRemaining) <= entryWindowSeconds,
      secondsRemaining: time.secondsRemaining ?? num(state.diagnostics?.marketClock?.secondsRemaining)
    }
  };

  const common = {
    profile: pref.mode,
    operationMode: pref.operationMode,
    sensitivityProfile: pref.sensitivityProfile,
    sensitivityLabel: pref.sensitivityLabel,
    holdSeconds: pref.holdSeconds,
    cycleKey: cycle,
    score: effectiveScore,
    confluence: factors.count,
    factors: factors.factors,
    timeReady: time.ready,
    expirationReady: expiration.ready,
    actualExpiration: expiration.actual || null,
    timeSource: time.source || null,
    timeframe: time.timeframe || normTf(state.analysisTimeframe || state.timeframe),
    secondsRemaining: time.secondsRemaining ?? num(state.diagnostics?.marketClock?.secondsRemaining),
    candidateBlockerPolicy,
    updatedAt: now
  };

  if (!state.asset || num(state.price) == null || !focusReady(state)) {
    return { ...common, uiState: 'ANALYZING_MARKET', direction: null, actionable: false, alert: 'silent', possibleSince: null, reason: 'Identificando o ativo e a cotação do gráfico atual.' };
  }
  if (rows.length < 2) {
    return { ...common, uiState: 'BUILDING_PATTERN', direction: null, actionable: false, alert: 'silent', possibleSince: null, reason: 'Montando o padrão com as velas reais da CasaTrade.' };
  }
  if (!time.ready) {
    return { ...common, uiState: 'WAIT', direction: null, actionable: false, alert: 'silent', possibleSince: null, reason: `AGUARDAR — ${time.reason}` };
  }

  const seconds = Number(time.secondsRemaining);
  if (!Number.isFinite(seconds) || seconds > preSignalWindowSeconds) {
    return { ...common, uiState: 'BUILDING_PATTERN', direction: null, actionable: false, alert: 'silent', possibleSince: null, reason: `Analisando a vela ${pref.operation.timeframe} atual. O pré-sinal abre por volta de ${preSignalWindowSeconds}s restantes.` };
  }
  if (seconds <= 0) {
    return { ...common, uiState: 'WAIT', direction: null, actionable: false, alert: 'silent', possibleSince: null, reason: 'AGUARDAR — fechamento da vela em andamento.' };
  }

  if (!technicalCandidate || !direction || effectiveScore < possibleScore || !mandatoryPowerReady || !additionalConfluenceReady) {
    return { ...common, uiState: 'WAIT', direction: null, actionable: false, alert: 'silent', possibleSince: null, reason: 'AGUARDAR — motor técnico ainda não liberou um candidato.' };
  }

  const possibleSince = sameCandidate && Number(previous.possibleSince || 0) > 0 ? Number(previous.possibleSince) : now;
  const holdMs = pref.holdSeconds * 1000;
  const heldFor = Math.max(0, now - possibleSince);
  const finalQuality = technicalFinal && effectiveScore >= finalScore && mandatoryPowerReady && additionalConfluenceReady;
  const reason = shortReason(direction, factors.factors, signal.reason);

  // Expiration is an execution gate, not a technical-analysis gate. Keep the
  // directional POSSIBLE state visible when the pattern exists, but never make
  // it actionable until the CasaTrade timing/expiration matches the active operation mode.
  if (!expiration.ready) {
    return {
      ...common,
      uiState: direction === 'BUY' ? 'POSSIBLE_BUY' : 'POSSIBLE_SELL',
      direction,
      actionable: false,
      alert: 'silent',
      possibleSince,
      holdRemainingMs: Math.max(0, holdMs - heldFor),
      reason: `${reason} BLOQUEADO — ${expiration.reason}.`
    };
  }

  if (seconds > entryWindowSeconds) {
    return {
      ...common,
      uiState: direction === 'BUY' ? 'POSSIBLE_BUY' : 'POSSIBLE_SELL',
      direction,
      actionable: false,
      alert: 'discrete',
      possibleSince,
      holdRemainingMs: Math.max(0, holdMs - heldFor),
      reason
    };
  }
  if (!finalQuality || heldFor < holdMs) {
    return {
      ...common,
      uiState: 'WAIT',
      direction: null,
      actionable: false,
      alert: 'silent',
      possibleSince,
      holdRemainingMs: Math.max(0, holdMs - heldFor),
      reason: `AGUARDAR — decisão final sem confirmação suficiente. ${reason}`
    };
  }

  return {
    ...common,
    uiState: direction === 'BUY' ? 'ENTER_BUY' : 'ENTER_SELL',
    direction,
    actionable: true,
    alert: 'strong',
    possibleSince,
    holdRemainingMs: 0,
    reason
  };
}

function signature(value = {}) {
  return JSON.stringify({
    uiState: value.uiState || null,
    direction: value.direction || null,
    actionable: !!value.actionable,
    profile: value.profile || null,
    operationMode: value.operationMode || null,
    sensitivityProfile: value.sensitivityProfile || null,
    sensitivityLabel: value.sensitivityLabel || null,
    holdSeconds: value.holdSeconds || null,
    cycleKey: value.cycleKey || null,
    score: value.score || 0,
    confluence: value.confluence || 0,
    factors: value.factors || [],
    timeReady: !!value.timeReady,
    expirationReady: !!value.expirationReady,
    actualExpiration: value.actualExpiration || null,
    timeSource: value.timeSource || null,
    timeframe: value.timeframe || null,
    secondsRemaining: value.secondsRemaining ?? null,
    possibleSince: value.possibleSince || null,
    holdRemainingBucket: value.holdRemainingMs == null ? null : Math.ceil(Number(value.holdRemainingMs) / 250),
    reason: value.reason || ''
  });
}

let writing = false;
async function evaluate(state = {}) {
  if (writing) return;
  const decision = baseDecision(state);
  if (signature(decision) === signature(state.professionalDecision || {})) return;
  writing = true;
  try {
    await updateScannerState(current => {
      const next = baseDecision(current);
      if (signature(next) === signature(current.professionalDecision || {})) return current;
      return { ...current, professionalDecision: next };
    });
  } finally {
    writing = false;
  }
}

chrome.storage?.onChanged?.addListener?.((changes, area) => {
  if (area !== 'local' || !changes.scannerState?.newValue) return;
  evaluate(changes.scannerState.newValue).catch(() => {});
});

setInterval(() => readScannerState().then(evaluate).catch(() => {}), 500);
readScannerState().then(evaluate).catch(() => {});
