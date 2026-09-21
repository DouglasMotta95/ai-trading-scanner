import {
  processSnapshot as legacyProcessSnapshot,
  resetOrchestrator as legacyResetOrchestrator,
  serializeCompletedDecisions as legacySerializeCompletedDecisions,
  restoreCompletedDecisions as legacyRestoreCompletedDecisions
} from './orchestrator-legacy.js';
import { getThresholds } from './analysis.js';

// Price action/indicators remain in the legacy analyst. This wrapper owns exactly
// one bounded decision for each target candle: ENTER BUY, ENTER SELL or WAIT.
const CONFIRM_HITS = 2;
const DECISION_HIT_GAP_MS = 7000;
const DECISION_WEAK_HOLD_MS = 2500;
const POSSIBLE_DROP_HITS = 2;
const POSSIBLE_WEAK_HOLD_MS = 2500;
const CANDIDATE_PERSISTENCE_WINDOW_MS = 20_000;
const CANDIDATE_PERSISTENCE_BUCKET_MS = 1000;
const CANDIDATE_PERSISTENCE_MIN_SAMPLES = 4;
const CANDIDATE_PERSISTENCE_MIN_SCORE = 55;
const CANDIDATE_PERSISTENCE_MIN_RATIO = 0.70;
// Android/tablet browsers can throttle live observations to 5–6s. Keep one\n// recent persistent candidate alive across that real gap without weakening the\n// score/ratio/opposite-direction gates.\nconst CANDIDATE_PERSISTENCE_MAX_GAP_MS = 8000;
const cycles = new Map();
const wrapperCompletedDecisions = new Map();
const WRAPPER_ROW_PREFIX = 'wrapper-cycle:';

const num = value => value == null || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null;
const clean = value => String(value ?? '').trim();
const directionOf = signal => ['BUY', 'SELL'].includes(signal?.analysisDirection)
  ? signal.analysisDirection
  : ['BUY', 'SELL'].includes(signal?.direction) ? signal.direction : null;
const assetIdentity = value => clean(value).toUpperCase().replace(/\s*\(\s*OTC\s*\)\s*$/i, '');
const sameAsset = (a, b) => !!assetIdentity(a) && assetIdentity(a) === assetIdentity(b);

function timeframeMs(value = 'M1') {
  const tf = clean(value).toUpperCase();
  let match = tf.match(/^S(\d+)$/); if (match) return Math.max(1, Number(match[1])) * 1000;
  match = tf.match(/^M(\d+)$/); if (match) return Math.max(1, Number(match[1])) * 60_000;
  match = tf.match(/^H(\d+)$/); if (match) return Math.max(1, Number(match[1])) * 3_600_000;
  return 60_000;
}

function decisionWindows(snapshot = {}, signal = {}, thresholds = getThresholds()) {
  const timeframe = clean(snapshot.analysisTimeframe || snapshot.timeframe || signal.timeframe || 'M1').toUpperCase();
  const duration = Math.max(2, Math.round(timeframeMs(timeframe) / 1000));
  // Operation contract: final decision window stays in absolute seconds from
  // the sensitivity profile. Only the pre-signal window differs by mode.
  if (timeframe === 'M1' || timeframe === 'M5') {
    return { pre: timeframe === 'M5' ? 90 : 30, decision: thresholds.entryWindowSeconds, skip: 4, duration, timeframe };
  }

  // Longer/shorter candles keep proportional windows.
  const pre = Math.max(2, Math.min(duration - 1, 60, Math.round(duration * .50)));
  const decision = Math.max(1, Math.min(pre - 1, 30, Math.round(duration * .25)));
  const skip = Math.max(1, Math.min(decision, 8, Math.round(duration * .067)));
  return { pre, decision, skip, duration, timeframe };
}

function cycleKey(snapshot = {}, signal = {}) {
  const asset = clean(snapshot.asset || 'unknown');
  const timeframe = clean(snapshot.analysisTimeframe || snapshot.timeframe || signal.timeframe || 'M1').toUpperCase();
  const sampleAt = num(snapshot.serverTime) ?? Date.now();
  const seconds = num(signal.secondsRemaining) ?? num(snapshot.secondsRemaining) ?? 0;
  const rawTarget = num(signal.targetStart) ?? (sampleAt + Math.max(0, seconds) * 1000);
  const targetKey = Math.round(rawTarget / 5000) * 5000;
  return `${asset}|${timeframe}|${targetKey}`;
}

function targetStartOf(snapshot = {}, signal = {}) {
  const sampleAt = num(snapshot.serverTime) ?? Date.now();
  const seconds = num(signal.secondsRemaining) ?? num(snapshot.secondsRemaining) ?? 0;
  return num(signal.targetStart) ?? (sampleAt + Math.max(0, seconds) * 1000);
}

