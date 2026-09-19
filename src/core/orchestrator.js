import {
  processSnapshot as legacyProcessSnapshot,
  resetOrchestrator as legacyResetOrchestrator,
  serializeCompletedDecisions as legacySerializeCompletedDecisions,
  restoreCompletedDecisions as legacyRestoreCompletedDecisions
} from './orchestrator-legacy.js';
import { ANALYST_THRESHOLDS } from './analysis.js';
import { assessHighConfidence, A_PLUS_THRESHOLDS } from './high-confidence.js';

// Price action/indicators remain in the legacy analyst. This wrapper owns exactly
// one bounded decision for each target candle: ENTER BUY, ENTER SELL or WAIT.
const CONFIRM_HITS = 2;
const DECISION_HIT_GAP_MS = 2500;
const POSSIBLE_CONFIRM_HITS = 2;
const POSSIBLE_HIT_GAP_MS = 8000;
const OPPOSITE_SWITCH_HITS = 3;
const OPPOSITE_MIN_HOLD_MS = 4000;
const OPPOSITE_SCORE_MARGIN = 8;
const OPPOSITE_STALE_MS = 5000;
const FINAL_CANDIDATE_MIN_AGE_MS = 3000;
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
  // Explicit product windows for the two supported operating modes.
  // M1: final decision near 10s. M5: more time to act, final decision near 20s.
  if (timeframe === 'M1') return { pre: 30, decision: 10, skip: 4, duration, timeframe };
  if (timeframe === 'M5') return { pre: 90, decision: 20, skip: 6, duration, timeframe };

  // Other timeframes keep proportional windows.
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

function aPlusAssessment(snapshot = {}, result = {}, signal = {}, direction = null, cycle = {}, state = {}, at = Date.now()) {
  const effectiveSignal = cycle?.setup && !signal?.setup
    ? { ...signal, setup: cycle.setup }
    : cycle?.setup
      ? { ...signal, setup: cycle.setup }
      : signal;
  return assessHighConfidence({
    candles: snapshot.candles || [],
    currentCandle: result.currentCandle || signal.currentCandle || snapshot.currentCandle || null,
    signal: effectiveSignal,
    direction,
    cycle,
    journal: state.signalJournal || [],
    operatingTimeframe: snapshot.analysisTimeframe || snapshot.timeframe || signal.timeframe || 'M1',
    now: at
  });
}

function aPlusBlockText(aPlus = {}) {
  const labels = {
    'sem-direção': 'sem direção estável',
    'histórico-operacional-insuficiente': `histórico ${aPlus.operatingTimeframe || 'operacional'} insuficiente`,
    'histórico-contexto-insuficiente': `confirmação ${aPlus.contextTimeframe || 'superior'} insuficiente`,
    'contexto-contra-direção': `${aPlus.contextTimeframe || 'contexto maior'} contra a direção`,
    'estrutura-operacional-contexto-contra': `estrutura ${aPlus.operatingTimeframe || ''}/${aPlus.contextTimeframe || ''} contrária`,
    'breakout-sem-confirmação': 'rompimento sem confirmação',
    'vela-estendida-exaustão': 'vela esticada/exaustão',
    'compra-direto-na-resistência': 'compra muito perto da resistência',
    'venda-direto-no-suporte': 'venda muito perto do suporte',
    'range-no-meio-sem-borda': 'range sem entrada na borda',
    'volatilidade-morta': 'volatilidade muito baixa',
    'volatilidade-explosiva': 'volatilidade excessiva',
    'direção-trocou-recentemente': 'direção mudou recentemente',
    'setup-histórico-fraco': 'setup com histórico fraco'
  };
  const veto = (aPlus.hardVetoes || [])[0];
  if (veto) return labels[veto] || veto;
  const requiredPossible = Number(aPlus.thresholds?.possibleScore || A_PLUS_THRESHOLDS.possibleScore);
  if (Number(aPlus.score || 0) < requiredPossible) return `score A+ ${Math.round(Number(aPlus.score || 0))}/100 abaixo de ${requiredPossible}`;
  return 'confluência A+ ainda incompleta';
}

function withAPlus(signal = {}, aPlus = null) {
  return aPlus ? { ...signal, aPlus, qualityScore: Number(aPlus.score || 0), qualityMode: 'A_PLUS' } : signal;
}

