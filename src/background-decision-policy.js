import { readScannerState, updateScannerState } from './services/scanner-state-atomic.js';
import { createScoreStabilizer } from './core/score-stability.js';
import { evaluateProfileEntryGate } from './core/profile-entry-gates.js';
import { getThresholds, getOperationMode, getSignalPolicy } from './core/analysis.js';
import { buildDecisionAudit, appendDecisionAudit } from './core/decision-audit.js';
import { createActiveSignalOperation, reconcileActiveSignalOperation, signalOperationHolds, operationDecision, sameOperationMarket } from './core/signal-operation.js';

// Product policy layer. The technical engine can keep collecting evidence with an
// estimated clock, but the user-facing decision is never promoted while CasaTrade
// time is not authoritative. This also owns Normal/A+ confluence and the stable hold.
const EXACT_CLOCK_SOURCES = new Set(['trader-dom-countdown', 'network-server-cycle']);
const CLOCK_FRESH_MS = 4500;
const FOCUS_FRESH_MS = 5500;
const ROLLOVER_ENTRY_GRACE_MS = 6500;
const CANDIDATE_JITTER_GRACE_MS = 5000;
const FINAL_CANDIDATE_HITS = 2;
const DEFAULT_PREFS = Object.freeze({ mode: 'NORMAL', geminiEnabled: true, sensitivityProfile: 'MEDIO', confirmationMode: 'SIMPLES', operationMode: 'M1', preferredExpiration: null });
const decisionScoreStabilizer = createScoreStabilizer({ alpha: 0.2, sampleIntervalMs: 650, maxPointsPerSecond: 8, maxGapMs: 12000 });



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
    confirmationMode: text(raw.confirmationMode || DEFAULT_PREFS.confirmationMode).toUpperCase() === 'EXIGENTE' ? 'EXIGENTE' : 'SIMPLES',
    thresholds,
    holdSeconds: thresholds.holdSeconds,
    preferredExpiration: null
  };
}

function focusReady(state = {}) {
  const focus = state.diagnostics?.focusedAsset || null;
  if (!focus?.asset || !state.asset) return false;
  const ambiguousPassive = Number(focus.ambiguityCount || 0) > 0
    && focus.explicit !== true
    && focus.interactionHint !== true;
  return focus.reliable === true
    && focus.chartScoped === true
    && focus.trustedChartFrame === true
    && focus.visualAuthority !== false
    && !ambiguousPassive
    && (focus.embeddedTrader === true || focus.casaTradeFrame === true)
    && sameMarket(focus.asset, state.asset)
    && Number(focus.at || 0) > 0
    && Date.now() - Number(focus.at) < FOCUS_FRESH_MS;
}

export function runningCasaTradeCountdown(state = {}, expectedTimeframe = null, now = Date.now()) {
  const clock = state.diagnostics?.marketClock || null;
  if (!clock || clock.available === false) return null;
  const operationMode = getOperationMode(state.analystPreferences?.operationMode || expectedTimeframe || state.analysisTimeframe || state.timeframe || 'M1');
  const expectedTf = normTf(expectedTimeframe || operationMode.timeframe) || operationMode.timeframe;
  const clockTf = normTf(clock.timeframe || expectedTf || state.analysisTimeframe || state.timeframe);
  const asset = marketId(state.asset || '');
  const focus = state.diagnostics?.focusedAsset || {};
  if (!asset || (clock.asset && !sameMarket(clock.asset, asset))) return null;
  if (focus.asset && !sameMarket(focus.asset, asset)) return null;
  if (clockTf && clockTf !== expectedTf) return null;

  const seconds = num(clock.secondsRemaining);
  const at = Number(clock.at || 0);
  const age = at > 0 ? now - at : Infinity;
  const tfMs = getOperationMode(clockTf || expectedTf).durationSeconds * 1000;
  const observedOpenAt = num(clock.openAt) ?? num(clock.candleOpenAt);
  const observedCloseAt = num(clock.closeAt) ?? num(clock.candleCloseAt);
  const openAt = observedOpenAt ?? (observedCloseAt != null ? observedCloseAt - tfMs : null);
  const closeAt = observedCloseAt ?? (observedOpenAt != null ? observedOpenAt + tfMs : null);
  const boundaryCurrent = closeAt != null && openAt != null
    && now >= openAt - 2000 && now <= closeAt + 1500
    && closeAt - now <= tfMs + 1500;
  const freshRunningCountdown = at > 0 && age >= -1500 && age < 6500
    && seconds != null && seconds >= 0 && seconds <= tfMs / 1000 + 2;
  if (!boundaryCurrent && !freshRunningCountdown) return null;

  const remaining = boundaryCurrent
    ? Math.max(0, (closeAt - now) / 1000)
    : Math.max(0, seconds - Math.max(0, age / 1000));
  return {
    ready: true,
    timeframe: expectedTf,
    secondsRemaining: remaining,
    source: text(clock.source || (clock.verified === true ? 'casatrade-exact-clock' : 'casatrade-running-countdown')),
    operationalFallback: clock.verified !== true || !EXACT_CLOCK_SOURCES.has(text(clock.source)),
    operationMode: expectedTf,
    projectedFromExact: clock.verified === true && age > 250,
    rolloverGrace: false,
    candleOpenAt: openAt,
    candleCloseAt: closeAt
  };
}