function decisionQuality(signal = {}, direction = null, thresholds = getThresholds()) {
  if (!direction) return { qualifies: false, setup: null };
  const score = Number(signal.analysisScore ?? signal.score ?? 0);
  if (score < thresholds.confirmScore) return { qualifies: false, setup: null };

  const analytics = signal.analytics || {};
  const power = Number(direction === 'BUY' ? analytics.buyPower : analytics.sellPower) || 0;
  if (power < 50) return { qualifies: false, setup: null };
  const currentStrength = Number(analytics.currentStrength || 0);
  const rejectionStrength = Number(analytics.rejectionStrength || 0);
  const directionalRejection = analytics.rejectionDirection === direction
    || Number(direction === 'BUY' ? analytics.rejectionBuy : analytics.rejectionSell) >= thresholds.rejectionStrength;
  const continuation = analytics.continuationDirection === direction && Number(analytics.continuationScore || 0) >= 55;
  const momentum = analytics.momentumDirection === direction && Number(analytics.momentumScore || 0) >= 40;
  const strongCandle = currentStrength >= thresholds.candleStrength;
  const rejection = directionalRejection && rejectionStrength >= thresholds.rejectionStrength;
  const regime = String(signal.regime?.type || '').toLowerCase();

  // Setup-specific gates increase useful frequency without lowering the approved
  // 44/58/62/50 analyst thresholds. A continuation no longer has to look like a
  // rejection and a rejection no longer has to look like momentum.
  const setups = regime === 'range'
    ? [
        { name: 'rejeição no range', ok: power >= 52 && rejection },
        { name: 'continuação confirmada no range', ok: power >= 55 && score >= 64 && continuation && momentum }
      ]
    : [
        { name: 'rejeição', ok: power >= 48 && rejection },
        { name: 'continuação', ok: power >= 50 && continuation },
        { name: 'momentum', ok: power >= 50 && strongCandle && momentum },
        { name: 'confluência forte', ok: power >= 48 && score >= 68 && momentum && (strongCandle || continuation) }
      ];
  const matched = setups.find(item => item.ok) || null;
  return { qualifies: !!matched, setup: matched?.name || null };
}

function possibleQuality(signal = {}, direction = null, score = 0, thresholds = getThresholds()) {
  if (!direction || Number(score) < thresholds.possibleScore) return false;
  const analytics = signal.analytics || {};
  const power = Number(direction === 'BUY' ? analytics.buyPower : analytics.sellPower) || 0;
  if (power < 50) return false;
  const stableDirection = clean(signal.stability?.possibleDirection).toUpperCase();
  const publishedDirection = clean(signal.direction).toUpperCase();
  return stableDirection === direction || (signal.state === 'WATCH' && publishedDirection === direction);
}


function possibleQualityTelemetry(signal = {}, direction = null, score = 0, thresholds = getThresholds()) {
  const analytics = signal.analytics || {};
  const power = Number(direction === 'BUY' ? analytics.buyPower : direction === 'SELL' ? analytics.sellPower : 0) || 0;
  const stableDirection = clean(signal.stability?.possibleDirection).toUpperCase();
  const publishedDirection = clean(signal.direction).toUpperCase();
  const conditions = {
    directionExists: ['BUY', 'SELL'].includes(direction),
    scoreReady: Number(score) >= thresholds.possibleScore,
    powerReady: power >= 50,
    stabilityMatches: !!direction && stableDirection === direction,
    watchPublishedMatches: !!direction && signal.state === 'WATCH' && publishedDirection === direction
  };
  return {
    ...conditions,
    possibleScore: thresholds.possibleScore,
    power,
    allowed: conditions.directionExists
      && conditions.scoreReady
      && conditions.powerReady
      && (conditions.stabilityMatches || conditions.watchPublishedMatches)
  };
}