function decisionQuality(signal = {}, direction = null) {
  if (!direction) return { qualifies: false, setup: null };
  const score = Number(signal.analysisScore ?? signal.score ?? 0);
  if (score < ANALYST_THRESHOLDS.confirmScore) return { qualifies: false, setup: null };

  const analytics = signal.analytics || {};
  const power = Number(direction === 'BUY' ? analytics.buyPower : analytics.sellPower) || 0;
  const currentStrength = Number(analytics.currentStrength || 0);
  const rejectionStrength = Number(analytics.rejectionStrength || 0);
  const directionalRejection = analytics.rejectionDirection === direction
    || Number(direction === 'BUY' ? analytics.rejectionBuy : analytics.rejectionSell) >= ANALYST_THRESHOLDS.rejectionStrength;
  const continuation = analytics.continuationDirection === direction && Number(analytics.continuationScore || 0) >= 55;
  const momentum = analytics.momentumDirection === direction && Number(analytics.momentumScore || 0) >= 40;
  const strongCandle = currentStrength >= ANALYST_THRESHOLDS.candleStrength;
  const rejection = directionalRejection && rejectionStrength >= ANALYST_THRESHOLDS.rejectionStrength;
  const regime = String(signal.regime?.type || '').toLowerCase();
  const trendAligned = regime === 'uptrend'
    ? direction === 'BUY'
    : regime === 'downtrend'
      ? direction === 'SELL'
      : false;
  const counterTrend = regime === 'uptrend'
    ? direction === 'SELL'
    : regime === 'downtrend'
      ? direction === 'BUY'
      : false;
  const trendCompatible = regime === 'unknown' || trendAligned;

  const strongBreakout = analytics.strongBreakout === true
    && String(analytics.breakoutDirection || '').toUpperCase() === direction;
  const breakoutMargin = Number(analytics.breakoutDistanceRatio || 0);
  const rangeMultiple = Number(analytics.currentRangeMultiple || 0);
  const exhaustionRisk = analytics.exhaustionRisk === true || analytics.overextendedImpulse === true;

  // A large final impulse can be exhaustion, not continuation. Continuation
  // entries are blocked when the current candle is stretched, unless a genuine
  // rejection setup is present. This prevents chasing the just-finished candle.
  if (exhaustionRisk && !rejection) {
    return { qualifies: false, setup: null, blocker: 'exhaustion-risk' };
  }

  const setups = regime === 'range'
    ? [
        { name: 'rejeição no range', ok: power >= 52 && rejection },
        {
          name: 'rompimento confirmado no range',
          ok: power >= 55
            && score >= 64
            && continuation
            && momentum
            && strongBreakout
            && breakoutMargin >= .18
            && rangeMultiple > 0
            && rangeMultiple <= 1.45
        }
      ]
    : [
        { name: 'rejeição', ok: power >= 48 && rejection },
        {
          name: 'continuação com tendência',
          ok: !counterTrend && trendCompatible && power >= 50 && continuation
        },
        {
          name: 'momentum com tendência',
          ok: !counterTrend && trendCompatible && power >= 50 && strongCandle && momentum
        },
        {
          name: 'rompimento com tendência',
          ok: !counterTrend && trendCompatible && power >= 50 && strongBreakout && breakoutMargin >= .18
        },
        {
          name: 'confluência forte',
          ok: !counterTrend && trendCompatible && power >= 48 && score >= 68 && momentum && (strongCandle || continuation || strongBreakout)
        }
      ];

  const matched = setups.find(item => item.ok) || null;
  return { qualifies: !!matched, setup: matched?.name || null, blocker: matched ? null : counterTrend ? 'counter-trend' : null };
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
  const qualifies = ['BUY','SELL'].includes(rawDirection) && rawScore >= ANALYST_THRESHOLDS.possibleScore;

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
      cycle.setup = inferSetup(signal, rawDirection) || cycle.setup;
    }
    return cycle.possibleDirection;
  }

  if (qualifies && rawDirection === cycle.possibleDirection) {
    cycle.possibleScore = rawScore;
    cycle.lastPossibleStrongAt = at;
    cycle.setup = inferSetup(signal, rawDirection) || cycle.setup;
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
      aPlusCandidateAllowed: false, aPlusWeakHits: 0, lastAPlusWeakAt: null,
      confirmHits: 0, lastHitAt: null, locked: null, direction: null, score: 0,
      setup: null, reason: null, decidedAt: null, resolved: false
    };
  }
  cycles.set(key, cycle);
  return cycle;
}

