import { CandleBuilder, TIMEFRAMES } from './candles.js';
import { analyzeCandles, getThresholds, getSignalPolicy } from './analysis.js';
import { marketRegime } from './market-regime.js';

const builders = new Map();
const finalDecisions = new Map();
const completedDecisions = new Map();
const signalStability = new Map();
const num = v => v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null;
const clean = v => String(v ?? '').trim();
const POSSIBLE_HITS = 2;
const CONFIRM_HITS = 2;
const POSSIBLE_HOLD_MS = 2500;
const CANDIDATE_MAX_GAP_MS = 8000;

// Live CasaTrade price updates can move the raw technical score several points
// every analysis tick while the current candle is still forming. Keep rises
// responsive, but apply hysteresis to drops so one noisy tick cannot erase a
// candidate/final threshold immediately.
const SCORE_RISE_ALPHA = 0.70;
const SCORE_DROP_ALPHA = 0.30;
const SCORE_MAX_DROP_PER_TICK = 5;

function clampScore(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

function stabilizeScore(tracker = {}, rawScore = 0) {
  const raw = clampScore(rawScore);
  const previous = Number(tracker.stableScore);

  if (!Number.isFinite(previous)) {
    tracker.stableScore = raw;
  } else {
    const delta = raw - previous;
    const boundedDelta = delta < -SCORE_MAX_DROP_PER_TICK
      ? -SCORE_MAX_DROP_PER_TICK
      : delta;
    const alpha = boundedDelta < 0 ? SCORE_DROP_ALPHA : SCORE_RISE_ALPHA;
    tracker.stableScore += boundedDelta * alpha;
  }

  tracker.rawScore = raw;
  tracker.stableScore = clampScore(tracker.stableScore);
  return tracker.stableScore;
}

function trackerFor(key, bucket, at) {
  let tracker = signalStability.get(key);
  if (!tracker || tracker.bucket !== bucket) {
    tracker = {
      bucket,
      candidateDirection: null,
      candidateHits: 0,
      candidateSince: null,
      lastCandidateAt: null,
      publishedDirection: null,
      publishedAt: null,
      lastStrongAt: null,
      publishedScore: 0,
      rawScore: 0,
      stableScore: null,
      weakHits: 0,
      confirmDirection: null,
      confirmHits: 0,
      lastConfirmAt: null,
      updatedAt: at
    };
    signalStability.set(key, tracker);
  }
  tracker.updatedAt = at;
  return tracker;
}

function observePossible(tracker, direction, score, at, thresholds) {
  const qualifies = ['BUY', 'SELL'].includes(direction) && Number(score) >= thresholds.possibleScore;
  if (qualifies) {
    const sameCandidate = tracker.candidateDirection === direction
      && tracker.lastCandidateAt != null
      && at - tracker.lastCandidateAt <= CANDIDATE_MAX_GAP_MS;
    if (sameCandidate) {
      tracker.candidateHits += 1;
    } else {
      tracker.candidateDirection = direction;
      tracker.candidateHits = 1;
      tracker.candidateSince = at;
    }
    tracker.lastCandidateAt = at;

    if (tracker.publishedDirection === direction) {
      tracker.weakHits = 0;
      tracker.lastStrongAt = at;
      tracker.publishedScore = Number(score);
    } else if (tracker.candidateHits >= POSSIBLE_HITS) {
      tracker.publishedDirection = direction;
      tracker.publishedAt = at;
      tracker.lastStrongAt = at;
      tracker.publishedScore = Number(score);
      tracker.weakHits = 0;
    } else if (tracker.publishedDirection) {
      tracker.weakHits += 1;
    }
  } else {
    tracker.candidateDirection = null;
    tracker.candidateHits = 0;
    tracker.candidateSince = null;
    tracker.lastCandidateAt = null;
    tracker.weakHits += 1;
  }

  if (tracker.publishedDirection) {
    const staleFor = at - Number(tracker.lastStrongAt || tracker.publishedAt || at);
    if (staleFor > POSSIBLE_HOLD_MS && tracker.weakHits >= 3) {
      tracker.publishedDirection = null;
      tracker.publishedAt = null;
      tracker.lastStrongAt = null;
      tracker.publishedScore = 0;
      tracker.weakHits = 0;
    }
  }
  return tracker.publishedDirection;
}

function confirmationQuality(result = {}, direction = null, thresholds = getThresholds()) {
  if (!direction || !result?.recent?.ready) return false;
  const signalPolicy = getSignalPolicy(thresholds.profile);
  const metrics = result.analytics || result.recent?.metrics || {};
  const professional = metrics.professional || {};
  if (professional.contextReady !== true || professional.triggerReady !== true) return false;
  const directionalPower = direction === 'BUY' ? Number(metrics.buyPower || 0) : Number(metrics.sellPower || 0);
  const candleStrong = Number(metrics.currentStrength || 0) >= thresholds.candleStrength;
  const rejected = result.recent?.rejection === direction
    && Number(metrics.rejectionStrength || 0) >= thresholds.rejectionStrength;
  const broke = result.recent?.breakout === direction;
  const continuation = result.recent?.continuationDirection === direction
    && Number(result.recent?.continuationScore || 0) >= 60;
  const trendAligned = Number(result.recent?.agreement || 0) >= .7
    && metrics.momentumDirection === direction
    && Number(metrics.momentumScore || 0) >= 45;
  return directionalPower >= signalPolicy.finalPower && (candleStrong || rejected || broke || continuation || trendAligned);
}

function rangeOverrideQuality(result = {}, direction = null, thresholds = getThresholds()) {
  if (!direction || !result?.recent?.ready) return false;
  const signalPolicy = getSignalPolicy(thresholds.profile);
  const metrics = result.analytics || result.recent?.metrics || {};
  const professional = metrics.professional || {};
  if (professional.contextReady !== true || professional.triggerReady !== true) return false;
  const directionalPower = direction === 'BUY' ? Number(metrics.buyPower || 0) : Number(metrics.sellPower || 0);
  const broke = result.recent?.breakout === direction;
  const rejected = result.recent?.rejection === direction
    && Number(metrics.rejectionStrength || 0) >= thresholds.rejectionStrength;
  const continuation = result.recent?.continuationDirection === direction
    && Number(result.recent?.continuationScore || 0) >= 68
    && metrics.momentumDirection === direction
    && Number(metrics.momentumScore || 0) >= 55;
  return directionalPower >= signalPolicy.finalPower && (broke || rejected || continuation);
}

function observeConfirmation(tracker, result, direction, score, at, thresholds) {
  const qualifies = tracker.publishedDirection === direction
    && Number(score) >= thresholds.confirmScore
    && confirmationQuality(result, direction, thresholds);
  if (!qualifies) {
    tracker.confirmDirection = null;
    tracker.confirmHits = 0;
    tracker.lastConfirmAt = null;
    return false;
  }

  const same = tracker.confirmDirection === direction
    && tracker.lastConfirmAt != null
    && at - tracker.lastConfirmAt <= CANDIDATE_MAX_GAP_MS;
  if (same) tracker.confirmHits += 1;
  else {
    tracker.confirmDirection = direction;
    tracker.confirmHits = 1;
  }
  tracker.lastConfirmAt = at;
  return tracker.confirmHits >= CONFIRM_HITS;
}

function analyticsSummary(result = {}, direction = null) {
  const metrics = result.analytics || result.recent?.metrics || {};
  if (!direction) return 'Mercado sem domínio claro entre compra e venda.';
  const power = direction === 'BUY' ? Number(metrics.buyPower || 0) : Number(metrics.sellPower || 0);
  const parts = [`poder ${direction === 'BUY' ? 'comprador' : 'vendedor'} ${Math.round(power)}%`];
  const professional = metrics.professional || {};
  if (professional.blocks) {
    parts.push(`estrutura ${Math.round(Number(professional.blocks.structure || 0))}/25`);
    parts.push(`gatilho ${Math.round(Number(professional.blocks.trigger || 0))}/25`);
  }
  if (Number(metrics.currentStrength || 0) > 0) parts.push(`força da vela ${Math.round(Number(metrics.currentStrength || 0))}%`);
  if (result.recent?.rejection === direction) parts.push(`rejeição ${Math.round(Number(metrics.rejectionStrength || 0))}%`);
  if (result.recent?.breakout === direction) parts.push('rompimento recente');
  if (metrics.momentumDirection === direction && Number(metrics.momentumScore || 0) >= 45) parts.push('momentum favorável');
  return parts.join(' • ');
}

function reasonFor(result = {}, direction = null, final = false) {
  if (!result?.recent?.ready) return 'Montando o padrão com as velas recentes e a vela atual.';
  if (!direction) return result?.waitingFor?.text || 'Sem direção firme para a próxima vela neste momento.';
  return `${final ? 'Padrão confirmado' : 'Padrão consistente'}: ${analyticsSummary(result, direction)}.`;
}

function baseSignal({
  state = 'WAIT', direction = null, provisional = true, reason, timeframe = 'M1', expiration = null,
  candleCount = 0, secondsRemaining = null, progress = null, currentCandle = null, score = 0,
  analysisDirection = null, analysisScore = null, phase = 'ANALYZING', targetStart = null,
  uiState = 'ANALYZING_MARKET', analytics = {}, waitingFor = null, regime = null, stability = null
} = {}) {
  const diagnosis = ['WATCH', 'CONFIRM'].includes(state) && ['BUY', 'SELL'].includes(direction)
    ? direction
    : 'WAIT';
  return {
    state,
    direction,
    diagnosis,
    uiState,
    provisional,
    phase,
    hint: reason,
    reason,
    candleCount,
    warmup: { current: candleCount, required: getThresholds().minimumClosedCandles },
    timeframe,
    targetExpiration: expiration,
    secondsRemaining,
    progress,
    currentCandle,
    score,
    analysisDirection,
    analysisScore: analysisScore == null ? score : analysisScore,
    analytics,
    waitingFor,
    regime,
    stability,
    targetStart,
    targetLabel: targetStart ? new Date(targetStart).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : null
  };
}

function completedDecision(decision = {}, fallback = {}) {
  const state = decision.state === 'CONFIRM' ? 'CONFIRM' : 'NO_TRADE';
  const targetStart = Number(decision.targetStart) || Number(decision.bucket) + Number(fallback.timeframeMs || 0) || null;
  const candidateEntryPrice = state === 'CONFIRM' ? num(fallback.entryPrice) : null;
  const entryConfirmed = state === 'CONFIRM'
    ? fallback.entryConfirmed !== false && candidateEntryPrice != null
    : null;
  const entryPrice = entryConfirmed ? candidateEntryPrice : null;
  const entryTime = entryConfirmed ? (Number(fallback.entryTime) || targetStart) : null;
  return {
    state,
    direction: state === 'CONFIRM' && ['BUY', 'SELL'].includes(decision.direction) ? decision.direction : null,
    score: Number(decision.score || 0),
    time: targetStart,
    targetStart,
    entryPrice,
    entryTime,
    entryConfirmed,
    entryStatus: state === 'CONFIRM' ? (entryConfirmed ? 'confirmed' : 'unconfirmed') : 'not_applicable',
    entryReason: state === 'CONFIRM' && !entryConfirmed
      ? (fallback.entryReason || 'Preço de entrada não confirmado: a vela-alvo não foi observada.')
      : null,
    capturedAt: entryConfirmed ? (Number(fallback.capturedAt) || null) : null,
    asset: decision.asset || fallback.asset || null,
    timeframe: decision.timeframe || fallback.timeframe || null
  };
}

function stabilitySnapshot(tracker = {}) {
  return {
    possibleDirection: tracker.publishedDirection || null,
    possibleHits: Number(tracker.candidateHits || 0),
    possibleSince: tracker.publishedAt || null,
    confirmHits: Number(tracker.confirmHits || 0),
    rawScore: Number(tracker.rawScore || 0),
    stableScore: Number(tracker.stableScore || 0),
    scoreSamples: Number.isFinite(Number(tracker.stableScore)) ? 1 : 0
  };
}

export function processSnapshot(snapshot = {}, state = {}) {
  const thresholds = getThresholds(state.analystPreferences?.sensitivityProfile || 'MEDIO');
  const signalPolicy = getSignalPolicy(thresholds.profile);
  const gateThresholds = {
    ...thresholds,
    possibleScore: signalPolicy.possibleScore,
    confirmScore: signalPolicy.finalScore,
    finalScore: signalPolicy.finalScore
  };
  const price = num(snapshot.price);
  if (!snapshot.asset || price == null) {
    return {
      lastConfirmed: null,
      signal: baseSignal({
        state: 'WAIT',
        phase: 'CONNECTING',
        uiState: 'ANALYZING_MARKET',
        reason: 'Confirmando ativo e cotação reais da CasaTrade.'
      })
    };
  }

  const analysisTimeframe = snapshot.analysisTimeframe || snapshot.timeframe || state.analysisTimeframe || state.timeframe || 'M1';
  const tfMs = timeframeMs(analysisTimeframe);
  const sampleAt = Number.isFinite(Number(snapshot.serverTime)) && Number(snapshot.serverTime) > 0 ? Number(snapshot.serverTime) : Date.now();
  const currentBucket = Math.floor(sampleAt / tfMs) * tfMs;
  const key = builderKey({ ...snapshot, analysisTimeframe });
  const builder = getBuilder({ ...snapshot, analysisTimeframe });

  const history = (Array.isArray(snapshot.candles) ? snapshot.candles : []).filter(raw => {
    if (!sameTimeframe(raw, analysisTimeframe)) return false;
    const t = candleTime(raw);
    return t != null && Math.floor(t / tfMs) * tfMs < currentBucket;
  });
  if (history.length) builder.seed(history);
  builder.push(price, sampleAt);

  const shot = builder.snapshot();
  const closed = shot.closed.slice(-120);
  const current = currentFromSnapshot(snapshot.candles, currentBucket, tfMs, analysisTimeframe, price) || shot.current;
  const combined = current ? [...closed.slice(-9), current] : closed.slice(-10);
  const indicatorHistory = current ? [...closed, current] : closed;
  const liveResult = analyzeCandles(combined, indicatorHistory, thresholds.profile);
  const regime = marketRegime(closed);
  const candleCount = closed.length;

  const clockRemaining = num(snapshot.secondsRemaining);
  const fallbackRemainingMs = Math.max(0, currentBucket + tfMs - sampleAt);
  const remainingMs = clockRemaining != null
    ? Math.max(0, Math.min(tfMs, Math.round(clockRemaining * 1000)))
    : fallbackRemainingMs;
  const secondsRemaining = Math.max(0, Math.ceil(remainingMs / 1000));
  const preSignalWindowSeconds = String(analysisTimeframe || '').toUpperCase() === 'M5' ? 90 : 30;
  const progress = Math.max(0, Math.min(100, Math.round(((tfMs - remainingMs) / tfMs) * 100)));
  const targetStart = clockRemaining != null ? sampleAt + remainingMs : currentBucket + tfMs;
  const analysisDirection = ['BUY', 'SELL'].includes(liveResult.direction) ? liveResult.direction : null;
  const professional = liveResult.analytics?.professional || {};
  const professionalReady = professional.contextReady === true && professional.triggerReady === true;
  const direction = professionalReady ? analysisDirection : null;
  const rawScore = Number(liveResult.score || 0);
  const expiration = snapshot.targetExpiration || state.targetExpiration || snapshot.expiration || state.expiration || null;
  const tracker = trackerFor(key, currentBucket, sampleAt);
  const score = stabilizeScore(tracker, rawScore);
  const possibleDirection = observePossible(tracker, direction, score, sampleAt, gateThresholds);
  const common = {
    timeframe: analysisTimeframe,
    expiration,
    candleCount,
    secondsRemaining,
    progress,
    currentCandle: current ? { ...current } : null,
    score,
    analysisDirection,
    analysisScore: score,
    analytics: liveResult.analytics || {},
    waitingFor: liveResult.waitingFor || null,
    regime,
    stability: stabilitySnapshot(tracker),
    targetStart
  };

  let lastConfirmed = completedDecisions.get(key) || null;
  const previousDecision = finalDecisions.get(key);
  if (previousDecision && currentBucket > previousDecision.bucket) {
    const expectedBucket = Number(previousDecision.bucket) + tfMs;
    const rawTarget = Number(previousDecision.targetStart);
    const targetBucket = Number.isFinite(rawTarget) && rawTarget > 0
      ? Math.round(rawTarget / tfMs) * tfMs
      : expectedBucket;
    const targetObserved = currentBucket === expectedBucket && targetBucket === expectedBucket;
    const realEntryPrice = targetObserved ? (num(current?.open) ?? price) : null;

    lastConfirmed = completedDecision(previousDecision, {
      asset: snapshot.asset,
      timeframe: analysisTimeframe,
      timeframeMs: tfMs,
      entryPrice: realEntryPrice,
      entryTime: targetObserved ? currentBucket : null,
      capturedAt: targetObserved ? sampleAt : null,
      entryConfirmed: targetObserved,
      entryReason: targetObserved ? null : 'Preço de entrada não confirmado: a vela-alvo não foi observada.'
    });
    completedDecisions.set(key, lastConfirmed);
    finalDecisions.delete(key);
  }

  if (candleCount < thresholds.minimumClosedCandles || !current) {
    return {
      candles: closed,
      currentCandle: current || null,
      lastConfirmed,
      signal: baseSignal({
        ...common,
        state: 'SEARCHING',
        phase: 'HISTORY',
        uiState: 'ANALYZING_MARKET',
        reason: `Analisando mercado atual • ${candleCount}/${thresholds.minimumClosedCandles} velas fechadas reais.`
      })
    };
  }

  const latched = finalDecisions.get(key);
  if (latched?.bucket === currentBucket && latched.state === 'CONFIRM') {
    return {
      candles: closed,
      currentCandle: current,
      lastConfirmed,
      signal: baseSignal({
        ...common,
        ...latched,
        state: 'CONFIRM',
        direction: latched.direction,
        provisional: false,
        phase: 'FINAL',
        uiState: latched.direction === 'BUY' ? 'ENTER_BUY' : 'ENTER_SELL',
        reason: latched.reason,
        score: Math.max(Number(latched.score || 0), score),
        stability: stabilitySnapshot(tracker),
        targetStart: latched.targetStart || targetStart
      })
    };
  }

  if (secondsRemaining <= thresholds.entryWindowSeconds) {
    const rangeBlocked = regime?.type === 'range' && !rangeOverrideQuality(liveResult, direction, gateThresholds);
    if (rangeBlocked) {
      tracker.confirmDirection = null;
      tracker.confirmHits = 0;
      tracker.lastConfirmAt = null;
    }
    const canConfirm = !rangeBlocked && observeConfirmation(tracker, liveResult, direction, score, sampleAt, gateThresholds);
    if (canConfirm) {
      const latestDecision = {
        bucket: currentBucket,
        state: 'CONFIRM',
        direction,
        provisional: false,
        reason: reasonFor(liveResult, direction, true),
        score,
        targetStart,
        asset: snapshot.asset,
        timeframe: analysisTimeframe
      };
      finalDecisions.set(key, latestDecision);
      return {
        candles: closed,
        currentCandle: current,
        lastConfirmed,
        signal: baseSignal({
          ...common,
          ...latestDecision,
          phase: 'FINAL',
          uiState: direction === 'BUY' ? 'ENTER_BUY' : 'ENTER_SELL',
          stability: stabilitySnapshot(tracker)
        })
      };
    }

    const noTradeReason = rangeBlocked
      ? 'AGUARDANDO — mercado sem tendência definida.'
      : (liveResult.waitingFor?.text || 'Sem confirmação estável suficiente para liberar a próxima vela.');
    finalDecisions.set(key, {
      bucket: currentBucket,
      state: 'NO_TRADE',
      direction: null,
      provisional: false,
      reason: noTradeReason,
      score,
      targetStart,
      asset: snapshot.asset,
      timeframe: analysisTimeframe
    });

    if (rangeBlocked) {
      return {
        candles: closed,
        currentCandle: current,
        lastConfirmed,
        signal: baseSignal({
          ...common,
          state: 'NO_TRADE',
          direction: null,
          provisional: false,
          phase: 'FINAL',
          uiState: 'WAIT',
          reason: noTradeReason,
          stability: stabilitySnapshot(tracker)
        })
      };
    }

    if (possibleDirection) {
      return {
        candles: closed,
        currentCandle: current,
        lastConfirmed,
        signal: baseSignal({
          ...common,
          state: 'WATCH',
          direction: possibleDirection,
          provisional: true,
          phase: 'POSSIBLE',
          uiState: possibleDirection === 'BUY' ? 'POSSIBLE_BUY' : 'POSSIBLE_SELL',
          reason: reasonFor(liveResult, possibleDirection, false),
          score: Math.max(score, Number(tracker.publishedScore || 0)),
          stability: stabilitySnapshot(tracker)
        })
      };
    }

    return {
      candles: closed,
      currentCandle: current,
      lastConfirmed,
      signal: baseSignal({
        ...common,
        state: 'NO_TRADE',
        direction: null,
        provisional: false,
        phase: 'FINAL',
        uiState: 'WAIT',
        reason: noTradeReason,
        stability: stabilitySnapshot(tracker)
      })
    };
  }

  if (secondsRemaining <= preSignalWindowSeconds) {
    if (possibleDirection) {
      return {
        candles: closed,
        currentCandle: current,
        lastConfirmed,
        signal: baseSignal({
          ...common,
          state: 'WATCH',
          direction: possibleDirection,
          provisional: true,
          phase: 'POSSIBLE',
          uiState: possibleDirection === 'BUY' ? 'POSSIBLE_BUY' : 'POSSIBLE_SELL',
          reason: reasonFor(liveResult, possibleDirection, false),
          score: Math.max(score, Number(tracker.publishedScore || 0)),
          stability: stabilitySnapshot(tracker)
        })
      };
    }

    return {
      candles: closed,
      currentCandle: current,
      lastConfirmed,
      signal: baseSignal({
        ...common,
        state: 'WAIT',
        direction: null,
        provisional: true,
        phase: 'ANALYZING',
        uiState: 'WAIT',
        reason: liveResult.waitingFor?.text || 'Padrão ainda sem qualidade suficiente para sinalizar a próxima vela.',
        stability: stabilitySnapshot(tracker)
      })
    };
  }

  if (possibleDirection) {
    return {
      candles: closed,
      currentCandle: current,
      lastConfirmed,
      signal: baseSignal({
        ...common,
        state: 'WATCH',
        direction: possibleDirection,
        provisional: true,
        phase: 'POSSIBLE',
        uiState: possibleDirection === 'BUY' ? 'POSSIBLE_BUY' : 'POSSIBLE_SELL',
        reason: reasonFor(liveResult, possibleDirection, false),
        score: Math.max(score, Number(tracker.publishedScore || 0)),
        stability: stabilitySnapshot(tracker)
      })
    };
  }

  const buildingPattern = !!analysisDirection && score >= 30;
  return {
    candles: closed,
    currentCandle: current,
    lastConfirmed,
    signal: baseSignal({
      ...common,
      state: 'WAIT',
      direction: null,
      provisional: true,
      phase: buildingPattern ? 'BUILDING' : 'ANALYZING',
      uiState: buildingPattern ? 'BUILDING_PATTERN' : 'ANALYZING_MARKET',
      reason: liveResult.waitingFor?.text || (buildingPattern
        ? `Montando padrão da próxima vela: ${analyticsSummary(liveResult, analysisDirection)}.`
        : 'Analisando poder de compra/venda, rejeição, força e momentum do mercado atual.'),
      stability: stabilitySnapshot(tracker)
    })
  };
}

export function serializeCompletedDecisions() {
  return [...completedDecisions.entries()].slice(-50).map(([key, decision]) => ({
    key,
    decision: { ...decision }
  }));
}

export function restoreCompletedDecisions(rows = []) {
  completedDecisions.clear();
  for (const row of Array.isArray(rows) ? rows.slice(-50) : []) {
    const key = clean(row?.key);
    const decision = row?.decision;
    if (!key || !decision || typeof decision !== 'object') continue;
    completedDecisions.set(key, { ...decision });
  }
}

export function resetOrchestrator() {
  builders.clear();
  finalDecisions.clear();
  completedDecisions.clear();
  signalStability.clear();
}