function decisionQualityTelemetry(signal = {}, direction = null, thresholds = getThresholds()) {
  const score = Number(signal.analysisScore ?? signal.score ?? 0);
  const analytics = signal.analytics || {};
  const power = Number(direction === 'BUY' ? analytics.buyPower : direction === 'SELL' ? analytics.sellPower : 0) || 0;
  const currentStrength = Number(analytics.currentStrength || 0);
  const rejectionStrength = Number(analytics.rejectionStrength || 0);
  const directionalRejection = !!direction && (analytics.rejectionDirection === direction
    || Number(direction === 'BUY' ? analytics.rejectionBuy : analytics.rejectionSell) >= thresholds.rejectionStrength);
  const continuation = !!direction && analytics.continuationDirection === direction && Number(analytics.continuationScore || 0) >= 55;
  const momentum = !!direction && analytics.momentumDirection === direction && Number(analytics.momentumScore || 0) >= 40;
  const strongCandle = currentStrength >= thresholds.candleStrength;
  const rejection = directionalRejection && rejectionStrength >= thresholds.rejectionStrength;
  const regime = String(signal.regime?.type || '').toLowerCase();
  const globalFailures = [];
  if (!direction) globalFailures.push('direção ausente');
  if (score < thresholds.confirmScore) globalFailures.push(`score ${score}<${thresholds.confirmScore}`);
  if (power < 50) globalFailures.push(`power ${power}<50`);

  const evaluate = (applies, checks = []) => {
    const failures = [...globalFailures];
    if (!applies) failures.push(`não aplicável no regime ${regime || 'unknown'}`);
    for (const check of checks) if (!check.ok) failures.push(check.reason);
    return { ok: applies && failures.length === 0, reason: failures.length ? failures.join('; ') : 'OK' };
  };

  return {
    confirmScore: thresholds.confirmScore,
    candleStrengthThreshold: thresholds.candleStrength,
    rejectionStrengthThreshold: thresholds.rejectionStrength,
    global: {
      directionExists: ['BUY', 'SELL'].includes(direction),
      scoreReady: score >= thresholds.confirmScore,
      powerReady: power >= 50
    },
    setups: {
      rejection: evaluate(regime !== 'range', [
        { ok: power >= 48, reason: `power ${power}<48` },
        { ok: rejection, reason: `rejeição insuficiente/direção divergente (strength=${rejectionStrength}, mínimo=${thresholds.rejectionStrength})` }
      ]),
      continuation: evaluate(regime !== 'range', [
        { ok: power >= 50, reason: `power ${power}<50` },
        { ok: continuation, reason: `continuação ausente/divergente ou score<55 (score=${Number(analytics.continuationScore || 0)})` }
      ]),
      momentum: evaluate(regime !== 'range', [
        { ok: power >= 50, reason: `power ${power}<50` },
        { ok: strongCandle, reason: `currentStrength ${currentStrength}<${thresholds.candleStrength}` },
        { ok: momentum, reason: `momentum ausente/divergente ou score<40 (score=${Number(analytics.momentumScore || 0)})` }
      ]),
      strongConfluence: evaluate(regime !== 'range', [
        { ok: power >= 48, reason: `power ${power}<48` },
        { ok: score >= 68, reason: `score ${score}<68` },
        { ok: momentum, reason: `momentum ausente/divergente ou score<40 (score=${Number(analytics.momentumScore || 0)})` },
        { ok: strongCandle || continuation, reason: `sem vela forte nem continuação (strength=${currentStrength}, continuation=${Number(analytics.continuationScore || 0)})` }
      ]),
      rangeRejection: evaluate(regime === 'range', [
        { ok: power >= 52, reason: `power ${power}<52` },
        { ok: rejection, reason: `rejeição insuficiente/direção divergente (strength=${rejectionStrength}, mínimo=${thresholds.rejectionStrength})` }
      ]),
      rangeContinuation: evaluate(regime === 'range', [
        { ok: power >= 55, reason: `power ${power}<55` },
        { ok: score >= 64, reason: `score ${score}<64` },
        { ok: continuation, reason: `continuação ausente/divergente ou score<55 (score=${Number(analytics.continuationScore || 0)})` },
        { ok: momentum, reason: `momentum ausente/divergente ou score<40 (score=${Number(analytics.momentumScore || 0)})` }
      ])
    }
  };
}

function candidateBlockerMeasured(result = {}, snapshot = {}, state = {}, thresholds, key, cycle, rawSignal = {}) {
  const outputSignal = result?.signal || rawSignal || {};
  const direction = directionOf(rawSignal);
  const score = Number(rawSignal.analysisScore ?? rawSignal.score ?? 0);
  const analytics = rawSignal.analytics || {};
  const seconds = num(rawSignal.secondsRemaining) ?? num(snapshot.secondsRemaining);
  const previousDiagnostic = state.diagnostics?.candidateBlocker || {};
  let history = Array.isArray(previousDiagnostic.history) ? previousDiagnostic.history.slice(-20) : [];
  const previousCurrent = previousDiagnostic.current || null;

  if (previousCurrent?.cycleKey && previousCurrent.cycleKey !== key) {
    const closed = {
      ...previousCurrent,
      closedAt: num(snapshot.serverTime) ?? Date.now(),
      resultAtClose: {
        uiState: previousCurrent.uiState || null,
        state: previousCurrent.state || null,
        direction: previousCurrent.publishedDirection || null,
        score: previousCurrent.score ?? null,
        reason: previousCurrent.reason || null
      }
    };
    history = [...history.filter(row => row?.cycleKey !== closed.cycleKey), closed].slice(-20);
  }

  const sameCyclePrevious = previousCurrent?.cycleKey === key ? previousCurrent : null;
  const previousMin = num(sameCyclePrevious?.minSecondsRemaining);
  const minSecondsRemaining = seconds == null
    ? previousMin
    : previousMin == null ? seconds : Math.min(previousMin, seconds);
  const publishedDirection = ['BUY', 'SELL'].includes(clean(outputSignal.direction).toUpperCase())
    ? clean(outputSignal.direction).toUpperCase()
    : null;
  const policySource = state.professionalDecision?.candidateBlockerPolicy || null;
  const policy = policySource && (!policySource.cycleKey || policySource.cycleKey === key)
    ? {
        ...policySource,
        finalBlockMessage: clean(state.professionalDecision?.reason || '')
      }
    : null;

  const current = {
    cycleKey: key,
    targetStart: num(cycle?.targetStart),
    asset: clean(snapshot.asset || ''),
    timeframe: clean(snapshot.analysisTimeframe || snapshot.timeframe || rawSignal.timeframe || ''),
    firstObservedAt: num(sameCyclePrevious?.firstObservedAt) ?? (num(snapshot.serverTime) ?? Date.now()),
    lastObservedAt: num(snapshot.serverTime) ?? Date.now(),
    uiState: clean(outputSignal.uiState || ''),
    rawUiState: clean(rawSignal.uiState || ''),
    state: clean(outputSignal.state || ''),
    publishedDirection,
    candidateDirection: direction,
    score,
    minSecondsRemaining,
    regime: clean(rawSignal.regime?.type || 'unknown'),
    metrics: {
      buyPower: Number(analytics.buyPower || 0),
      sellPower: Number(analytics.sellPower || 0),
      candidatePower: Number(direction === 'BUY' ? analytics.buyPower : direction === 'SELL' ? analytics.sellPower : 0) || 0,
      currentStrength: Number(analytics.currentStrength || 0),
      rejectionStrength: Number(analytics.rejectionStrength || 0),
      continuationScore: Number(analytics.continuationScore || 0),
      momentumScore: Number(analytics.momentumScore || 0)
    },
    possibleQuality: possibleQualityTelemetry(rawSignal, direction, score, thresholds),
    decisionQuality: decisionQualityTelemetry(rawSignal, direction, thresholds),
    policy,
    locked: cycle?.locked || null,
    reason: clean(outputSignal.reason || rawSignal.reason || '')
  };

  return {
    ...result,
    diagnostics: {
      ...(result?.diagnostics || {}),
      candidateBlocker: {
        current,
        history,
        updatedAt: current.lastObservedAt
      }
    }
  };
}

