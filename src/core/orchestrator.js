import {
  processSnapshot as legacyProcessSnapshot,
  resetOrchestrator as legacyResetOrchestrator,
  serializeCompletedDecisions as legacySerializeCompletedDecisions,
  restoreCompletedDecisions as legacyRestoreCompletedDecisions
} from './orchestrator-legacy.js';
import { ANALYST_THRESHOLDS } from './analysis.js';

// Price action/indicators remain in the legacy analyst. This wrapper owns exactly
// one bounded decision for each target candle: ENTER BUY, ENTER SELL or WAIT.
const CONFIRM_HITS = 1;
const DECISION_HIT_GAP_MS = 6000;
const POSSIBLE_CONFIRM_HITS = 1;
const POSSIBLE_HIT_GAP_MS = 6000;
const OPPOSITE_SWITCH_HITS = 3;
const OPPOSITE_MIN_HOLD_MS = 4000;
const OPPOSITE_SCORE_MARGIN = 8;
const OPPOSITE_STALE_MS = 5000;
const FINAL_CANDIDATE_MIN_AGE_MS = 750;
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

function decisionWindows(snapshot = {}, signal = {}) {
  const timeframe = clean(snapshot.analysisTimeframe || snapshot.timeframe || signal.timeframe || 'M1').toUpperCase();
  const duration = Math.max(2, Math.round(timeframeMs(timeframe) / 1000));
  // M1 product contract: pre-signal at ~30s, final decision at ~10s,
  // and settle as WAIT near the close if no setup confirms.
  if (timeframe === 'M1' || timeframe === 'M5') return { pre: 30, decision: 15, skip: 4, duration, timeframe };

  // Other candles keep proportional windows.
  const pre = Math.max(2, Math.min(duration - 1, 60, Math.round(duration * .50)));
  const decision = Math.max(1, Math.min(pre - 1, 30, Math.round(duration * .25)));
  const skip = Math.max(1, Math.min(decision, 8, Math.round(duration * .067)));
  return { pre, decision, skip, duration, timeframe };
}

function cycleKey(snapshot = {}, signal = {}) {
  const asset = clean(snapshot.asset || 'unknown');
  const timeframe = clean(snapshot.analysisTimeframe || snapshot.timeframe || signal.timeframe || 'M1').toUpperCase();
  const tfMs = timeframeMs(timeframe);
  let currentAt = num(signal.currentCandle?.time ?? signal.currentCandle?.timestamp ?? snapshot.currentCandle?.time ?? snapshot.currentCandle?.timestamp);
  if (currentAt != null && currentAt > 0 && currentAt < 1e12) currentAt *= 1000;
  if (currentAt != null) {
    const bucket = Math.floor(currentAt / tfMs) * tfMs;
    return `${asset}|${timeframe}|${bucket + tfMs}`;
  }
  const sampleAt = num(snapshot.serverTime) ?? Date.now();
  const seconds = num(signal.secondsRemaining) ?? num(snapshot.secondsRemaining) ?? 0;
  const rawTarget = num(signal.targetStart) ?? (sampleAt + Math.max(0, seconds) * 1000);
  // Fallback must identify the target CANDLE, not a 5-second slice. Otherwise
  // countdown jitter creates a new cycle and erases candidate hysteresis.
  const targetKey = Math.round(rawTarget / tfMs) * tfMs;
  return `${asset}|${timeframe}|${targetKey}`;
}

function targetStartOf(snapshot = {}, signal = {}) {
  const sampleAt = num(snapshot.serverTime) ?? Date.now();
  const seconds = num(signal.secondsRemaining) ?? num(snapshot.secondsRemaining) ?? 0;
  return num(signal.targetStart) ?? (sampleAt + Math.max(0, seconds) * 1000);
}