function observeStableAPlusCandidate(cycle, rawAllowed, at = Date.now()) {
  if (rawAllowed === true) {
    cycle.aPlusCandidateAllowed = true;
    cycle.aPlusWeakHits = 0;
    cycle.lastAPlusWeakAt = null;
    return true;
  }

  if (cycle.aPlusCandidateAllowed !== true) return false;

  const consecutiveWeak = cycle.lastAPlusWeakAt != null
    && at - Number(cycle.lastAPlusWeakAt) <= POSSIBLE_HIT_GAP_MS;
  cycle.aPlusWeakHits = consecutiveWeak ? Number(cycle.aPlusWeakHits || 0) + 1 : 1;
  cycle.lastAPlusWeakAt = at;

  if (cycle.aPlusWeakHits >= 2) {
    cycle.aPlusCandidateAllowed = false;
    cycle.aPlusWeakHits = 0;
    cycle.lastAPlusWeakAt = null;
  }
  return cycle.aPlusCandidateAllowed === true;
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

function enterSignal(signal, cycle, direction, score, reason = null, aPlus = null) {
  return {
    ...signal, state: 'CONFIRM', direction, diagnosis: direction,
    uiState: direction === 'BUY' ? 'ENTER_BUY' : 'ENTER_SELL', provisional: false, phase: 'FINAL',
    score, analysisScore: score, setup: cycle.setup || signal.setup || null,
    reason: reason || `ENTRAR NA PRÓXIMA VELA: ${direction === 'BUY' ? 'COMPRA' : 'VENDA'} — padrão confirmado para a próxima abertura.`,
    hint: reason || `ENTRAR NA PRÓXIMA VELA: ${direction === 'BUY' ? 'COMPRA' : 'VENDA'}.`,
    targetStart: cycle.targetStart,
    ...(aPlus ? { aPlus, qualityScore: Number(aPlus.score || 0), qualityMode: 'A_PLUS' } : {})
  };
}

function waitSignal(signal, reason) {
  return {
    ...signal, state: 'NO_TRADE', direction: null, diagnosis: 'WAIT', uiState: 'WAIT',
    provisional: false, phase: 'FINAL', reason, hint: reason
  };
}

function possibleSignal(signal, windows, direction, score, cycle = {}, aPlus = null) {
  const seconds = Math.max(0, Math.ceil(Number(signal.secondsRemaining || 0)));
  const side = direction === 'BUY' ? 'COMPRA' : 'VENDA';
  const rawDirection = directionOf(signal);
  const waiting = rawDirection === direction
    ? clean(signal.waitingFor?.text || signal.reason || 'aguardando confirmação final do padrão')
    : `mantendo o padrão ${side.toLowerCase()} já confirmado nesta vela enquanto a leitura instantânea oscila`;
  const quality = aPlus ? ` • A+ ${Math.round(Number(aPlus.score || 0))}/100` : '';
  const reason = `POSSÍVEL ${side} • ${seconds}s restantes${quality} — ${waiting}`;
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
    reason, hint: reason, decisionWindow: windows,
    ...(aPlus ? { aPlus, qualityScore: Number(aPlus.score || 0), qualityMode: 'A_PLUS' } : {})
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

function aPlusWaitingSignal(signal, windows, aPlus = {}, phase = 'BUILDING') {
  const reason = `A+ ${Math.round(Number(aPlus.score || 0))}/100 — aguardando: ${aPlusBlockText(aPlus)}.`;
  return {
    ...signal,
    state: 'WAIT',
    direction: null,
    diagnosis: 'WAIT',
    uiState: phase === 'FINAL' ? 'DECIDING' : 'BUILDING_PATTERN',
    provisional: true,
    phase,
    reason,
    hint: reason,
    decisionWindow: windows,
    aPlus,
    qualityScore: Number(aPlus.score || 0),
    qualityMode: 'A_PLUS'
  };
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
  const aTime = Number(a.targetStart || a.time || 0);
  const bTime = Number(b.targetStart || b.time || 0);
  if (bTime > aTime) return b;
  if (bTime < aTime) return a;
  // The A+ wrapper is the current decision authority. If the legacy engine
  // rolls a NO_TRADE for the same target candle while the wrapper already
  // confirmed ENTER, the confirmed decision must win the tie.
  if (b.state === 'CONFIRM' && a.state !== 'CONFIRM') return b;
  if (a.state === 'CONFIRM' && b.state !== 'CONFIRM') return a;
  return b;
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
  const stableDirection = observeStablePossible(cycle, signal, at);
  const recovered = resolveWrapperDecision(snapshot, result, key, state);
  const rolledLastConfirmed = newerDecision(newerDecision(result.lastConfirmed, latestWrapperCompleted(snapshot)), recovered);
  const stableAPlus = stableDirection
    ? aPlusAssessment(snapshot, result, signal, stableDirection, cycle, state, at)
    : aPlusAssessment(snapshot, result, signal, directionOf(signal), cycle, state, at);
  const stableAPlusCandidateAllowed = stableDirection
    ? observeStableAPlusCandidate(cycle, stableAPlus.candidateAllowed === true, at)
    : false;
  const stablePossibleSignal = stableDirection
    ? possibleSignal(signal, windows, stableDirection, score, cycle, stableAPlus)
    : null;

  if (cycle.locked === 'ENTER') {
    const lockedAPlus = cycle.aPlus || stableAPlus;
    return {
      ...result,
      lastConfirmed: rolledLastConfirmed || result.lastConfirmed,
      signal: enterSignal(signal, cycle, cycle.direction, Math.max(score, Number(cycle.score || 0)), cycle.reason, lockedAPlus),
      decisionCycle: { ...cycle }
    };
  }
  if (cycle.locked === 'WAIT') {
    return {
      ...result,
      lastConfirmed: rolledLastConfirmed || result.lastConfirmed,
      signal: withAPlus(waitSignal(signal, cycle.reason || 'AGUARDAR — padrão não confirmou a tempo.'), cycle.aPlus || stableAPlus),
      decisionCycle: { ...cycle }
    };
  }

  if (secondsRemaining > windows.decision) {
    const nextSignal = stableDirection && stableAPlusCandidateAllowed
      ? stablePossibleSignal
      : stableDirection
        ? aPlusWaitingSignal(signal, windows, stableAPlus, 'BUILDING')
        : withAPlus(buildingSignal(signal, windows), stableAPlus);
    cycle.aPlus = stableAPlus;
    cycles.set(key, cycle);
    return { ...result, lastConfirmed: rolledLastConfirmed || result.lastConfirmed, signal: nextSignal, decisionCycle: { ...cycle } };
  }

  const candidateAge = at - Number(cycle.possibleSince || at);

  if (signal.state === 'CONFIRM' && ['BUY', 'SELL'].includes(signal.direction)
      && (!stableDirection || signal.direction === stableDirection)) {
    const quality = decisionQuality(signal, signal.direction);
    const aPlus = aPlusAssessment(snapshot, result, signal, signal.direction, cycle, state, at);
    if (quality.qualifies && aPlus.finalAllowed && candidateAge >= FINAL_CANDIDATE_MIN_AGE_MS) {
      cycle.locked = 'ENTER';
      cycle.direction = signal.direction;
      cycle.score = Math.max(score, Number(signal.score || 0), Number(cycle.possibleScore || 0));
      cycle.setup = signal.setup || cycle.setup || inferSetup(signal, cycle.direction);
      cycle.aPlus = aPlus;
      cycle.reason = `ENTRAR NA PRÓXIMA VELA: ${signal.direction === 'BUY' ? 'COMPRA' : 'VENDA'} — A+ ${Math.round(aPlus.score)}/100, ${cycle.setup || 'setup'} confirmado.`;
      cycle.decidedAt = at;
      cycles.set(key, cycle);
      const trace = appendTrace(state, { key, targetStart: cycle.targetStart, decision: 'ENTER', direction: cycle.direction, score: cycle.score, qualityScore: aPlus.score, setup: cycle.setup, reason: cycle.reason, decidedAt: at });
      return { ...result, lastConfirmed: rolledLastConfirmed || result.lastConfirmed, signal: enterSignal(signal, cycle, cycle.direction, cycle.score, cycle.reason, aPlus), decisionCycle: { ...cycle }, decisionTrace: trace };
    }
  }

  if (stableDirection) {
    const quality = decisionQuality(signal, stableDirection);
    const aPlus = aPlusAssessment(snapshot, result, signal, stableDirection, cycle, state, at);
    const stableFinal = observeDecision(
      cycle,
      stableDirection,
      quality.qualifies
        && aPlus.finalAllowed
        && candidateAge >= FINAL_CANDIDATE_MIN_AGE_MS,
      at
    );
    if (quality.qualifies) cycle.setup = quality.setup || cycle.setup || inferSetup(signal, stableDirection);
    cycle.aPlus = aPlus;
    if (stableFinal) {
      cycle.locked = 'ENTER';
      cycle.direction = stableDirection;
      cycle.score = Math.max(score, Number(cycle.possibleScore || 0));
      cycle.reason = `ENTRAR NA PRÓXIMA VELA: ${stableDirection === 'BUY' ? 'COMPRA' : 'VENDA'} — A+ ${Math.round(aPlus.score)}/100, ${cycle.setup || 'setup'} confirmado.`;
      cycle.decidedAt = at;
      cycles.set(key, cycle);
      const trace = appendTrace(state, { key, targetStart: cycle.targetStart, decision: 'ENTER', direction: stableDirection, score: cycle.score, qualityScore: aPlus.score, setup: cycle.setup, reason: cycle.reason, decidedAt: at });
      return { ...result, lastConfirmed: rolledLastConfirmed || result.lastConfirmed, signal: enterSignal(signal, cycle, stableDirection, cycle.score, cycle.reason, aPlus), decisionCycle: { ...cycle }, decisionTrace: trace };
    }
  }

  if (secondsRemaining <= windows.skip) {
    const blocker = stableDirection && stableAPlus
      ? aPlusBlockText(stableAPlus)
      : clean(signal.waitingFor?.text || signal.reason || 'qualidade insuficiente para a próxima vela');
    cycle.locked = 'WAIT';
    cycle.direction = null;
    cycle.score = Math.max(score, Number(cycle.possibleScore || 0));
    cycle.aPlus = stableAPlus;
    cycle.reason = `AGUARDAR — filtro A+: ${blocker}.`;
    cycle.decidedAt = at;
    cycles.set(key, cycle);
    const trace = appendTrace(state, { key, targetStart: cycle.targetStart, decision: 'WAIT', direction: null, score: cycle.score, qualityScore: Number(stableAPlus?.score || 0), setup: cycle.setup, reason: cycle.reason, decidedAt: at });
    return { ...result, lastConfirmed: rolledLastConfirmed || result.lastConfirmed, signal: withAPlus(waitSignal(signal, cycle.reason), stableAPlus), decisionCycle: { ...cycle }, decisionTrace: trace };
  }

  cycles.set(key, cycle);
  const nextSignal = stableDirection && stableAPlusCandidateAllowed
    ? stablePossibleSignal
    : stableDirection
      ? aPlusWaitingSignal(signal, windows, stableAPlus, 'FINAL')
      : withAPlus(decidingSignal(signal, windows), stableAPlus);
  return { ...result, lastConfirmed: rolledLastConfirmed || result.lastConfirmed, signal: nextSignal, decisionCycle: { ...cycle } };
}

export function resetOrchestrator() {
  cycles.clear();
  wrapperCompletedDecisions.clear();
  legacyResetOrchestrator();
}

export function serializeCompletedDecisions() {
  const legacyRows = legacySerializeCompletedDecisions();
  const wrapperRows = [...wrapperCompletedDecisions.entries()]
    .slice(-50)
    .map(([key, decision]) => ({ key: `${WRAPPER_ROW_PREFIX}${key}`, decision: { ...decision } }));

  // Wrapper/A+ is the current decision authority. If legacy serialized a row
  // for the same asset+timeframe+target candle, keep the wrapper version so a
  // confirmed entry (and its real target-candle price) cannot be discarded by
  // an older NO_TRADE/legacy completion with the same key.
  const wrapperKeys = new Set(
    wrapperRows
      .map(row => wrapperCompletionKey(row?.decision || {}))
      .filter(key => key && !key.endsWith('|0'))
  );
  const filteredLegacy = legacyRows.filter(
    row => !wrapperKeys.has(wrapperCompletionKey(row?.decision || {}))
  );
  return [...filteredLegacy, ...wrapperRows].slice(-50);
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