export function exactCasaTradeTime(state = {}) {
  const focus = state.diagnostics?.focusedAsset || null;
  const clock = state.diagnostics?.marketClock || null;
  const operationMode = getOperationMode(state.analystPreferences?.operationMode || 'M1');
  // A live, asset-bound candle countdown is usable even while its frame/source
  // verification metadata catches up. The user can see the CasaTrade countdown;
  // do not hold the decision engine in PENDENTE solely because metadata lags.
  const operationalCountdown = runningCasaTradeCountdown(state, operationMode.timeframe);
  if (operationalCountdown) return operationalCountdown;
  if (!focusReady(state)) return { ready: false, reason: 'Ativo/gráfico ainda não confirmado.' };
  const persistedCycle = state.decisionCycle || {};
  const persistedTarget = num(persistedCycle.targetStart);
  const persistedDirection = text(persistedCycle.direction).toUpperCase();
  const persistedAsset = text(persistedCycle.key).split('|')[0] || '';
  const rolloverGrace = persistedCycle.locked === 'ENTER'
    && ['BUY','SELL'].includes(persistedDirection)
    && sameMarket(persistedAsset, state.asset)
    && persistedTarget != null
    && Date.now() >= persistedTarget - 1500
    && Date.now() <= persistedTarget + ROLLOVER_ENTRY_GRACE_MS
    && (!persistedCycle.key || text(persistedCycle.key).split('|')[1]?.toUpperCase() === operationMode.timeframe);
  if (rolloverGrace) {
    return {
      ready: true,
      timeframe: operationMode.timeframe,
      secondsRemaining: Math.max(0, (persistedTarget + operationMode.durationSeconds * 1000 - Date.now()) / 1000),
      source: 'rollover-grace',
      operationMode: operationMode.timeframe,
      projectedFromExact: true,
      rolloverGrace: true,
      candleOpenAt: persistedTarget,
      candleCloseAt: persistedTarget + operationMode.durationSeconds * 1000
    };
  }
  if (!clock) return { ready: false, reason: 'Nenhuma fonte de tempo da vela está disponível.' };

  // The focused CasaTrade frame can publish a running candle countdown before
  // its source-verification metadata catches up. Use that fresh, frame-bound
  // candle clock; do not report PENDENTE when seconds are actually available.
  const liveTfFallback = normTf(clock.timeframe || state.analysisTimeframe || state.timeframe);
  const clockAtFallback = Number(clock.at || 0);
  const clockAgeFallback = clockAtFallback > 0 ? Date.now() - clockAtFallback : Infinity;
  const rawRemainingFallback = num(clock.secondsRemaining);
  const closeAtFallback = num(clock.closeAt) ?? num(clock.candleCloseAt);
  const openAtFallback = num(clock.openAt) ?? num(clock.candleOpenAt);
  const tfMsFallback = getOperationMode(liveTfFallback || operationMode.timeframe).durationSeconds * 1000;
  const boundaryFallback = closeAtFallback != null && openAtFallback != null
    && Date.now() >= openAtFallback - 2000 && Date.now() <= closeAtFallback + 1500
    && closeAtFallback - Date.now() <= tfMsFallback + 1500;
  const focusedCountdownAvailable = clock.available !== false
    && clock.role === 'candle-close'
    && sameMarket(clock.asset, state.asset)
    && clockBoundToFocus(clock, focus)
    && liveTfFallback === operationMode.timeframe
    && (clockAgeFallback >= 0 && clockAgeFallback < CLOCK_FRESH_MS || boundaryFallback)
    && (rawRemainingFallback != null && rawRemainingFallback >= 0 && rawRemainingFallback <= operationMode.durationSeconds + 1 || boundaryFallback);
  if (focusedCountdownAvailable) {
    const remaining = boundaryFallback
      ? Math.max(0, (closeAtFallback - Date.now()) / 1000)
      : Math.max(0, rawRemainingFallback - Math.max(0, clockAgeFallback / 1000));
    return {
      ready: true,
      timeframe: liveTfFallback,
      secondsRemaining: remaining,
      source: text(clock.source || 'focused-casatrade-countdown'),
      operationMode: operationMode.timeframe,
      projectedFromExact: clockAgeFallback > 250,
      rolloverGrace: false,
      candleOpenAt: openAtFallback,
      candleCloseAt: closeAtFallback
    };
  }

  if (clock.available === false || clock.role !== 'candle-close') {
    return { ready: false, reason: 'Relógio exato da vela ainda não foi confirmado.' };
  }
  if (clock.verified !== true || !EXACT_CLOCK_SOURCES.has(text(clock.source))) {
    return { ready: false, reason: 'Nenhuma fonte confiável de countdown da vela está disponível.' };
  }
  if (!sameMarket(clock.asset, state.asset)) return { ready: false, reason: 'Relógio pertence a outro ativo.' };
  if (!clockBoundToFocus(clock, focus)) return { ready: false, reason: 'Relógio ainda não foi vinculado ao gráfico ativo.' };
  const clockAt = Number(clock.at || 0);
  const clockAgeMs = Date.now() - clockAt;
  const nowMs = Date.now();
  const rawRemaining = num(clock.secondsRemaining);
  const closeAt = num(clock.closeAt) ?? num(clock.candleCloseAt);
  const openAt = num(clock.openAt) ?? num(clock.candleOpenAt);
  const tfMs = getOperationMode(clock.timeframe || state.analysisTimeframe || state.timeframe).timeframe === 'M5' ? 300000 : 60000;
  const boundaryCurrent = closeAt != null && openAt != null
    && nowMs >= openAt - 2000 && nowMs <= closeAt + 1500
    && closeAt - nowMs <= tfMs + 1500;
  if (clockAgeMs >= CLOCK_FRESH_MS && !boundaryCurrent && !rolloverGrace) return { ready: false, reason: 'Relógio da CasaTrade ficou desatualizado.' };
  if (rawRemaining == null && !boundaryCurrent && !rolloverGrace) return { ready: false, reason: 'Countdown da CasaTrade indisponível.' };

  const liveTf = normTf(clock.timeframe);
  const stateTf = normTf(state.analysisTimeframe || state.timeframe);
  const controlTf = normTf(state.platformControls?.observed?.timeframe);
  if (!liveTf) return { ready: false, reason: 'Timeframe real ainda não foi confirmado.' };
  if (liveTf !== operationMode.timeframe) return { ready: false, reason: `Ajuste o timeframe da CasaTrade para ${operationMode.timeframe}.` };
  // The exact, focus-bound CasaTrade clock is the runtime authority. The
  // analysis/control fields are retained as telemetry only because they may
  // lag one update behind during a mode change or canvas re-render.
  // Bridge one missed DOM/feed observation with a bounded projection from the
  // latest exact CasaTrade sample. We never roll a decision into the next candle:
  // once projected time reaches zero the entry gate closes until a new exact sample.
  const projectedRemaining = boundaryCurrent
    ? Math.max(0, (closeAt - nowMs) / 1000)
    : Math.max(0, Number(rawRemaining) - Math.max(0, clockAgeMs / 1000));
  return {
    ready: true,
    timeframe: liveTf,
    secondsRemaining: projectedRemaining,
    source: clock.source,
    operationMode: operationMode.timeframe,
    projectedFromExact: rolloverGrace ? true : clockAgeMs > 250,
    rolloverGrace,
    candleOpenAt: num(clock.openAt),
    candleCloseAt: num(clock.closeAt)
  };
}

