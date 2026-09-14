import {
  processSnapshot as legacyProcessSnapshot,
  resetOrchestrator as legacyResetOrchestrator,
  serializeCompletedDecisions as legacySerializeCompletedDecisions,
  restoreCompletedDecisions as legacyRestoreCompletedDecisions
} from './orchestrator-legacy.js';
import { ANALYST_THRESHOLDS } from './analysis.js';

// The 0.10.4 analyst remains the source of price-action, regime and indicator analysis.
// This wrapper only turns that live analysis into one bounded decision per target candle.
const POSSIBLE_HITS = 2;
const CONFIRM_HITS = 2;
const CANDIDATE_MAX_GAP_MS = 8000;

const PRE_SIGNAL_WINDOW_SECONDS = 30;
const DECISION_WINDOW_SECONDS = 15;
const SKIP_LOCK_SECONDS = 4;
const DECISION_HIT_GAP_MS = 2500;
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
  const seconds = tf.match(/^S(\d+)$/);
  if (seconds) return Math.max(1, Number(seconds[1])) * 1000;
  const minutes = tf.match(/^M(\d+)$/);
  if (minutes) return Math.max(1, Number(minutes[1])) * 60_000;
  const hours = tf.match(/^H(\d+)$/);
  if (hours) return Math.max(1, Number(hours[1])) * 3_600_000;
  return 60_000;
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

function decisionQuality(signal = {}, direction = null) {
  if (!direction) return false;
  const score = Number(signal.analysisScore ?? signal.score ?? 0);
  if (score < ANALYST_THRESHOLDS.confirmScore) return false;

  const analytics = signal.analytics || {};
  const power = Number(direction === 'BUY' ? analytics.buyPower : analytics.sellPower) || 0;
  const currentStrength = Number(analytics.currentStrength || 0);
  const rejectionStrength = Number(analytics.rejectionStrength || 0);
  const directionalRejection = analytics.rejectionDirection === direction
    || Number(direction === 'BUY' ? analytics.rejectionBuy : analytics.rejectionSell) >= ANALYST_THRESHOLDS.rejectionStrength;
  const continuation = analytics.continuationDirection === direction
    && Number(analytics.continuationScore || 0) >= 55;
  const momentum = analytics.momentumDirection === direction
    && Number(analytics.momentumScore || 0) >= 40;
  const strongCandle = currentStrength >= ANALYST_THRESHOLDS.candleStrength;
  const rejection = directionalRejection && rejectionStrength >= ANALYST_THRESHOLDS.rejectionStrength;
  const scoreMomentum = score >= 62 && momentum;
  const regime = String(signal.regime?.type || '').toLowerCase();

  if (regime === 'range') {
    return power >= 55 && score >= 68 && (rejection || continuation || (strongCandle && momentum));
  }
  return power >= 50 && (strongCandle || rejection || continuation || scoreMomentum);
}

