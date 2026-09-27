import { readScannerState, updateScannerState } from './services/scanner-state-atomic.js';
import { getThresholds, getOperationMode, getSignalPolicy } from './core/analysis.js';

// Product policy layer. The technical engine can keep collecting evidence with an
// estimated clock, but the user-facing decision is never promoted while CasaTrade
// time is not authoritative. This also owns Normal/A+ confluence and the stable hold.
const EXACT_CLOCK_SOURCES = new Set(['trader-dom-countdown', 'network-server-cycle']);
const CLOCK_FRESH_MS = 4500;
const FOCUS_FRESH_MS = 5500;
const DEFAULT_PREFS = Object.freeze({ mode: 'NORMAL', geminiEnabled: true, sensitivityProfile: 'MEDIO', confirmationMode: 'SIMPLES', operationMode: 'M1', preferredExpiration: null });



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

function derivedAnalysisTime(state = {}, operationMode = getOperationMode(state.analystPreferences?.operationMode || 'M1')) {
  const durationSeconds = Number(operationMode.durationSeconds || 60);
  const durationMs = Math.max(1, durationSeconds * 1000);
  const now = Date.now();
  const lastSeen = Number(state.lastSeen || 0);
  const liveFeed = lastSeen > 0 && now - lastSeen < 8000;
  const current = state.signal?.currentCandle || state.currentCandle || null;
  const currentTimeRaw = num(current?.time ?? current?.timestamp);
  let currentTime = currentTimeRaw;
  if (currentTime != null && currentTime > 0 && currentTime < 1e12) currentTime *= 1000;

  if (currentTime != null && Number.isFinite(currentTime)) {
    const currentBucket = Math.floor(now / durationMs) * durationMs;
    const openAt = Math.floor(currentTime / durationMs) * durationMs;
    if (openAt === currentBucket) {
      const remaining = Math.max(0, Math.min(durationSeconds, (openAt + durationMs - now) / 1000));
      if (remaining > 0 && liveFeed) {
        return {
          ready: true,
          authoritative: false,
          timeframe: operationMode.timeframe,
          secondsRemaining: remaining,
          source: 'derived-candle-boundary',
          operationMode: operationMode.timeframe
        };
      }
    }
  }

  // consolidatedSnapshot() already derives secondsRemaining from the live candle
  // when the exact CasaTrade reader is momentarily absent. Reuse only that bounded
  // value here; it is analysis timing, never execution authority.
  const snapshotRemaining = num(state.signal?.secondsRemaining);
  if (snapshotRemaining != null && snapshotRemaining > 0 && snapshotRemaining <= durationSeconds && liveFeed) {
    return {
      ready: true,
      authoritative: false,
      timeframe: operationMode.timeframe,
      secondsRemaining: snapshotRemaining,
      source: 'derived-snapshot-clock',
      operationMode: operationMode.timeframe
    };
  }

  return { ready: false, authoritative: false, reason: 'Tempo de análise ainda não pôde ser derivado da vela atual.' };
}