export function CasaTradeExpiration(state = {}, timeframe = null) {
  const operationMode = getOperationMode(state.analystPreferences?.operationMode || 'M1');
  const controls = state.platformControls || {};
  const guard = state.diagnostics?.expirationGuard || {};
  const expirationLabel = operationMode.expiration === '300s' ? '5 minutos' : '1 minuto';

  // Only a fresh, real CasaTrade observation may unlock execution. A manual
  // value is display/fallback context only and can never make a signal actionable.
  const guardAt = Number(guard.at || 0);
  const guardFresh = guardAt > 0 && Date.now() - guardAt < 10000;
  const guardActual = guardFresh ? normExp(guard.actual || controls.userDeclaredExpiration || '') : null;
  const guardSource = guardFresh ? text(guard.source || '') : '';
  const guardDivergence = guardFresh && guard.divergence === true;

  const realExpirationAt = Number(controls.realExpirationAt || 0);
  const realExpiration = normExp(controls.realExpiration || '');
  const declaredAt = Number(controls.userDeclaredAt || 0);
  const realFresh = !!realExpiration
    && realExpirationAt > 0
    && Date.now() - realExpirationAt < 15000
    && (!declaredAt || realExpirationAt >= declaredAt);
  const observedSource = text(controls.realExpirationSource || controls.expirationSource || controls.observed?.source || '');
  const actual = realFresh ? realExpiration : guardActual || null;
  const source = realFresh ? (text(controls.realExpirationSource) || 'casatrade-observed') : guardSource || '';
  const liveTf = normTf(timeframe || state.diagnostics?.marketClock?.timeframe || state.analysisTimeframe || state.timeframe);
  const observedExpirationSource = text(controls.observed?.sourceByField?.expiration || controls.observed?.source || '').toLowerCase();
  const manualRaw = controls.userDeclaredExpiration
    || state.executionPreferences?.expiration
    || state.analystPreferences?.preferredExpiration
    || (['user-declared', 'user-declared-match'].includes(observedExpirationSource) ? controls.observed?.expiration : '')
    || (['user-declared', 'user-declared-match'].includes(guardSource.toLowerCase()) ? guard.actual : '')
    || guard.userDeclared
    || '';
  const declaredManual = normExp(manualRaw);
  const manualModeMatch = !!declaredManual
    && declaredManual === operationMode.expiration
    && (!liveTf || liveTf === operationMode.timeframe);
  if (manualModeMatch) {
    return {
      ready: true,
      actual: declaredManual,
      required: operationMode.expiration,
      source: 'user-declared',
      verified: false,
      reason: operationMode.timeframe === 'M1'
        ? 'EXPIRAÇÃO MANUAL ACEITA – usando 1 min'
        : 'EXPIRAÇÃO MANUAL ACEITA – usando 5 min'
    };
  }

  if (guardDivergence) {
    return {
      ready: false,
      actual,
      required: operationMode.expiration,
      source,
      verified: guard.verified === true,
      reason: text(guard.reason || 'A expiração real da CasaTrade diverge do valor informado.')
    };
  }
  if (!realFresh) {
    const observedExpirationSource = text(
      controls.observed?.sourceByField?.expiration
        || controls.observed?.source
        || controls.expirationSource
        || ''
    );
    const observedManual = ['user-declared', 'user-declared-match'].includes(observedExpirationSource)
      ? normExp(controls.observed?.expiration || '')
      : null;
    const guardManual = guardFresh && ['user-declared', 'user-declared-match'].includes(guardSource)
      ? guardActual
      : null;
    const manual = normExp(controls.userDeclaredExpiration || observedManual || guardManual || '');
    const manualMatches = !!manual && manual === operationMode.expiration
      && (!liveTf || liveTf === operationMode.timeframe);
    if (manualMatches) {
      return {
        ready: true,
        actual: manual,
        required: operationMode.expiration,
        source: 'user-declared',
        verified: false,
        reason: `Expiração de ${expirationLabel} informada pelo usuário; usando fallback enquanto a CasaTrade não expõe a duração no DOM.`
      };
    }
    return {
      ready: false,
      actual: manual || null,
      required: operationMode.expiration,
      source: manual ? 'user-declared' : null,
      verified: false,
      reason: manual
        ? `Expiração de ${expirationLabel} informada, mas não coincide com o modo ativo`
        : 'Expiração real da CasaTrade ainda não confirmada'
    };
  }
  if (liveTf === operationMode.timeframe && actual !== operationMode.expiration) {
    return {
      ready: false,
      actual,
      required: operationMode.expiration,
      source,
      verified: realFresh && guard.verified === true,
      reason: `Ajuste a expiração da CasaTrade para ${expirationLabel}`
    };
  }
  const verified = realFresh && guard.verified === true && source !== 'user-declared';
  const declared = normExp(controls.userDeclaredExpiration || '');
  const declaredMatches = declared === operationMode.expiration
    && (!liveTf || liveTf === operationMode.timeframe);
  const observedMatches = actual === operationMode.expiration;
  const operationalFallback = observedMatches && declaredMatches;
  return {
    ready: (verified || operationalFallback) && observedMatches,
    actual,
    required: operationMode.expiration,
    source: verified ? source : (operationalFallback ? 'user-declared-match' : source),
    verified,
    reason: verified
      ? `Expiração de ${expirationLabel} confirmada pela CasaTrade para o modo ${operationMode.timeframe}.`
      : operationalFallback
        ? `Expiração de ${expirationLabel} coincide com o modo ativo; operação liberada enquanto a leitura direta da CasaTrade não é verificável.`
        : `Expiração de ${expirationLabel} ainda não verificada diretamente na CasaTrade.`
  };
}