function possibleWithHysteresis(cycle, allowed, direction, at) {
  if (allowed && direction) {
    cycle.possibleDirection = direction;
    cycle.possibleWeakHits = 0;
    cycle.possibleWeakSince = null;
    cycle.possibleLastStrongAt = at;
    return direction;
  }
  // Live CasaTrade ticks can briefly weaken for a few hundred milliseconds.
  // Do not erase a valid POSSÍVEL just because two fast samples were weak.
  // The weak state must be both repeated and sustained for 2.5s.
  if (!cycle.possibleDirection) return null;
  cycle.possibleWeakHits = Number(cycle.possibleWeakHits || 0) + 1;
  if (!(Number(cycle.possibleWeakSince || 0) > 0)) cycle.possibleWeakSince = at;
  const weakForMs = Math.max(0, at - Number(cycle.possibleWeakSince || at));
  if (cycle.possibleWeakHits < POSSIBLE_DROP_HITS || weakForMs < POSSIBLE_WEAK_HOLD_MS) {
    return cycle.possibleDirection;
  }
  cycle.possibleDirection = null;
  cycle.possibleWeakHits = 0;
  cycle.possibleWeakSince = null;
  return null;
}

function observeCandidatePersistence(cycle, direction, qualifies, score, at, thresholds = getThresholds()) {
  const rawDirection = ['BUY', 'SELL'].includes(direction) ? direction : null;
  const acceptedDirection = qualifies && rawDirection && Number(score) >= CANDIDATE_PERSISTENCE_MIN_SCORE
    ? rawDirection
    : null;
  const bucket = Math.floor(at / CANDIDATE_PERSISTENCE_BUCKET_MS);
  const previous = Array.isArray(cycle.persistenceSamples) ? cycle.persistenceSamples : [];
  let samples = previous.filter(row => Number(row?.at || 0) >= at - CANDIDATE_PERSISTENCE_WINDOW_MS);
  const sample = { at, bucket, direction: acceptedDirection, rawDirection, score: Number(score) || 0 };
  if (samples.length && samples[samples.length - 1]?.bucket === bucket) samples[samples.length - 1] = sample;
  else samples.push(sample);
  samples = samples.slice(-24);
  cycle.persistenceSamples = samples;

  const total = samples.length;
  const buyCount = samples.filter(row => row.direction === 'BUY').length;
  const sellCount = samples.filter(row => row.direction === 'SELL').length;
  const dominantDirection = buyCount === sellCount
    ? (cycle.persistenceDirection || acceptedDirection || rawDirection || null)
    : (buyCount > sellCount ? 'BUY' : 'SELL');
  const dominantRows = dominantDirection ? samples.filter(row => row.direction === dominantDirection) : [];
  const dominantCount = dominantRows.length;
  const ratio = total ? dominantCount / total : 0;
  const averageScore = dominantCount
    ? dominantRows.reduce((sum, row) => sum + Number(row.score || 0), 0) / dominantCount
    : 0;
  const lastStrongAt = dominantRows.length ? Number(dominantRows[dominantRows.length - 1].at || 0) : 0;
  const lastStrongAgeMs = lastStrongAt > 0 ? Math.max(0, at - lastStrongAt) : Infinity;
  const strongOpposite = !!dominantDirection && samples.some(row =>
    row.rawDirection
    && row.rawDirection !== dominantDirection
    && Number(row.score || 0) >= Number(thresholds.confirmScore || 0)
    && at - Number(row.at || 0) <= DECISION_HIT_GAP_MS
  );
  const armed = !!dominantDirection
    && total >= CANDIDATE_PERSISTENCE_MIN_SAMPLES
    && dominantCount >= 3
    && ratio >= CANDIDATE_PERSISTENCE_MIN_RATIO
    && averageScore >= CANDIDATE_PERSISTENCE_MIN_SCORE
    && lastStrongAgeMs <= CANDIDATE_PERSISTENCE_MAX_GAP_MS
    && !strongOpposite;

  if (armed) cycle.persistenceDirection = dominantDirection;
  return {
    armed,
    direction: dominantDirection,
    sampleCount: total,
    dominantCount,
    ratio,
    averageScore,
    lastStrongAt: lastStrongAt || null,
    lastStrongAgeMs: Number.isFinite(lastStrongAgeMs) ? lastStrongAgeMs : null,
    strongOpposite
  };
}