function seedCycle(key, snapshot, signal, state = {}) {
  const stored = state?.decisionCycle;
  let cycle = cycles.get(key);
  if (!cycle && stored?.key === key) cycle = { ...stored };
  if (!cycle) {
    cycle = {
      key,
      targetStart: targetStartOf(snapshot, signal),
      candidateDirection: null,
      confirmHits: 0,
      lastHitAt: null,
      locked: null,
      direction: null,
      score: 0,
      reason: null,
      decidedAt: null,
      resolved: false
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
  const withoutSame = rows.filter(item => item?.key !== row.key);
  return [...withoutSame, row].slice(-24);
}

function enterSignal(signal, cycle, direction, score, reason = null) {
  return {
    ...signal,
    state: 'CONFIRM',
    direction,
    diagnosis: direction,
    uiState: direction === 'BUY' ? 'ENTER_BUY' : 'ENTER_SELL',
    provisional: false,
    phase: 'FINAL',
    score,
    analysisScore: score,
    reason: reason || `ENTRAR NA PRÓXIMA VELA: ${direction === 'BUY' ? 'COMPRA' : 'VENDA'} — padrão confirmado para a próxima abertura.`,
    hint: reason || `ENTRAR NA PRÓXIMA VELA: ${direction === 'BUY' ? 'COMPRA' : 'VENDA'}.`,
    targetStart: cycle.targetStart
  };
}

function skipSignal(signal, reason) {
  return {
    ...signal,
    state: 'NO_TRADE',
    direction: null,
    diagnosis: 'WAIT',
    uiState: 'WAIT',
    provisional: false,
    phase: 'FINAL',
    reason,
    hint: reason
  };
}

function decidingSignal(signal) {
  const seconds = Math.max(0, Math.ceil(Number(signal.secondsRemaining || 0)));
  const waiting = clean(signal.waitingFor?.text || signal.reason || 'checando força, rejeição, continuidade e momentum');
  const reason = `DECIDINDO A PRÓXIMA VELA • ${seconds}s restantes — ${waiting}`;
  return {
    ...signal,
    state: 'WAIT',
    direction: null,
    diagnosis: 'WAIT',
    uiState: 'WAIT',
    provisional: true,
    phase: 'FINAL',
    reason,
    hint: reason
  };
}

function buildingSignal(signal) {
  const direction = directionOf(signal);
  const reason = direction
    ? `Montando a leitura da próxima vela • viés ${direction === 'BUY' ? 'comprador' : 'vendedor'} em formação.`
    : (signal.waitingFor?.text || 'Montando a leitura da próxima vela com as velas recentes e a vela atual.');
  return {
    ...signal,
    state: 'WAIT',
    direction: null,
    diagnosis: 'WAIT',
    uiState: 'BUILDING_PATTERN',
    provisional: true,
    phase: 'BUILDING',
    reason,
    hint: reason
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
    state: 'CONFIRM',
    direction: cycle.direction,
    score: Number(cycle.score || 0),
    time: targetBucket,
    targetStart: targetBucket,
    entryPrice: entryConfirmed ? entryPrice : null,
    entryTime: entryConfirmed ? targetBucket : null,
    entryConfirmed,
    entryStatus: entryConfirmed ? 'confirmed' : 'unconfirmed',
    entryReason: entryConfirmed ? null : 'Preço de entrada não confirmado: a vela-alvo não foi observada.',
    capturedAt: entryConfirmed ? now : null,
    asset,
    timeframe
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
    const oldest = [...wrapperCompletedDecisions.entries()]
      .sort((a, b) => Number(a[1]?.targetStart || 0) - Number(b[1]?.targetStart || 0))[0]?.[0];
    if (oldest) wrapperCompletedDecisions.delete(oldest);
  }
}

function latestWrapperCompleted(snapshot = {}) {
  const asset = clean(snapshot.asset || '');
  const timeframe = clean(snapshot.analysisTimeframe || snapshot.timeframe || 'M1').toUpperCase();
  return [...wrapperCompletedDecisions.values()]
    .filter(row => sameAsset(row?.asset, asset) && clean(row?.timeframe).toUpperCase() === timeframe)
    .sort((a, b) => Number(b?.targetStart || 0) - Number(a?.targetStart || 0))[0] || null;
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
  if (persisted?.locked === 'ENTER' && !persisted.resolved && !candidates.some(row => row?.key === persisted.key)) {
    candidates.push({ ...persisted });
  }

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
  const key = cycleKey(snapshot, signal);
  const cycle = seedCycle(key, snapshot, signal, state);
  const at = num(snapshot.serverTime) ?? Date.now();
  const score = Number(signal.analysisScore ?? signal.score ?? 0);
  const direction = directionOf(signal);
  const recovered = resolveWrapperDecision(snapshot, result, key, state);
  const rolledLastConfirmed = newerDecision(newerDecision(result.lastConfirmed, latestWrapperCompleted(snapshot)), recovered);

  if (cycle.locked === 'ENTER') {
    return {
      ...result,
      lastConfirmed: rolledLastConfirmed || result.lastConfirmed,
      signal: enterSignal(signal, cycle, cycle.direction, Math.max(score, Number(cycle.score || 0)), cycle.reason),
      decisionCycle: { ...cycle }
    };
  }
  if (cycle.locked === 'SKIP') {
    return {
      ...result,
      lastConfirmed: rolledLastConfirmed || result.lastConfirmed,
      signal: skipSignal(signal, cycle.reason || 'PULAR PRÓXIMA VELA — padrão não confirmou a tempo.'),
      decisionCycle: { ...cycle }
    };
  }

  if (secondsRemaining > PRE_SIGNAL_WINDOW_SECONDS) {
    const nextSignal = signal.state === 'WATCH' ? buildingSignal(signal) : signal;
    return {
      ...result,
      lastConfirmed: rolledLastConfirmed || result.lastConfirmed,
      signal: nextSignal,
      decisionCycle: { ...cycle }
    };
  }

  if (secondsRemaining > DECISION_WINDOW_SECONDS) {
    return {
      ...result,
      lastConfirmed: rolledLastConfirmed || result.lastConfirmed,
      decisionCycle: { ...cycle }
    };
  }

  if (signal.state === 'CONFIRM' && ['BUY', 'SELL'].includes(signal.direction)) {
    cycle.locked = 'ENTER';
    cycle.direction = signal.direction;
    cycle.score = Math.max(score, Number(signal.score || 0));
    cycle.reason = signal.reason;
    cycle.decidedAt = at;
    cycles.set(key, cycle);
    const trace = appendTrace(state, {
      key, targetStart: cycle.targetStart, decision: 'ENTER', direction: cycle.direction,
      score: cycle.score, reason: cycle.reason, decidedAt: at
    });
    return { ...result, lastConfirmed: rolledLastConfirmed || result.lastConfirmed, decisionCycle: { ...cycle }, decisionTrace: trace };
  }

  const qualifies = decisionQuality(signal, direction);
  const stable = observeDecision(cycle, direction, qualifies, at);
  if (stable) {
    cycle.locked = 'ENTER';
    cycle.direction = direction;
    cycle.score = score;
    cycle.reason = `ENTRAR NA PRÓXIMA VELA: ${direction === 'BUY' ? 'COMPRA' : 'VENDA'} — score ${Math.round(score)}/100 com confirmação direcional estável.`;
    cycle.decidedAt = at;
    cycles.set(key, cycle);
    const trace = appendTrace(state, {
      key, targetStart: cycle.targetStart, decision: 'ENTER', direction,
      score, reason: cycle.reason, decidedAt: at
    });
    return {
      ...result,
      lastConfirmed: rolledLastConfirmed || result.lastConfirmed,
      signal: enterSignal(signal, cycle, direction, score, cycle.reason),
      decisionCycle: { ...cycle },
      decisionTrace: trace
    };
  }

  if (secondsRemaining <= SKIP_LOCK_SECONDS) {
    const blocker = clean(signal.waitingFor?.text || signal.reason || 'qualidade insuficiente para a próxima vela');
    cycle.locked = 'SKIP';
    cycle.direction = null;
    cycle.score = score;
    cycle.reason = `PULAR PRÓXIMA VELA — ${blocker}`;
    cycle.decidedAt = at;
    cycles.set(key, cycle);
    const trace = appendTrace(state, {
      key, targetStart: cycle.targetStart, decision: 'SKIP', direction: null,
      score, reason: cycle.reason, decidedAt: at
    });
    return {
      ...result,
      lastConfirmed: rolledLastConfirmed || result.lastConfirmed,
      signal: skipSignal(signal, cycle.reason),
      decisionCycle: { ...cycle },
      decisionTrace: trace
    };
  }

  cycles.set(key, cycle);
  return {
    ...result,
    lastConfirmed: rolledLastConfirmed || result.lastConfirmed,
    signal: decidingSignal(signal),
    decisionCycle: { ...cycle }
  };
}

export function resetOrchestrator() {
  cycles.clear();
  wrapperCompletedDecisions.clear();
  legacyResetOrchestrator();
}

export function serializeCompletedDecisions() {
  const legacyRows = legacySerializeCompletedDecisions();
  const legacyKeys = new Set(
    legacyRows
      .map(row => wrapperCompletionKey(row?.decision || {}))
      .filter(key => key && !key.endsWith('|0'))
  );
  const wrapperRows = [...wrapperCompletedDecisions.entries()]
    .filter(([key]) => !legacyKeys.has(key))
    .slice(-50)
    .map(([key, decision]) => ({
      key: `${WRAPPER_ROW_PREFIX}${key}`,
      decision: { ...decision }
    }));
  return [...legacyRows, ...wrapperRows].slice(-50);
}

export function restoreCompletedDecisions(rows = []) {
  wrapperCompletedDecisions.clear();
  const legacyRows = [];
  for (const row of Array.isArray(rows) ? rows.slice(-50) : []) {
    const key = clean(row?.key);
    const decision = row?.decision;
    if (!key || !decision || typeof decision !== 'object') continue;
    if (key.startsWith(WRAPPER_ROW_PREFIX)) {
      wrapperCompletedDecisions.set(key.slice(WRAPPER_ROW_PREFIX.length), { ...decision });
    } else {
      legacyRows.push(row);
    }
  }
  return legacyRestoreCompletedDecisions(legacyRows);
}