function completeCandles(state = {}) {
  return (Array.isArray(state.candles) ? state.candles : []).filter(row =>
    [row?.open, row?.high, row?.low, row?.close].every(value => num(value) != null)
  );
}

function marketIdentity(state = {}, signal = {}) {
  const expected = marketId(state.asset || '');
  const focus = marketId(state.diagnostics?.focusedAsset?.asset || '');
  const session = state.diagnostics?.marketSession || {};
  const confirmed = marketId(session.confirmedAsset || '');
  const signalAsset = marketId(signal.asset || '');
  const candleAsset = marketId(state.currentCandle?.asset || '');
  const transitionMatches = session.transitioning === true
    && sameMarket(session.pendingAsset || session.asset || '', expected)
    && focus === expected;
  if (!expected || !focus || (!confirmed && !transitionMatches)) {
    return { ready: false, reason: 'Ativo visual, sessão e feed ainda não foram confirmados juntos.' };
  }
  const rows = [focus, signalAsset, candleAsset, ...(transitionMatches ? [] : [confirmed])].filter(Boolean);
  const mismatch = rows.find(value => value !== expected);
  if (mismatch) {
    return { ready: false, reason: `Bloqueio de segurança: gráfico ${focus || '—'}, sessão ${confirmed || '—'} e sinal ${signalAsset || expected} não pertencem ao mesmo ativo.` };
  }
  return { ready: true, asset: expected, transitionGrace: transitionMatches && confirmed !== expected };
}

function signalDirection(signal = {}) {
  const ui = text(signal.uiState).toUpperCase();
  if (ui.includes('BUY')) return 'BUY';
  if (ui.includes('SELL')) return 'SELL';
  const direct = text(signal.analysisDirection || signal.direction || signal.analytics?.professional?.direction || '').toUpperCase();
  if (['BUY', 'SELL'].includes(direct)) return direct;
  const a = signal.analytics || {};
  const continuation = text(a.continuationDirection).toUpperCase();
  const continuationReady = ['BUY','SELL'].includes(continuation) && Number(a.continuationScore || 0) >= 60;
  const breakout = text(a.breakoutDirection || (['BUY', 'SELL'].includes(text(a.breakout).toUpperCase()) ? a.breakout : '')).toUpperCase();
  if (['BUY','SELL'].includes(breakout)) return breakout;
  const rejection = text(a.rejectionDirection).toUpperCase();
  const rejectionPower = Math.max(
    Number(a.rejectionStrength || 0) || 0,
    Number(rejection === 'BUY' ? a.rejectionBuy : rejection === 'SELL' ? a.rejectionSell : 0) || 0
  );
  if (['BUY','SELL'].includes(rejection) && rejectionPower >= 45) return rejection;
  if (continuationReady) return continuation;
  if (a.pullbackContinuation?.qualified === true && ['BUY','SELL'].includes(text(a.pullbackContinuation.direction).toUpperCase())) {
    return text(a.pullbackContinuation.direction).toUpperCase();
  }
  const localIsAmbiguous = signal.recent?.lateral === true || signal.recent?.doji === true
    || a.lateral === true || a.doji === true
    || /lateral|doji|compressão/i.test(text(signal.reason || a.opinion || ''));
  if (localIsAmbiguous) return null;
  const buyPower = Number(a.buyPower || 0), sellPower = Number(a.sellPower || 0);
  if (Math.max(buyPower, sellPower) >= 45 && buyPower !== sellPower) return buyPower > sellPower ? 'BUY' : 'SELL';
  return null;
}

function confluence(signal = {}, direction = null, thresholds = getThresholds()) {
  if (!direction) return { count: 0, factors: [] };
  const a = signal.analytics || {};
  const factors = [];
  const power = Number(direction === 'BUY' ? a.buyPower : a.sellPower) || 0;
  if (power >= 45) factors.push(direction === 'BUY' ? 'poder comprador' : 'poder vendedor');
  if (Number(a.currentStrength || 0) >= thresholds.candleStrength) factors.push('força da vela');
  if (text(a.rejectionDirection).toUpperCase() === direction && Number(a.rejectionStrength || 0) >= thresholds.rejectionStrength) factors.push('rejeição');
  if (text(a.continuationDirection).toUpperCase() === direction && Number(a.continuationScore || 0) >= 60) factors.push('continuação');
  if (text(a.momentumDirection).toUpperCase() === direction && Number(a.momentumScore || 0) >= 45) factors.push('momentum');
  if (a.pullbackContinuation?.qualified === true && a.pullbackContinuation?.direction === direction) factors.push('pullback sem esticamento');
  const setup = text(signal.setup).toLowerCase();
  if (/romp|breakout|support|resist|suporte|resistência|resistencia/.test(setup)) factors.push('estrutura');
  if (a.professional?.contextReady === true) factors.push('contexto');
  if (a.professional?.triggerReady === true) factors.push('gatilho');
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
  const asset = marketId(state.asset || '');
  const timeframe = normTf(state.analysisTimeframe || state.timeframe || signal.timeframe) || 'UNCONFIRMED';
  const clock = state.diagnostics?.marketClock || {};
  // The active candle opening timestamp is immutable for the full cycle.
  // Never use closeAt/secondsRemaining as the decision-cycle identity.
  const target = num(clock.openAt)
    ?? num(clock.candleOpenAt)
    ?? num(signal.targetStart)
    ?? num(state.decisionCycle?.targetStart);
  return asset + '|' + timeframe + '|' + (target == null ? 'pending' : Math.round(target / 1000) * 1000);
}