function patternEvidence(signal = {}, direction = null) {
  if (!direction) return { identified: false, setup: null, count: 0 };
  const analytics = signal.analytics || {};
  const declared = clean(signal.setup || '');
  const inferred = inferSetup(signal, direction);
  const power = Number(direction === 'BUY' ? analytics.buyPower : analytics.sellPower) || 0;
  const currentStrength = Number(analytics.currentStrength || 0);
  const rejection = String(analytics.rejectionDirection || '').toUpperCase() === direction
    && Number(analytics.rejectionStrength || 0) >= 38;
  const continuation = String(analytics.continuationDirection || '').toUpperCase() === direction
    && Number(analytics.continuationScore || 0) >= 48;
  const momentum = String(analytics.momentumDirection || '').toUpperCase() === direction
    && Number(analytics.momentumScore || 0) >= 38;
  const breakout = analytics.strongBreakout === true
    && String(analytics.breakoutDirection || '').toUpperCase() === direction;
  const directionalCandle = power >= 48 && currentStrength >= 45;
  const evidence = [rejection, continuation, momentum, breakout, directionalCandle].filter(Boolean).length;
  const setup = inferred || declared || (rejection ? 'rejeição' : continuation ? 'continuação' : momentum ? 'momentum' : breakout ? 'rompimento' : directionalCandle ? 'força direcional' : null);
  return { identified: !!setup || evidence > 0, setup, count: evidence };
}

function decisionQuality(signal = {}, direction = null) {
  if (!direction) return { qualifies: false, setup: null, blocker: 'no-direction' };
  const score = Number(signal.analysisScore ?? signal.score ?? 0);
  if (score < ANALYST_THRESHOLDS.confirmScore) return { qualifies: false, setup: null, blocker: 'score' };

  // v0.11.43 had become a gate cascade: score + very specific setup +
  // two final hits inside 2.5s + 3s candidate age. On Android/tablet that
  // combination could keep a real 60+ pattern in WAIT forever. Final entry now
  // needs the technical score plus one identifiable directional pattern. Asset
  // quality remains advisory; it does not veto an otherwise valid signal.
  const pattern = patternEvidence(signal, direction);
  if (!pattern.identified) return { qualifies: false, setup: null, blocker: 'no-pattern' };
  return { qualifies: true, setup: pattern.setup || clean(signal.setup || '') || 'padrão direcional', blocker: null, evidenceCount: pattern.count };
}
function inferSetup(signal = {}, direction = null) {
  if (!direction) return null;
  const a = signal.analytics || {};
  const regime = String(signal.regime?.type || '').toLowerCase();
  const counterTrend = regime === 'uptrend'
    ? direction === 'SELL'
    : regime === 'downtrend'
      ? direction === 'BUY'
      : false;
  const exhaustionRisk = a.exhaustionRisk === true || a.overextendedImpulse === true;

  if (String(a.rejectionDirection || '').toUpperCase() === direction && Number(a.rejectionStrength || 0) >= 40) return 'rejeição';
  if (exhaustionRisk || counterTrend) return null;
  if (a.strongBreakout === true && String(a.breakoutDirection || '').toUpperCase() === direction) return 'rompimento';
  if (String(a.continuationDirection || '').toUpperCase() === direction && Number(a.continuationScore || 0) >= 50) return 'continuação';
  if (String(a.momentumDirection || '').toUpperCase() === direction && Number(a.momentumScore || 0) >= 40) return 'momentum';
  const power = Number(direction === 'BUY' ? a.buyPower : a.sellPower) || 0;
  if (power >= 50 && Number(a.currentStrength || 0) >= 50) return 'força direcional';
  return null;
}