export function exactCasaTradeTime(state = {}) {
  const focus = state.diagnostics?.focusedAsset || null;
  const clock = state.diagnostics?.marketClock || null;
  const operationMode = getOperationMode(state.analystPreferences?.operationMode || 'M1');

  if (!focusReady(state)) return { ready: false, authoritative: false, reason: 'Ativo/gráfico ainda não confirmado.' };

  if (clock && clock.available !== false && sameMarket(clock.asset, state.asset)) {
    if (clock.verified !== true || clock.role !== 'candle-close') {
      const derived = derivedAnalysisTime(state, operationMode);
      if (derived.ready) return derived;
      return { ready: false, authoritative: false, reason: 'Relógio exato da vela ainda não foi confirmado.' };
    }
    if (!EXACT_CLOCK_SOURCES.has(text(clock.source))) {
      const derived = derivedAnalysisTime(state, operationMode);
      if (derived.ready) return derived;
      return { ready: false, authoritative: false, reason: 'Fonte de tempo não autoritativa.' };
    }
    if (!clockBoundToFocus(clock, focus)) {
      const derived = derivedAnalysisTime(state, operationMode);
      if (derived.ready) return derived;
      return { ready: false, authoritative: false, reason: 'Relógio ainda não foi vinculado ao gráfico ativo.' };
    }
    const clockAt = Number(clock.at || 0);
    const clockAgeMs = Date.now() - clockAt;
    const rawRemaining = num(clock.secondsRemaining);
    if (clockAgeMs < CLOCK_FRESH_MS && rawRemaining != null) {
      const liveTf = normTf(clock.timeframe);
      const stateTf = normTf(state.analysisTimeframe || state.timeframe);
      const controlTf = normTf(state.platformControls?.observed?.timeframe);
      if (!liveTf) return { ready: false, authoritative: false, reason: 'Timeframe real ainda não foi confirmado.' };
      if (liveTf !== operationMode.timeframe) return { ready: false, authoritative: false, reason: `Ajuste o timeframe da CasaTrade para ${operationMode.timeframe}.` };
      if (stateTf && liveTf !== stateTf) return { ready: false, authoritative: false, reason: 'Timeframe interno divergiu do gráfico.' };
      if (controlTf && liveTf !== controlTf) return { ready: false, authoritative: false, reason: 'Timeframe visível divergiu do clock da vela.' };
      const elapsedSeconds = Math.max(0, clockAgeMs / 1000);
      const projectedRemaining = Math.max(0, Number(rawRemaining) - elapsedSeconds);
      return {
        ready: projectedRemaining > 0,
        authoritative: true,
        timeframe: liveTf,
        secondsRemaining: projectedRemaining,
        source: clock.source,
        operationMode: operationMode.timeframe,
        projectedFromExact: clockAgeMs > 250
      };
    }
    const derived = derivedAnalysisTime(state, operationMode);
    if (derived.ready) return derived;
    return { ready: false, authoritative: false, reason: 'Relógio da CasaTrade ficou desatualizado.' };
  }

  if (clock && clock.asset && !sameMarket(clock.asset, state.asset)) {
    return { ready: false, authoritative: false, reason: 'Relógio pertence a outro ativo.' };
  }

  const derived = derivedAnalysisTime(state, operationMode);
  if (derived.ready) return derived;
  return { ready: false, authoritative: false, reason: 'Countdown da CasaTrade indisponível.' };
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

  const observedExpiration = normExp(controls.observed?.expiration || '');
  const observedExpirationAt = Number(controls.observed?.observedAt?.expiration || 0);
  const observedSource = text(controls.realExpirationSource || controls.expirationSource || controls.observed?.source || '');
  const observedRealFresh = !!observedExpiration
    && observedExpirationAt > 0
    && Date.now() - observedExpirationAt < 15000
    && observedSource !== 'user-declared';

  const storedRealExpiration = normExp(controls.realExpiration || '');
  const storedRealExpirationAt = Number(controls.realExpirationAt || 0);
  const storedRealFresh = !!storedRealExpiration
    && storedRealExpirationAt > 0
    && Date.now() - storedRealExpirationAt < 15000
    && text(controls.realExpirationSource || '') !== 'user-declared';

  const realExpiration = storedRealFresh ? storedRealExpiration : observedRealFresh ? observedExpiration : '';
  const realExpirationAt = storedRealFresh ? storedRealExpirationAt : observedRealFresh ? observedExpirationAt : 0;
  const realFresh = !!realExpiration && realExpirationAt > 0;
  const actual = realFresh ? realExpiration : guardActual || null;
  const source = realFresh
    ? (text(storedRealFresh ? controls.realExpirationSource : observedSource) || 'casatrade-observed')
    : guardSource || '';
  const liveTf = normTf(timeframe || state.analysisTimeframe || state.timeframe);

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
    const manual = normExp(controls.userDeclaredExpiration || guardActual || '');
    return {
      ready: false,
      actual: manual || null,
      required: operationMode.expiration,
      source: manual ? 'user-declared' : null,
      verified: false,
      reason: manual
        ? `Expiração de ${expirationLabel} informada, aguardando verificação real da CasaTrade`
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
  return {
    ready: verified && actual === operationMode.expiration,
    actual,
    required: operationMode.expiration,
    source,
    verified,
    reason: verified
      ? `Expiração de ${expirationLabel} confirmada pela CasaTrade para o modo ${operationMode.timeframe}.`
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
  const confirmed = marketId(state.diagnostics?.marketSession?.confirmedAsset || '');
  const signalAsset = marketId(signal.asset || '');
  const candleAsset = marketId(state.currentCandle?.asset || '');
  if (!expected || !focus || !confirmed) {
    return { ready: false, reason: 'Ativo visual, sessão e feed ainda não foram confirmados juntos.' };
  }
  const rows = [focus, confirmed, signalAsset, candleAsset].filter(Boolean);
  const mismatch = rows.find(value => value !== expected);
  if (mismatch) {
    return { ready: false, reason: `Bloqueio de segurança: gráfico ${focus || '—'}, sessão ${confirmed || '—'} e sinal ${signalAsset || expected} não pertencem ao mesmo ativo.` };
  }
  return { ready: true, asset: expected };
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
  const target = num(signal.targetStart) ?? num(state.decisionCycle?.targetStart) ?? num(state.diagnostics?.marketClock?.closeAt);
  return `${asset}|${timeframe}|${target == null ? 'pending' : Math.round(target / 1000) * 1000}`;
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
  const factors = confluence(signal, direction, pref.thresholds);
  const signalPolicy = getSignalPolicy(pref.sensitivityProfile);
  // The selected rhythm changes selectivity, but never bypasses context + trigger.
  const additionalConfluenceReady = factors.count >= signalPolicy.minimumConfluence;
  const possibleScore = signalPolicy.possibleScore;
  const finalScore = signalPolicy.finalScore;
  const entryWindowSeconds = pref.operationMode === 'M1'
    ? 5
    : pref.operationMode === 'M5'
      ? 8
      : pref.thresholds.entryWindowSeconds;
  const preSignalWindowSeconds = 30;
  const directionalPower = Number(direction === 'BUY' ? signal.analytics?.buyPower : signal.analytics?.sellPower) || 0;
  const mandatoryPowerReady = directionalPower >= signalPolicy.possiblePower;
  const finalPowerReady = directionalPower >= signalPolicy.finalPower;
  const technicalCandidate = ['POSSIBLE_BUY', 'POSSIBLE_SELL', 'ENTER_BUY', 'ENTER_SELL'].includes(ui);
  const technicalFinal = ['ENTER_BUY', 'ENTER_SELL'].includes(ui);
  const professional = signal.analytics?.professional || {};
  const professionalContextReady = professional.contextReady === true;
  const professionalTriggerReady = professional.triggerReady === true;

  const common = {
    profile: pref.mode,
    operationMode: pref.operationMode,
    sensitivityProfile: pref.sensitivityProfile,
    sensitivityLabel: pref.sensitivityLabel,
    confirmationMode: pref.confirmationMode,
    holdSeconds: pref.holdSeconds,
    cycleKey: cycle,
    score,
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
    timeAuthoritative: time.authoritative === true,
    timeframe: time.timeframe || normTf(state.analysisTimeframe || state.timeframe),
    secondsRemaining: time.secondsRemaining ?? num(state.diagnostics?.marketClock?.secondsRemaining),
    marketIdentityReady: identity.ready,
    marketIdentityReason: identity.reason || null,
    updatedAt: now
  };

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
    return { ...common, uiState: 'WAIT', direction: null, actionable: false, alert: 'silent', possibleSince: null, reason: `AGUARDAR — ${time.reason}` };
  }

  const seconds = Number(time.secondsRemaining);
  if (!Number.isFinite(seconds) || seconds > preSignalWindowSeconds) {
    return { ...common, uiState: 'BUILDING_PATTERN', direction: null, actionable: false, alert: 'silent', possibleSince: null, reason: `Analisando a vela ${pref.operation.timeframe} atual. O pré-sinal abre por volta de ${preSignalWindowSeconds}s restantes.` };
  }
  if (seconds <= 0) {
    return { ...common, uiState: 'WAIT', direction: null, actionable: false, alert: 'silent', possibleSince: null, reason: 'AGUARDAR — fechamento da vela em andamento.' };
  }

  if (!professionalContextReady || !professionalTriggerReady) {
    return { ...common, uiState: 'WAIT', direction: null, actionable: false, alert: 'silent', possibleSince: null, reason: 'AGUARDAR — tendência/contexto, região e gatilho ainda não estão confirmados juntos.' };
  }

  if (!technicalCandidate || !direction || score < possibleScore || !mandatoryPowerReady || !additionalConfluenceReady) {
    return { ...common, uiState: 'WAIT', direction: null, actionable: false, alert: 'silent', possibleSince: null, reason: 'AGUARDAR — motor técnico ainda não liberou um candidato.' };
  }

  const previous = state.professionalDecision || {};
  const sameCandidate = previous.cycleKey === cycle && previous.direction === direction && ['POSSIBLE_BUY','POSSIBLE_SELL','ENTER_BUY','ENTER_SELL'].includes(text(previous.uiState).toUpperCase());
  const technicalPossibleSince = Number(signal.stability?.possibleSince || 0);
  const technicalSinceValid = technicalPossibleSince > 0 && technicalPossibleSince <= now && now - technicalPossibleSince < 45000;
  // Seed the presentation hold from the technical candidate's stable lifetime.
  // A transient policy WAIT must not restart a 2s hold at 4..1s remaining.
  const possibleSince = sameCandidate && Number(previous.possibleSince || 0) > 0
    ? Number(previous.possibleSince)
    : technicalSinceValid ? technicalPossibleSince : now;
  const holdMs = pref.holdSeconds * 1000;
  const heldFor = Math.max(0, now - possibleSince);
  const finalQuality = technicalFinal && score >= finalScore && finalPowerReady && additionalConfluenceReady
    && professionalContextReady && professionalTriggerReady;
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
      holdRemainingMs: Math.max(0, holdMs - heldFor),
      reason: `${side} — ALTA CONFIANÇA • PRÉ-SINAL • ${reason}`
    };
  }
  if (!finalQuality) {
    // The live fast path may need one or two transient samples before it
    // upgrades POSSÍVEL to ENTER. Do not let the 500ms policy evaluator erase
    // that candidate in the meantime. The grace is bounded to the same cycle,
    // direction and final-window confirmation period.
    const previousPossible = sameCandidate
      && ['POSSIBLE_BUY', 'POSSIBLE_SELL'].includes(text(previous.uiState).toUpperCase())
      && previous.direction === direction
      && heldFor <= holdMs + 1500;
    if (previousPossible && seconds <= entryWindowSeconds) {
      return {
        ...common,
        uiState: direction === 'BUY' ? 'POSSIBLE_BUY' : 'POSSIBLE_SELL',
        direction,
        actionable: false,
        alert: 'discrete',
        possibleSince,
        holdRemainingMs: Math.max(0, holdMs - heldFor),
        reason: 'POSSÍVEL — aguardando confirmação final do motor.'
      };
    }
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

  if (time.authoritative !== true) {
    return {
      ...common,
      uiState: direction === 'BUY' ? 'POSSIBLE_BUY' : 'POSSIBLE_SELL',
      direction,
      actionable: false,
      alert: 'discrete',
      possibleSince,
      holdRemainingMs: Math.max(0, holdMs - heldFor),
      reason: `${side} — ALTA CONFIANÇA • PRÉ-SINAL • aguardando o countdown exato da CasaTrade para liberar a entrada.`
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
    confluence: value.confluence || 0,
    factors: value.factors || [],
    timeReady: !!value.timeReady,
    timeAuthoritative: !!value.timeAuthoritative,
    expirationReady: !!value.expirationReady,
    actualExpiration: value.actualExpiration || null,
    timeSource: value.timeSource || null,
    timeframe: value.timeframe || null,
    secondsRemaining: value.secondsRemaining ?? null,
    marketIdentityReady: value.marketIdentityReady !== false,
    marketIdentityReason: value.marketIdentityReason || null,
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