function baseDecision(state = {}) {
  const pref = preferences(state);
  const signal = state.signal || {};
  const now = Date.now();
  const identity = marketIdentity(state, signal);
  const time = exactCasaTradeTime(state);
  const expiration = CasaTradeExpiration(state, time.timeframe || state.analysisTimeframe || state.timeframe);
  const rows = completeCandles(state);
  const direction = signalDirection(signal);
  const score = Number(signal.analysisScore ?? signal.score ?? 0) || 0;
  const ui = text(signal.uiState).toUpperCase();
  const cycle = cycleKey(state, signal);
  const displayScore = decisionScoreStabilizer.update({ key: cycle, rawScore: score, ready: identity.ready && rows.length >= 2, at: now });
  const profileGate = evaluateProfileEntryGate({ profile: pref.sensitivityProfile, direction, score, buyPower: signal.analytics?.buyPower, sellPower: signal.analytics?.sellPower, analytics: signal.analytics, secondsRemaining: time.secondsRemaining, timeframe: pref.operationMode });
  const sessionConnected = state.connection === 'online';
  const factors = confluence(signal, direction, pref.thresholds);
  const signalPolicy = getSignalPolicy(pref.sensitivityProfile);
  const pullbackPattern = signal.analytics?.pullbackContinuation || {};
  const pullbackCandidate = pullbackPattern.qualified === true
    && pullbackPattern.direction === direction
    && pullbackPattern.notStretched === true
    && Number(pullbackPattern.roomToLevel) >= 0.35
    && Number(pullbackPattern.score) >= 80;
  // The selected rhythm changes selectivity, but never bypasses context + trigger.
  const possibleScore = profileGate.possibleScore;
  const finalScore = profileGate.finalScore;
  const entryWindowSeconds = pref.operationMode === 'M1'
    ? 10
    : pref.operationMode === 'M5'
      ? 15
      : pref.thresholds.entryWindowSeconds;
  const preSignalWindowSeconds = 30;
  const directionalPower = profileGate.power;
  const mandatoryPowerReady = directionalPower >= 45;
  const finalPowerReady = directionalPower >= 45;
  const technicalCandidate = ['POSSIBLE_BUY', 'POSSIBLE_SELL', 'ENTER_BUY', 'ENTER_SELL'].includes(ui);
  const technicalFinal = ['ENTER_BUY', 'ENTER_SELL'].includes(ui);
  const professional = signal.analytics?.professional || {};
  const professionalContextReady = professional.contextReady === true;
  const professionalTriggerReady = professional.triggerReady === true;

  const persistedCycle = state.decisionCycle || {};
  const persistedTarget = num(persistedCycle.targetStart);
  const persistedDirection = text(persistedCycle.direction).toUpperCase();
  const persistedAsset = text(persistedCycle.key).split('|')[0] || '';
  const common = {
    profile: pref.mode,
    operationMode: pref.operationMode,
    sensitivityProfile: pref.sensitivityProfile,
    sensitivityLabel: pref.sensitivityLabel,
    confirmationMode: pref.confirmationMode,
    holdSeconds: pref.holdSeconds,
    cycleKey: cycle,
    score: displayScore,
    rawScore: score,
    confluence: factors.count,
    factors: factors.factors,
    professionalContextReady,
    professionalTriggerReady,
    professionalScoreBlocks: professional.blocks || null,
    signalPolicy,
    timeReady: time.ready,
    expirationReady: expiration.ready,
    actualExpiration: expiration.actual || null,
    timeSource: time.source || null,
    timeframe: time.timeframe || normTf(state.analysisTimeframe || state.timeframe),
    secondsRemaining: time.secondsRemaining ?? num(state.diagnostics?.marketClock?.secondsRemaining),
    pullbackContinuation: signal.analytics?.pullbackContinuation || null,
    patternConfidence: Number(signal.analytics?.pullbackContinuation?.score || 0),
    earlyPatternCandidate: pullbackCandidate,
    marketIdentityReady: identity.ready,
    marketIdentityReason: identity.reason || null,
    updatedAt: now
  };

  const activeOperation = reconcileActiveSignalOperation(state.activeSignalOperation, state.signalHistory || [], now);
  if (signalOperationHolds(activeOperation)
    && sameOperationMarket(activeOperation.asset, state.asset)
    && clean(activeOperation.timeframe).toUpperCase() === clean(time.timeframe || pref.operationMode).toUpperCase()) {
    return operationDecision(state, activeOperation, now, common);
  }

  const rolloverEntryActive = persistedCycle.locked === 'ENTER'
    && ['BUY','SELL'].includes(persistedDirection)
    && sameMarket(persistedAsset, state.asset)
    && persistedTarget != null
    && now >= persistedTarget - 1500
    && now <= persistedTarget + ROLLOVER_ENTRY_GRACE_MS
    && (!persistedCycle.key || text(persistedCycle.key).split('|')[1]?.toUpperCase() === pref.operationMode);
  if (rolloverEntryActive && expiration.ready) {
    return {
      ...common,
      uiState: persistedDirection === 'BUY' ? 'ENTER_BUY' : 'ENTER_SELL',
      direction: persistedDirection,
      actionable: true,
      alert: 'strong',
      possibleSince: Number(state.professionalDecision?.possibleSince || now),
      holdRemainingMs: 0,
      reason: persistedDirection === 'BUY'
        ? 'COMPRA — ALTA CONFIANÇA • ENTRAR NA VELA QUE ACABOU DE ABRIR.'
        : 'VENDA — ALTA CONFIANÇA • ENTRAR NA VELA QUE ACABOU DE ABRIR.'
    };
  }

  if (!identity.ready) {
    return { ...common, uiState: 'ANALYZING_MARKET', direction: null, actionable: false, alert: 'silent', possibleSince: null, reason: identity.reason };
  }
  if (!state.asset || num(state.price) == null || !focusReady(state)) {
    return { ...common, uiState: 'ANALYZING_MARKET', direction: null, actionable: false, alert: 'silent', possibleSince: null, reason: 'Identificando o ativo e a cotação do gráfico atual.' };
  }
  if (rows.length < 2) {
    return { ...common, uiState: 'BUILDING_PATTERN', direction: null, actionable: false, alert: 'silent', possibleSince: null, reason: 'Montando o padrão com as velas reais da CasaTrade.' };
  }
  if (!time.ready) {
    const canKeepProfileCandidate = profileGate.candidate && sessionConnected && identity.ready && focusReady(state) && expiration.ready;
    if (canKeepProfileCandidate) {
      const previousCandidate = state.professionalDecision || {};
      const sameCandidate = previousCandidate.cycleKey === cycle && previousCandidate.direction === direction
        && ['POSSIBLE_BUY','POSSIBLE_SELL','ENTER_BUY','ENTER_SELL'].includes(text(previousCandidate.uiState).toUpperCase());
      const side = direction === 'BUY' ? 'COMPRA' : 'VENDA';
      return {
        ...common, uiState: direction === 'BUY' ? 'POSSIBLE_BUY' : 'POSSIBLE_SELL', direction,
        actionable: false, alert: 'silent',
        possibleSince: sameCandidate && Number(previousCandidate.possibleSince || 0) > 0 ? Number(previousCandidate.possibleSince) : now,
        holdRemainingMs: 0,
        reason: 'POSSÍVEL ' + side + ' — perfil ' + pref.sensitivityProfile + ' atingido (score ' + Math.round(score) + ', poder ' + Math.round(directionalPower) + '%); aguardando sincronização do countdown (' + time.reason + ').'
      };
    }
    return { ...common, uiState: 'WAIT', direction: null, actionable: false, alert: 'silent', possibleSince: null, reason: 'AGUARDAR — ' + time.reason };
  }

  const seconds = Number(time.secondsRemaining);

  // Profile thresholds are the primary signal-volume control. The technical
  // engine may still label the sample WAIT/NO_TRADE while professional
  // context indicators catch up; a clear direction, score, power, matching
  // session, exact countdown and accepted expiration are the mandatory gate.
  const basicProfileCandidate = profileGate.candidate
    && sessionConnected
    && identity.ready
    && time.ready
    && expiration.ready
    && Number.isFinite(seconds)
    && seconds > 0
    && seconds <= preSignalWindowSeconds;
  if (basicProfileCandidate) {
    const previousProfile = state.professionalDecision || {};
    const previousProfileUi = text(previousProfile.uiState).toUpperCase();
    const sameProfileCandidate = previousProfile.cycleKey === cycle
      && previousProfile.direction === direction
      && ['POSSIBLE_BUY','POSSIBLE_SELL','ENTER_BUY','ENTER_SELL'].includes(previousProfileUi);
    const possibleSince = sameProfileCandidate && Number(previousProfile.possibleSince || 0) > 0
      ? Number(previousProfile.possibleSince) : now;
    const side = direction === 'BUY' ? 'COMPRA' : 'VENDA';
    if (seconds > entryWindowSeconds) {
      return {
        ...common,
        uiState: direction === 'BUY' ? 'POSSIBLE_BUY' : 'POSSIBLE_SELL',
        direction,
        actionable: false,
        alert: sameProfileCandidate ? 'silent' : 'discrete',
        possibleSince,
        finalCandidateHits: 0,
        holdRemainingMs: 0,
        reason: 'POSSÍVEL ' + side + ' — perfil ' + pref.sensitivityProfile
          + ' atingido (score ' + Math.round(score) + ', poder ' + Math.round(directionalPower)
          + '%). Expiração aceita; aguardando a janela final.'
      };
    }
    if (score >= finalScore && directionalPower >= 45 && ['BUY', 'SELL'].includes(direction)) {
      return {
        ...common,
        uiState: direction === 'BUY' ? 'ENTER_BUY' : 'ENTER_SELL',
        direction,
        actionable: true,
        alert: 'strong',
        possibleSince,
        finalCandidateHits: 2,
        holdRemainingMs: 0,
        reason: side + ' — DECISÃO FINAL • perfil ' + pref.sensitivityProfile
          + ' confirmado (score ' + Math.round(score) + ', poder ' + Math.round(directionalPower)
          + '%). Entrada MANUAL na próxima vela.'
      };
    }
    return {
      ...common,
      uiState: direction === 'BUY' ? 'POSSIBLE_BUY' : 'POSSIBLE_SELL',
      direction, actionable: false, alert: 'silent', possibleSince,
      finalCandidateHits: 0, holdRemainingMs: 0,
      reason: 'POSSÍVEL ' + side + ' — perfil atingido; aguardando score final ' + finalScore + '/100 na janela de decisão.'
    };
  }

  const anticipationWindow = pref.operationMode === 'M5' ? 120 : 45;
  if (pullbackCandidate
    && profileGate.candidate
    && sessionConnected
    && identity.ready
    && direction
    && time.ready
    && expiration.ready
    && Number.isFinite(seconds)
    && seconds > entryWindowSeconds
    && seconds <= anticipationWindow) {
    const side = direction === 'BUY' ? 'COMPRA' : 'VENDA';
    const room = Number(pullbackPattern.roomToLevel);
    const confidence = Math.round(Number(pullbackPattern.score || 0));
    return {
      ...common,
      uiState: direction === 'BUY' ? 'POSSIBLE_BUY' : 'POSSIBLE_SELL',
      direction,
      actionable: false,
      alert: 'discrete',
      possibleSince: Number(state.professionalDecision?.possibleSince || now),
      patternConfidence: confidence,
      earlyPatternCandidate: true,
      reason: `${side} — PADRÃO DE PULLBACK + RETOMADA (${confidence}/100) • possível entrada na próxima vela • ${room.toFixed(1)}× faixa média até o nível contrário • ${seconds}s restantes; confirmação final ainda necessária.`
    };
  }
  if (!Number.isFinite(seconds) || seconds > preSignalWindowSeconds) {
    return { ...common, uiState: 'BUILDING_PATTERN', direction: null, actionable: false, alert: 'silent', possibleSince: null, reason: `Analisando a vela ${pref.operation.timeframe} atual. O pré-sinal abre por volta de ${preSignalWindowSeconds}s restantes.` };
  }
  if (seconds <= 0) {
    return { ...common, uiState: 'WAIT', direction: null, actionable: false, alert: 'silent', possibleSince: null, reason: 'AGUARDAR — fechamento da vela em andamento.' };
  }

  const previous = state.professionalDecision || {};
  const previousUi = text(previous.uiState).toUpperCase();
  const previousDirection = text(previous.direction).toUpperCase();
  const previousAt = Number(previous.updatedAt || 0);
  const previousPossibleSince = Number(previous.possibleSince || 0);
  const previousCandidateSameCycle = previous.cycleKey === cycle
    && ['POSSIBLE_BUY','POSSIBLE_SELL','ENTER_BUY','ENTER_SELL'].includes(previousUi)
    && previousDirection === direction
    && previousAt > 0
    && now - previousAt <= CANDIDATE_JITTER_GRACE_MS
    && previousPossibleSince > 0;
  const holdMs = pref.holdSeconds * 1000;

  if (!professionalContextReady || !professionalTriggerReady) {
    if (previousCandidateSameCycle
      && technicalCandidate
      && direction
      && score >= possibleScore
      && mandatoryPowerReady
      && seconds > 0) {
      return {
        ...common,
        uiState: direction === 'BUY' ? 'POSSIBLE_BUY' : 'POSSIBLE_SELL',
        direction,
        actionable: false,
        alert: 'silent',
        possibleSince: previousPossibleSince,
        finalCandidateHits: Number(previous.finalCandidateHits || 0),
        holdRemainingMs: Math.max(0, holdMs - Math.max(0, now - previousPossibleSince)),
        reason: (direction === 'BUY' ? 'COMPRA' : 'VENDA') + ' — ALTA CONFIANÇA • candidato preservado durante oscilação momentânea do contexto/gatilho.'
      };
    }
    return { ...common, uiState: 'WAIT', direction: null, actionable: false, alert: 'silent', possibleSince: null, holdRemainingMs: 0, reason: 'AGUARDAR — tendência/contexto, região e gatilho ainda não estão confirmados juntos.' };
  }


  if (!direction || score < possibleScore || !mandatoryPowerReady) {
    if (previousCandidateSameCycle
      && direction === previousDirection
      && score >= Math.max(0, possibleScore - 8)
      && Number(signal.analytics?.[direction === 'BUY' ? 'buyPower' : 'sellPower'] || 0) >= 45
      && seconds > 0) {
      return {
        ...common,
        uiState: direction === 'BUY' ? 'POSSIBLE_BUY' : 'POSSIBLE_SELL',
        direction,
        actionable: false,
        alert: 'silent',
        possibleSince: previousPossibleSince,
        finalCandidateHits: Number(previous.finalCandidateHits || 0),
        holdRemainingMs: Math.max(0, holdMs - Math.max(0, now - previousPossibleSince)),
        reason: (direction === 'BUY' ? 'COMPRA' : 'VENDA') + ' — ALTA CONFIANÇA • candidato preservado durante uma leitura técnica transitória.'
      };
    }
    return { ...common, uiState: 'WAIT', direction: null, actionable: false, alert: 'silent', possibleSince: null, holdRemainingMs: 0, reason: 'AGUARDAR — motor técnico ainda não liberou um candidato.' };
  }

  const sameCandidate = previous.cycleKey === cycle && previous.direction === direction && ['POSSIBLE_BUY','POSSIBLE_SELL','ENTER_BUY','ENTER_SELL'].includes(previousUi);
  const technicalPossibleSince = Number(signal.stability?.possibleSince || 0);
  const technicalSinceValid = technicalPossibleSince > 0 && technicalPossibleSince <= now && now - technicalPossibleSince < 45000;
  // Seed the presentation hold from the technical candidate's stable lifetime.
  // A transient policy WAIT must not restart a 2s hold at 4..1s remaining.
  const possibleSince = sameCandidate && Number(previous.possibleSince || 0) > 0
    ? Number(previous.possibleSince)
    : technicalSinceValid ? technicalPossibleSince : now;
  const heldFor = Math.max(0, now - possibleSince);
  const candidateFinalReady = !!direction
    && score >= finalScore
    && finalPowerReady;
  const priorFinalHits = sameCandidate && previous.direction === direction
    ? Number(previous.finalCandidateHits || 0)
    : 0;
  const candidateFinalHits = candidateFinalReady
    ? Math.min(FINAL_CANDIDATE_HITS, priorFinalHits + 1)
    : 0;
  const finalQuality = (technicalFinal || candidateFinalHits >= FINAL_CANDIDATE_HITS)
    && candidateFinalReady;
  const reason = shortReason(direction, factors.factors, signal.reason);
  const side = direction === 'BUY' ? 'COMPRA' : 'VENDA';

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
      finalCandidateHits: candidateFinalHits,
      holdRemainingMs: Math.max(0, holdMs - heldFor),
      reason: `${side} — ALTA CONFIANÇA • PRÉ-SINAL • BLOQUEADO — ${expiration.reason}.`
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
      finalCandidateHits: candidateFinalHits,
      holdRemainingMs: Math.max(0, holdMs - heldFor),
      reason: `${side} — ALTA CONFIANÇA • PRÉ-SINAL • ${reason}`
    };
  }
  if (!finalQuality) {
    return {
      ...common,
      uiState: 'WAIT',
      direction: null,
      actionable: false,
      alert: 'silent',
      possibleSince: null,
      holdRemainingMs: 0,
      reason: `AGUARDAR — confiança final insuficiente para ${side.toLowerCase()}.`
    };
  }

  if (heldFor < holdMs) {
    return {
      ...common,
      uiState: direction === 'BUY' ? 'POSSIBLE_BUY' : 'POSSIBLE_SELL',
      direction,
      actionable: false,
      alert: 'discrete',
      possibleSince,
      holdRemainingMs: Math.max(0, holdMs - heldFor),
      reason: `${side} — ALTA CONFIANÇA • confirmação final recebida; estabilizando hold.`
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
    reason: `${side} — ALTA CONFIANÇA • ENTRAR NA PRÓXIMA VELA.`
  };
}