function seedCycle(key, snapshot, signal, state = {}) {
  const stored = state?.decisionCycle;
  let cycle = cycles.get(key);
  if (!cycle && stored?.key === key) cycle = { ...stored };
  if (!cycle) {
    cycle = {
      key, targetStart: targetStartOf(snapshot, signal), candidateDirection: null,
      confirmHits: 0, lastHitAt: null, decisionWeakSince: null, locked: null, direction: null, score: 0,
      setup: null, reason: null, decidedAt: null, resolved: false,
      confirmationMode: null, persistenceDirection: null, persistenceSamples: [], persistence: null,
      decisionWindowSamples: 0, lastDecisionWindowBucket: null
    };
  }
  cycles.set(key, cycle);
  return cycle;
}

function observeDecision(cycle, direction, qualifies, at) {
  if (!qualifies || !direction) {
    const hasCandidate = ['BUY', 'SELL'].includes(cycle.candidateDirection)
      && Number(cycle.confirmHits || 0) > 0
      && cycle.lastHitAt != null;
    const sameOrTemporarilyMissingDirection = !direction || direction === cycle.candidateDirection;
    if (hasCandidate && sameOrTemporarilyMissingDirection) {
      if (!(Number(cycle.decisionWeakSince || 0) > 0)) cycle.decisionWeakSince = at;
      const weakForMs = Math.max(0, at - Number(cycle.decisionWeakSince || at));
      if (weakForMs < DECISION_WEAK_HOLD_MS
        && at - Number(cycle.lastHitAt) <= DECISION_HIT_GAP_MS) {
        return false;
      }
    }
    cycle.candidateDirection = null;
    cycle.confirmHits = 0;
    cycle.lastHitAt = null;
    cycle.decisionWeakSince = null;
    return false;
  }
  const same = cycle.candidateDirection === direction
    && cycle.lastHitAt != null
    && at - Number(cycle.lastHitAt) <= DECISION_HIT_GAP_MS;
  cycle.candidateDirection = direction;
  cycle.confirmHits = same ? Number(cycle.confirmHits || 0) + 1 : 1;
  cycle.lastHitAt = at;
  cycle.decisionWeakSince = null;
  return cycle.confirmHits >= CONFIRM_HITS;
}

function appendTrace(state = {}, row = {}) {
  const rows = Array.isArray(state.decisionTrace) ? state.decisionTrace : [];
  return [...rows.filter(item => item?.key !== row.key), row].slice(-40);
}

function enterSignal(signal, cycle, direction, score, reason = null, confirmationMode = 'STRONG', persistence = null) {
  return {
    ...signal, state: 'CONFIRM', direction, diagnosis: direction,
    uiState: direction === 'BUY' ? 'ENTER_BUY' : 'ENTER_SELL', provisional: false, phase: 'FINAL',
    score, analysisScore: score, setup: cycle.setup || signal.setup || null,
    confirmationMode,
    candidatePersistence: persistence || cycle.persistence || signal.candidatePersistence || null,
    reason: reason || `ENTRAR NA PRÓXIMA VELA: ${direction === 'BUY' ? 'COMPRA' : 'VENDA'} — padrão confirmado para a próxima abertura.`,
    hint: reason || `ENTRAR NA PRÓXIMA VELA: ${direction === 'BUY' ? 'COMPRA' : 'VENDA'}.`,
    targetStart: cycle.targetStart
  };
}

function waitSignal(signal, reason) {
  return {
    ...signal, state: 'NO_TRADE', direction: null, diagnosis: 'WAIT', uiState: 'WAIT',
    provisional: false, phase: 'FINAL', reason, hint: reason
  };
}

function possibleSignal(signal, windows, direction, score, persistence = null) {
  const seconds = Math.max(0, Math.ceil(Number(signal.secondsRemaining || 0)));
  const side = direction === 'BUY' ? 'COMPRA' : 'VENDA';
  const waiting = clean(signal.waitingFor?.text || signal.reason || 'aguardando confirmação final do padrão');
  const armed = !!persistence?.armed && persistence.direction === direction;
  const dominance = armed ? Math.round(Number(persistence.ratio || 0) * 100) : 0;
  const reason = armed
    ? `${side} ARMADA • ${seconds}s restantes — persistência ${dominance}% e score médio ${Math.round(Number(persistence.averageScore || 0))}/100.`
    : `POSSÍVEL ${side} • ${seconds}s restantes — ${waiting}`;
  return {
    ...signal,
    state: 'WATCH', direction, diagnosis: direction,
    uiState: direction === 'BUY' ? 'POSSIBLE_BUY' : 'POSSIBLE_SELL',
    provisional: true, phase: armed ? 'ARMED' : 'POSSIBLE', score, analysisScore: score,
    candidatePersistence: persistence,
    reason, hint: reason, decisionWindow: windows
  };
}