function observeStablePossible(cycle, signal = {}, at = Date.now()) {
  const rawDirection = directionOf(signal);
  const rawScore = Number(signal.analysisScore ?? signal.score ?? 0);
  const pattern = patternEvidence(signal, rawDirection);
  const qualifies = ['BUY','SELL'].includes(rawDirection)
    && rawScore >= ANALYST_THRESHOLDS.possibleScore
    && pattern.identified;

  if (!cycle.possibleDirection) {
    if (!qualifies) {
      cycle.candidateDirection = null;
      cycle.candidateHits = 0;
      cycle.lastCandidateAt = null;
      return null;
    }
    const same = cycle.candidateDirection === rawDirection
      && cycle.lastCandidateAt != null
      && at - Number(cycle.lastCandidateAt) <= POSSIBLE_HIT_GAP_MS;
    cycle.candidateDirection = rawDirection;
    cycle.candidateHits = same ? Number(cycle.candidateHits || 0) + 1 : 1;
    cycle.lastCandidateAt = at;
    if (cycle.candidateHits >= POSSIBLE_CONFIRM_HITS) {
      cycle.possibleDirection = rawDirection;
      cycle.possibleScore = rawScore;
      cycle.possibleSince = at;
      cycle.lastPossibleStrongAt = at;
      cycle.setup = pattern.setup || inferSetup(signal, rawDirection) || cycle.setup;
    }
    return cycle.possibleDirection;
  }

  if (qualifies && rawDirection === cycle.possibleDirection) {
    cycle.possibleScore = rawScore;
    cycle.lastPossibleStrongAt = at;
    cycle.setup = pattern.setup || inferSetup(signal, rawDirection) || cycle.setup;
    cycle.oppositeDirection = null;
    cycle.oppositeHits = 0;
    cycle.oppositeSince = null;
    cycle.lastOppositeAt = null;
    return cycle.possibleDirection;
  }

  if (qualifies && rawDirection !== cycle.possibleDirection) {
    const sameOpposite = cycle.oppositeDirection === rawDirection
      && cycle.lastOppositeAt != null
      && at - Number(cycle.lastOppositeAt) <= POSSIBLE_HIT_GAP_MS;
    cycle.oppositeDirection = rawDirection;
    cycle.oppositeHits = sameOpposite ? Number(cycle.oppositeHits || 0) + 1 : 1;
    cycle.oppositeSince = sameOpposite && Number(cycle.oppositeSince || 0) > 0
      ? Number(cycle.oppositeSince)
      : at;
    cycle.lastOppositeAt = at;

    const currentStaleFor = at - Number(cycle.lastPossibleStrongAt || cycle.possibleSince || at);
    const oppositeHeldFor = at - Number(cycle.oppositeSince || at);
    const strongerByMargin = rawScore >= Math.max(ANALYST_THRESHOLDS.confirmScore, Number(cycle.possibleScore || 0) + OPPOSITE_SCORE_MARGIN);
    const replacesStaleCandidate = currentStaleFor >= OPPOSITE_STALE_MS && rawScore >= ANALYST_THRESHOLDS.confirmScore;
    if (cycle.oppositeHits >= OPPOSITE_SWITCH_HITS
        && oppositeHeldFor >= OPPOSITE_MIN_HOLD_MS
        && (strongerByMargin || replacesStaleCandidate)) {
      const from = cycle.possibleDirection;
      cycle.possibleDirection = rawDirection;
      cycle.possibleScore = rawScore;
      cycle.possibleSince = at;
      cycle.lastPossibleStrongAt = at;
      cycle.setup = inferSetup(signal, rawDirection);
      cycle.directionTransition = { from, to: rawDirection, at };
      cycle.candidateDirection = rawDirection;
      cycle.candidateHits = POSSIBLE_CONFIRM_HITS;
      cycle.lastCandidateAt = at;
      cycle.oppositeDirection = null;
      cycle.oppositeHits = 0;
      cycle.oppositeSince = null;
      cycle.lastOppositeAt = null;
      cycle.confirmDirection = null;
      cycle.confirmHits = 0;
      cycle.lastHitAt = null;
    }
  }

  // Once published, a POSSÍVEL direction is sticky for the rest of this candle.
  // Weak/null ticks do not erase it. Only a sustained, materially stronger
  // opposite direction may replace it.
  return cycle.possibleDirection;
}

function seedCycle(key, snapshot, signal, state = {}) {
  const stored = state?.decisionCycle;
  let cycle = cycles.get(key);
  if (!cycle && stored?.key === key) cycle = { ...stored };
  if (!cycle) {
    cycle = {
      key, targetStart: targetStartOf(snapshot, signal),
      candidateDirection: null, candidateHits: 0, lastCandidateAt: null,
      possibleDirection: null, possibleScore: 0, possibleSince: null, lastPossibleStrongAt: null,
      oppositeDirection: null, oppositeHits: 0, oppositeSince: null, lastOppositeAt: null,
      directionTransition: null,
      confirmHits: 0, lastHitAt: null, locked: null, direction: null, score: 0,
      setup: null, reason: null, decidedAt: null, resolved: false
    };
  }
  cycles.set(key, cycle);
  return cycle;
}