function operationSignature(value = null) {
  if (!value) return '';
  return JSON.stringify({
    id: value.id || null, status: value.status || null, asset: value.asset || null,
    timeframe: value.timeframe || null, direction: value.direction || null,
    targetStart: Number(value.targetStart || 0), targetEnd: Number(value.targetEnd || 0),
    candleOpenPrice: value.candleOpenPrice ?? null, candleClosePrice: value.candleClosePrice ?? null,
    result: value.result || null, resolvedAt: value.resolvedAt || null
  });
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
    confirmationMode: value.confirmationMode || null,
    holdSeconds: value.holdSeconds || null,
    cycleKey: value.cycleKey || null,
    score: value.score || 0,
    rawScore: value.rawScore || 0,
    confluence: value.confluence || 0,
    factors: value.factors || [],
    timeReady: !!value.timeReady,
    expirationReady: !!value.expirationReady,
    actualExpiration: value.actualExpiration || null,
    timeSource: value.timeSource || null,
    timeframe: value.timeframe || null,
    secondsRemaining: value.secondsRemaining ?? null,
    marketIdentityReady: value.marketIdentityReady !== false,
    marketIdentityReason: value.marketIdentityReason || null,
    possibleSince: value.possibleSince || null,
    holdRemainingBucket: value.holdRemainingMs == null ? null : Math.ceil(Number(value.holdRemainingMs) / 250),
    finalCandidateHits: value.finalCandidateHits || 0,
    pullbackContinuation: value.pullbackContinuation?.qualified === true ? value.pullbackContinuation.direction : null,
    patternConfidence: value.patternConfidence || 0,
    earlyPatternCandidate: !!value.earlyPatternCandidate,
    reason: value.reason || ''
  });
}