function decidingSignal(signal, windows) {
  const seconds = Math.max(0, Math.ceil(Number(signal.secondsRemaining || 0)));
  const waiting = clean(signal.waitingFor?.text || signal.reason || 'checando força, rejeição, continuação e momentum');
  const reason = `DECIDINDO A PRÓXIMA VELA • ${seconds}s restantes — ${waiting}`;
  return { ...signal, state: 'WAIT', direction: null, diagnosis: 'WAIT', uiState: 'DECIDING', provisional: true, phase: 'FINAL', reason, hint: reason, decisionWindow: windows };
}

function buildingSignal(signal, windows) {
  const direction = directionOf(signal);
  const reason = direction
    ? `Montando a leitura da próxima vela • viés ${direction === 'BUY' ? 'comprador' : 'vendedor'} em formação.`
    : (signal.waitingFor?.text || 'Montando a leitura da próxima vela com as velas recentes e a vela atual.');
  return { ...signal, state: 'WAIT', direction: null, diagnosis: 'WAIT', uiState: 'BUILDING_PATTERN', provisional: true, phase: 'BUILDING', reason, hint: reason, decisionWindow: windows };
}

function targetCandle(snapshot = {}, result = {}, targetBucket, tfMs) {
  const current = result?.currentCandle || null;
  const currentTime = num(current?.time ?? current?.timestamp);
  if (currentTime != null && Math.floor(currentTime / tfMs) * tfMs === targetBucket) return current;
  const rows = Array.isArray(snapshot.candles) ? snapshot.candles : [];
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    let time = num(row?.time ?? row?.timestamp);
    if (time != null && time > 0 && time < 1e12) time *= 1000;
    if (time == null || Math.floor(time / tfMs) * tfMs !== targetBucket) continue;
    return row;
  }
  return null;
}

function completedFromCycle(cycle, snapshot = {}, result = {}) {
  const now = num(snapshot.serverTime) ?? Date.now();
  const asset = clean(snapshot.asset || '');
  const timeframe = clean(snapshot.analysisTimeframe || snapshot.timeframe || result?.signal?.timeframe || 'M1').toUpperCase();
  const tfMs = timeframeMs(timeframe);
  const targetStart = Number(cycle.targetStart);
  if (!Number.isFinite(targetStart) || targetStart <= 0) return null;
  const targetBucket = Math.round(targetStart / tfMs) * tfMs;
  if (now < targetBucket) return null;
  const exactTarget = targetCandle(snapshot, result, targetBucket, tfMs);
  const entryPrice = num(exactTarget?.open);
  const entryConfirmed = entryPrice != null;
  return {
    state: 'CONFIRM', direction: cycle.direction, score: Number(cycle.score || 0), time: targetBucket,
    targetStart: targetBucket, entryPrice: entryConfirmed ? entryPrice : null,
    entryTime: entryConfirmed ? targetBucket : null, entryConfirmed,
    entryStatus: entryConfirmed ? 'confirmed' : 'unconfirmed',
    entryReason: entryConfirmed ? null : 'Preço de entrada não confirmado: a vela-alvo não foi observada.',
    capturedAt: entryConfirmed ? now : null, asset, timeframe
  };
}

function wrapperCompletionKey(decision = {}) {
  return `${assetIdentity(decision.asset)}|${clean(decision.timeframe).toUpperCase()}|${Number(decision.targetStart || 0)}`;
}
function rememberWrapperCompleted(decision = {}) {
  if (!decision || decision.state !== 'CONFIRM') return;
  const key = wrapperCompletionKey(decision);
  if (!key || key.endsWith('|0')) return;
  wrapperCompletedDecisions.set(key, { ...decision });
  if (wrapperCompletedDecisions.size > 50) {
    const oldest = [...wrapperCompletedDecisions.entries()].sort((a, b) => Number(a[1]?.targetStart || 0) - Number(b[1]?.targetStart || 0))[0]?.[0];
    if (oldest) wrapperCompletedDecisions.delete(oldest);
  }
}
function latestWrapperCompleted(snapshot = {}) {
  const asset = clean(snapshot.asset || '');
  const timeframe = clean(snapshot.analysisTimeframe || snapshot.timeframe || 'M1').toUpperCase();
  return [...wrapperCompletedDecisions.values()].filter(row => sameAsset(row?.asset, asset) && clean(row?.timeframe).toUpperCase() === timeframe)
    .sort((a, b) => Number(b?.targetStart || 0) - Number(a?.targetStart || a?.time || 0))[0] || null;
}
function newerDecision(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return Number(b.targetStart || b.time || 0) > Number(a.targetStart || a.time || 0) ? b : a;
}