function observeDecision(cycle, direction, qualifies, at) {
  if (!qualifies || !direction) {
    cycle.candidateDirection = null;
    cycle.confirmHits = 0;
    cycle.lastHitAt = null;
    return false;
  }
  const same = cycle.candidateDirection === direction
    && cycle.lastHitAt != null
    && at - Number(cycle.lastHitAt) <= DECISION_HIT_GAP_MS;
  cycle.candidateDirection = direction;
  cycle.confirmHits = same ? Number(cycle.confirmHits || 0) + 1 : 1;
  cycle.lastHitAt = at;
  return cycle.confirmHits >= CONFIRM_HITS;
}

function appendTrace(state = {}, row = {}) {
  const rows = Array.isArray(state.decisionTrace) ? state.decisionTrace : [];
  return [...rows.filter(item => item?.key !== row.key), row].slice(-40);
}

function enterSignal(signal, cycle, direction, score, reason = null) {
  return {
    ...signal, state: 'CONFIRM', direction, diagnosis: direction,
    uiState: direction === 'BUY' ? 'ENTER_BUY' : 'ENTER_SELL', provisional: false, phase: 'FINAL',
    score, analysisScore: score, setup: cycle.setup || signal.setup || null,
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

function possibleSignal(signal, windows, direction, score, cycle = {}) {
  const seconds = Math.max(0, Math.ceil(Number(signal.secondsRemaining || 0)));
  const side = direction === 'BUY' ? 'COMPRA' : 'VENDA';
  const rawDirection = directionOf(signal);
  const waiting = rawDirection === direction
    ? clean(signal.waitingFor?.text || signal.reason || 'aguardando confirmação final do padrão')
    : `mantendo o padrão ${side.toLowerCase()} já confirmado nesta vela enquanto a leitura instantânea oscila`;
  const reason = `POSSÍVEL ${side} • ${seconds}s restantes — ${waiting}`;
  const transition = cycle.directionTransition && Date.now() - Number(cycle.directionTransition.at || 0) < 3500
    ? { ...cycle.directionTransition }
    : null;
  const candidateScore = Number(cycle.possibleScore || score || 0);
  return {
    ...signal,
    state: 'WATCH', direction, diagnosis: direction,
    uiState: direction === 'BUY' ? 'POSSIBLE_BUY' : 'POSSIBLE_SELL',
    provisional: true, phase: 'POSSIBLE',
    score: candidateScore,
    analysisScore: candidateScore,
    setup: cycle.setup || signal.setup || null,
    directionTransition: transition,
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
  const result = legacyProcessSnapshot(snapshot, state);
  const signal = result?.signal;
  if (!signal) return result;
  const secondsRemaining = num(signal.secondsRemaining);
  if (secondsRemaining == null) return result;

  const windows = decisionWindows(snapshot, signal);
  const key = cycleKey(snapshot, signal);
  const cycle = seedCycle(key, snapshot, signal, state);
  const at = num(snapshot.serverTime) ?? Date.now();
  const score = Number(signal.analysisScore ?? signal.score ?? 0);
  const rawDirection = directionOf(signal);
  const stableDirection = observeStablePossible(cycle, signal, at);
  const recovered = resolveWrapperDecision(snapshot, result, key, state);
  const rolledLastConfirmed = newerDecision(newerDecision(result.lastConfirmed, latestWrapperCompleted(snapshot)), recovered);

  if (cycle.locked === 'ENTER') {
    return { ...result, lastConfirmed: rolledLastConfirmed || result.lastConfirmed, signal: enterSignal(signal, cycle, cycle.direction, Math.max(score, Number(cycle.score || 0)), cycle.reason), decisionCycle: { ...cycle } };
  }
  if (cycle.locked === 'WAIT') {
    return { ...result, lastConfirmed: rolledLastConfirmed || result.lastConfirmed, signal: waitSignal(signal, cycle.reason || 'AGUARDAR — padrão não confirmou a tempo.'), decisionCycle: { ...cycle } };
  }

  // Before 30s, keep building even if a directional bias already exists.
  // The user-facing POSSÍVEL window is intentionally bounded to the last ~30s.
  if (secondsRemaining > windows.pre) {
    cycles.set(key, cycle);
    return { ...result, lastConfirmed: rolledLastConfirmed || result.lastConfirmed, signal: buildingSignal(signal, windows), decisionCycle: { ...cycle } };
  }

  // Once a candidate has been published in this candle, never fall back to
  // AGUARDAR/BUILDING just because one live tick weakened. Keep the candidate
  // visible until final confirmation, a strong opposite replacement, or the
  // next candle/asset (which creates a new cycle).
  if (secondsRemaining > windows.decision) {
    const nextSignal = stableDirection
      ? possibleSignal(signal, windows, stableDirection, score, cycle)
      : buildingSignal(signal, windows);
    cycles.set(key, cycle);
    return { ...result, lastConfirmed: rolledLastConfirmed || result.lastConfirmed, signal: nextSignal, decisionCycle: { ...cycle } };
  }

  if (signal.state === 'CONFIRM' && ['BUY', 'SELL'].includes(signal.direction)
      && (!stableDirection || signal.direction === stableDirection)
      && decisionQuality(signal, signal.direction).qualifies) {
    cycle.locked = 'ENTER';
    cycle.direction = signal.direction;
    cycle.score = Math.max(score, Number(signal.score || 0), Number(cycle.possibleScore || 0));
    cycle.setup = signal.setup || cycle.setup || inferSetup(signal, cycle.direction);
    cycle.reason = signal.reason;
    cycle.decidedAt = at;
    cycles.set(key, cycle);
    const trace = appendTrace(state, { key, targetStart: cycle.targetStart, decision: 'ENTER', direction: cycle.direction, score: cycle.score, setup: cycle.setup, reason: cycle.reason, decidedAt: at });
    return { ...result, lastConfirmed: rolledLastConfirmed || result.lastConfirmed, signal: enterSignal(signal, cycle, cycle.direction, cycle.score, cycle.reason), decisionCycle: { ...cycle }, decisionTrace: trace };
  }

  if (stableDirection) {
    const quality = decisionQuality(signal, stableDirection);
    const candidateAge = at - Number(cycle.possibleSince || at);
    const stableFinal = observeDecision(
      cycle,
      stableDirection,
      quality.qualifies && candidateAge >= FINAL_CANDIDATE_MIN_AGE_MS,
      at
    );
    if (quality.qualifies) cycle.setup = quality.setup || cycle.setup || inferSetup(signal, stableDirection);
    if (stableFinal) {
      cycle.locked = 'ENTER';
      cycle.direction = stableDirection;
      cycle.score = Math.max(score, Number(cycle.possibleScore || 0));
      cycle.reason = `ENTRAR NA PRÓXIMA VELA: ${stableDirection === 'BUY' ? 'COMPRA' : 'VENDA'} — ${cycle.setup || 'setup'} confirmado, score ${Math.round(cycle.score)}/100.`;
      cycle.decidedAt = at;
      cycles.set(key, cycle);
      const trace = appendTrace(state, { key, targetStart: cycle.targetStart, decision: 'ENTER', direction: stableDirection, score: cycle.score, setup: cycle.setup, reason: cycle.reason, decidedAt: at });
      return { ...result, lastConfirmed: rolledLastConfirmed || result.lastConfirmed, signal: enterSignal(signal, cycle, stableDirection, cycle.score, cycle.reason), decisionCycle: { ...cycle }, decisionTrace: trace };
    }
  }

  if (secondsRemaining <= windows.skip) {
    const blocker = clean(signal.waitingFor?.text || signal.reason || 'qualidade insuficiente para a próxima vela');
    cycle.locked = 'WAIT';
    cycle.direction = null;
    cycle.score = Math.max(score, Number(cycle.possibleScore || 0));
    cycle.reason = `AGUARDAR — ${blocker}`;
    cycle.decidedAt = at;
    cycles.set(key, cycle);
    const trace = appendTrace(state, { key, targetStart: cycle.targetStart, decision: 'WAIT', direction: null, score: cycle.score, setup: cycle.setup, reason: cycle.reason, decidedAt: at });
    return { ...result, lastConfirmed: rolledLastConfirmed || result.lastConfirmed, signal: waitSignal(signal, cycle.reason), decisionCycle: { ...cycle }, decisionTrace: trace };
  }

  cycles.set(key, cycle);
  const nextSignal = stableDirection
    ? possibleSignal(signal, windows, stableDirection, score, cycle)
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