let writing = false;
async function evaluate(state = {}) {
  if (writing) return;
  const decision = baseDecision(state);
  const decisionChanged = signature(decision) !== signature(state.professionalDecision || {});
  const auditRow = buildDecisionAudit(state, decision);
  const auditNext = appendDecisionAudit(state.decisionAudit || {}, auditRow, 40);
  const auditChanged = auditNext !== (state.decisionAudit || null);
  const proposedOperation = createActiveSignalOperation(state, decision, Date.now());
  const operationMissing = !!proposedOperation
    && (!state.activeSignalOperation || state.activeSignalOperation.id !== proposedOperation.id);
  const operationNeedsReconcile = !!state.activeSignalOperation
    && state.activeSignalOperation.status !== 'COMPLETED';
  if (!decisionChanged && !auditChanged && !operationMissing && !operationNeedsReconcile) return;

  writing = true;
  try {
    await updateScannerState(current => {
      const next = baseDecision(current);
      const now = Date.now();
      const reconciledOperation = reconcileActiveSignalOperation(current.activeSignalOperation, current.signalHistory || [], now);
      const createdOperation = createActiveSignalOperation(current, next, now);
      const nextOperation = signalOperationHolds(reconciledOperation)
        ? reconciledOperation
        : (createdOperation || reconciledOperation || current.activeSignalOperation || null);
      const updateDecision = signature(next) !== signature(current.professionalDecision || {});
      const row = buildDecisionAudit(current, next);
      const oldAudit = current.decisionAudit || {};
      const audit = appendDecisionAudit(oldAudit, row, 40);
      const updateAudit = audit !== oldAudit;
      const updateOperation = operationSignature(nextOperation) !== operationSignature(current.activeSignalOperation || null);
      if (!updateDecision && !updateAudit && !updateOperation) return current;
      return {
        ...current,
        ...(updateDecision ? { professionalDecision: next } : {}),
        ...(updateAudit ? { decisionAudit: audit } : {}),
        ...(updateOperation ? { activeSignalOperation: nextOperation } : {})
      };
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