function resolveWrapperDecision(snapshot = {}, result = {}, currentKey = '', state = {}) {
  const now = num(snapshot.serverTime) ?? Date.now();
  const asset = clean(snapshot.asset || '');
  const timeframe = clean(snapshot.analysisTimeframe || snapshot.timeframe || 'M1').toUpperCase();
  const candidates = [...cycles.values()];
  const persisted = state?.decisionCycle;
  if (persisted?.locked === 'ENTER' && !persisted.resolved && !candidates.some(row => row?.key === persisted.key)) candidates.push({ ...persisted });
  for (const cycle of candidates) {
    if (!cycle || cycle.key === currentKey || cycle.locked !== 'ENTER' || cycle.resolved) continue;
    const cycleAsset = clean(cycle.key).split('|')[0] || asset;
    const cycleTimeframe = clean(cycle.key).split('|')[1] || timeframe;
    if (!sameAsset(cycleAsset, asset) || cycleTimeframe.toUpperCase() !== timeframe) continue;
    if (!Number.isFinite(Number(cycle.targetStart)) || now < Number(cycle.targetStart)) continue;
    const completed = completedFromCycle(cycle, snapshot, result);
    if (!completed) continue;
    cycle.resolved = true;
    cycles.set(cycle.key, cycle);
    rememberWrapperCompleted(completed);
    return completed;
  }
  return null;
}

export function processSnapshot(snapshot = {}, state = {}) {
  const thresholds = getThresholds(state.analystPreferences?.sensitivityProfile || 'MEDIO');
  const result = legacyProcessSnapshot(snapshot, state);
  const signal = result?.signal;
  if (!signal) return result;
  const secondsRemaining = num(signal.secondsRemaining);
  if (secondsRemaining == null) return result;

  const windows = decisionWindows(snapshot, signal, thresholds);
  const key = cycleKey(snapshot, signal);
  const cycle = seedCycle(key, snapshot, signal, state);
  const at = num(snapshot.serverTime) ?? Date.now();
  const score = Number(signal.analysisScore ?? signal.score ?? 0);
  const direction = directionOf(signal);
  const rawPossible = possibleQuality(signal, direction, score, thresholds);
  const possibleDirection = possibleWithHysteresis(cycle, rawPossible, direction, at);
  const persistence = observeCandidatePersistence(cycle, direction, rawPossible, score, at, thresholds);
  cycle.persistence = persistence;
  const canShowPossible = !!possibleDirection;
  const recovered = resolveWrapperDecision(snapshot, result, key, state);
  const rolledLastConfirmed = newerDecision(newerDecision(result.lastConfirmed, latestWrapperCompleted(snapshot)), recovered);
  const measured = output => candidateBlockerMeasured(output, snapshot, state, thresholds, key, cycle, signal);

  if (cycle.locked === 'ENTER') {
    return measured({ ...result, lastConfirmed: rolledLastConfirmed || result.lastConfirmed, signal: enterSignal(signal, cycle, cycle.direction, Math.max(score, Number(cycle.score || 0)), cycle.reason, cycle.confirmationMode || 'STRONG', cycle.persistence), decisionCycle: { ...cycle } });
  }
  if (cycle.locked === 'WAIT') {
    return measured({ ...result, lastConfirmed: rolledLastConfirmed || result.lastConfirmed, signal: waitSignal(signal, cycle.reason || 'AGUARDAR — padrão não confirmou a tempo.'), decisionCycle: { ...cycle } });
  }

  if (secondsRemaining > windows.pre) {
    const nextSignal = signal.state === 'WATCH' || signal.provisional ? buildingSignal(signal, windows) : signal;
    return measured({ ...result, lastConfirmed: rolledLastConfirmed || result.lastConfirmed, signal: nextSignal, decisionCycle: { ...cycle } });
  }
  if (secondsRemaining > windows.decision) {
    const nextSignal = canShowPossible ? possibleSignal(signal, windows, possibleDirection, score, persistence) : signal;
    return measured({ ...result, lastConfirmed: rolledLastConfirmed || result.lastConfirmed, signal: nextSignal, decisionCycle: { ...cycle } });
  }

  const decisionWindowBucket = Math.floor(at / CANDIDATE_PERSISTENCE_BUCKET_MS);
  if (cycle.lastDecisionWindowBucket !== decisionWindowBucket) {
    cycle.lastDecisionWindowBucket = decisionWindowBucket;
    cycle.decisionWindowSamples = Number(cycle.decisionWindowSamples || 0) + 1;
  }

  if (signal.state === 'CONFIRM' && ['BUY', 'SELL'].includes(signal.direction)) {
    cycle.locked = 'ENTER';
    cycle.direction = signal.direction;
    cycle.score = Math.max(score, Number(signal.score || 0));
    cycle.setup = signal.setup || null;
    cycle.reason = signal.reason;
    cycle.confirmationMode = signal.confirmationMode || 'STRONG';
    cycle.persistence = signal.candidatePersistence || persistence;
    cycle.decidedAt = at;
    cycles.set(key, cycle);
    const trace = appendTrace(state, { key, targetStart: cycle.targetStart, decision: 'ENTER', direction: cycle.direction, score: cycle.score, setup: cycle.setup, reason: cycle.reason, decidedAt: at });
    return measured({ ...result, lastConfirmed: rolledLastConfirmed || result.lastConfirmed, decisionCycle: { ...cycle }, decisionTrace: trace });
  }

  const quality = decisionQuality(signal, direction, thresholds);
  const stable = observeDecision(cycle, direction, quality.qualifies, at);
  if (quality.qualifies) cycle.setup = quality.setup;
  if (stable) {
    cycle.locked = 'ENTER';
    cycle.direction = direction;
    cycle.score = score;
    cycle.reason = `ENTRAR NA PRÓXIMA VELA: ${direction === 'BUY' ? 'COMPRA' : 'VENDA'} — ${cycle.setup || 'setup'} confirmado, score ${Math.round(score)}/100.`;
    cycle.confirmationMode = 'STRONG';
    cycle.persistence = persistence;
    cycle.decidedAt = at;
    cycles.set(key, cycle);
    const trace = appendTrace(state, { key, targetStart: cycle.targetStart, decision: 'ENTER', direction, score, setup: cycle.setup, reason: cycle.reason, decidedAt: at });
    return measured({ ...result, lastConfirmed: rolledLastConfirmed || result.lastConfirmed, signal: enterSignal(signal, cycle, direction, score, cycle.reason, 'STRONG', persistence), decisionCycle: { ...cycle }, decisionTrace: trace });
  }

  const persistenceDirection = persistence.armed && persistence.direction === possibleDirection
    ? possibleDirection
    : null;
  if (secondsRemaining < windows.decision
    && Number(cycle.decisionWindowSamples || 0) >= 2
    && persistenceDirection
    && canShowPossible) {
    cycle.locked = 'ENTER';
    cycle.direction = persistenceDirection;
    cycle.score = Math.max(score, Math.round(Number(persistence.averageScore || 0)));
    cycle.setup = cycle.setup || signal.setup || 'persistência do candidato';
    cycle.confirmationMode = 'PERSISTENCE';
    cycle.persistence = persistence;
    cycle.reason = `ENTRAR NA PRÓXIMA VELA: ${persistenceDirection === 'BUY' ? 'COMPRA' : 'VENDA'} — candidato dominante em ${Math.round(Number(persistence.ratio || 0) * 100)}% das leituras recentes, score médio ${Math.round(Number(persistence.averageScore || 0))}/100, sem oposição forte.`;
    cycle.decidedAt = at;
    cycles.set(key, cycle);
    const trace = appendTrace(state, { key, targetStart: cycle.targetStart, decision: 'ENTER', direction: cycle.direction, score: cycle.score, setup: cycle.setup, confirmationMode: cycle.confirmationMode, reason: cycle.reason, decidedAt: at });
    return measured({ ...result, lastConfirmed: rolledLastConfirmed || result.lastConfirmed, signal: enterSignal(signal, cycle, persistenceDirection, score, cycle.reason, 'PERSISTENCE', persistence), decisionCycle: { ...cycle }, decisionTrace: trace });
  }

  if (secondsRemaining <= windows.skip) {
    const blocker = clean(signal.waitingFor?.text || signal.reason || 'qualidade insuficiente para a próxima vela');
    cycle.locked = 'WAIT';
    cycle.direction = null;
    cycle.score = score;
    cycle.reason = `AGUARDAR — ${blocker}`;
    cycle.decidedAt = at;
    cycles.set(key, cycle);
    const trace = appendTrace(state, { key, targetStart: cycle.targetStart, decision: 'WAIT', direction: null, score, setup: cycle.setup, reason: cycle.reason, decidedAt: at });
    return measured({ ...result, lastConfirmed: rolledLastConfirmed || result.lastConfirmed, signal: waitSignal(signal, cycle.reason), decisionCycle: { ...cycle }, decisionTrace: trace });
  }

  cycles.set(key, cycle);
  const nextSignal = canShowPossible
    ? possibleSignal(signal, windows, possibleDirection, score, persistence)
    : decidingSignal(signal, windows);
  return { ...result, lastConfirmed: rolledLastConfirmed || result.lastConfirmed, signal: nextSignal, decisionCycle: { ...cycle } };
}

export function resetOrchestrator() {
  cycles.clear();
  wrapperCompletedDecisions.clear();
  legacyResetOrchestrator();
}

export function serializeCompletedDecisions() {
  const legacyRows = legacySerializeCompletedDecisions();
  const legacyKeys = new Set(legacyRows.map(row => wrapperCompletionKey(row?.decision || {})).filter(key => key && !key.endsWith('|0')));
  const wrapperRows = [...wrapperCompletedDecisions.entries()].filter(([key]) => !legacyKeys.has(key)).slice(-50).map(([key, decision]) => ({ key: `${WRAPPER_ROW_PREFIX}${key}`, decision: { ...decision } }));
  return [...legacyRows, ...wrapperRows].slice(-50);
}

export function restoreCompletedDecisions(rows = []) {
  wrapperCompletedDecisions.clear();
  const legacyRows = [];
  for (const row of Array.isArray(rows) ? rows.slice(-50) : []) {
    const key = clean(row?.key);
    const decision = row?.decision;
    if (!key || !decision || typeof decision !== 'object') continue;
    if (key.startsWith(WRAPPER_ROW_PREFIX)) wrapperCompletedDecisions.set(key.slice(WRAPPER_ROW_PREFIX.length), { ...decision });
    else legacyRows.push(row);
  }
  return legacyRestoreCompletedDecisions(legacyRows);
}