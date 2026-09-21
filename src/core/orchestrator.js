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
const POSSIBLE_DROP_HITS = 2;
const cycles = new Map();
const wrapperCompletedDecisions = new Map();
const WRAPPER_ROW_PREFIX = 'wrapper-cycle:';

const HIGH_CONFIDENCE = Object.freeze({
  possibleScore: 60,
  finalScore: 70,
  possiblePower: 58,
  finalPower: 60,
  minimumEvidence: 2
});

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
  // Operation contract: keep the ~30s preparation window, but make the final
  // confirmation much closer to candle close so the decision reflects the
  // latest CasaTrade price action. Leave a small late cutoff so the 2-hit
  // confirmation still has time to complete without publishing at the turn.
  if (timeframe === 'M1') {
    return { pre: 30, decision: 5, skip: 1, duration, timeframe };
  }
  if (timeframe === 'M5') {
    return { pre: 30, decision: 8, skip: 2, duration, timeframe };
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

function confirmationModeOf(state = {}) {
  return clean(state.analystPreferences?.confirmationMode).toUpperCase() === 'EXIGENTE' ? 'EXIGENTE' : 'SIMPLES';
}

function highConfidenceEvidence(signal = {}, direction = null, thresholds = getThresholds()) {
  const analytics = signal.analytics || {};
  const currentStrength = Number(analytics.currentStrength || 0);
  const rejectionStrength = Number(analytics.rejectionStrength || 0);
  const continuationScore = Number(analytics.continuationScore || 0);
  const momentumScore = Number(analytics.momentumScore || 0);
  const directionalRejection = analytics.rejectionDirection === direction
    || Number(direction === 'BUY' ? analytics.rejectionBuy : analytics.rejectionSell) >= Math.max(50, thresholds.rejectionStrength);
  const evidence = [];
  if (directionalRejection && rejectionStrength >= Math.max(50, thresholds.rejectionStrength)) evidence.push('rejeição');
  if (analytics.continuationDirection === direction && continuationScore >= 60) evidence.push('continuação');
  if (analytics.momentumDirection === direction && momentumScore >= 45) evidence.push('momentum');
  if (currentStrength >= Math.max(60, thresholds.candleStrength)) evidence.push('força');
  return evidence;
}

function decisionQuality(signal = {}, direction = null, thresholds = getThresholds(), confirmationMode = 'SIMPLES') {
  const mode = clean(confirmationMode).toUpperCase() === 'EXIGENTE' ? 'EXIGENTE' : 'SIMPLES';
  const score = Number(signal.analysisScore ?? signal.score ?? 0);
  const analytics = signal.analytics || {};
  const power = Number(direction === 'BUY' ? analytics.buyPower : analytics.sellPower) || 0;
  const currentStrength = Number(analytics.currentStrength || 0);
  const rejectionStrength = Number(analytics.rejectionStrength || 0);
  const continuationScore = Number(analytics.continuationScore || 0);
  const momentumScore = Number(analytics.momentumScore || 0);
  const directionalRejection = analytics.rejectionDirection === direction
    || Number(direction === 'BUY' ? analytics.rejectionBuy : analytics.rejectionSell) >= thresholds.rejectionStrength;
  const continuation = analytics.continuationDirection === direction && continuationScore >= 55;
  const momentum = analytics.momentumDirection === direction && momentumScore >= 40;
  const strongCandle = currentStrength >= thresholds.candleStrength;
  const rejection = directionalRejection && rejectionStrength >= thresholds.rejectionStrength;
  const regime = String(signal.regime?.type || '').toLowerCase();
  const evidence = highConfidenceEvidence(signal, direction, thresholds);
  const finalScore = Math.max(HIGH_CONFIDENCE.finalScore, thresholds.confirmScore);
  const commonReady = !!direction
    && score >= finalScore
    && power >= HIGH_CONFIDENCE.finalPower
    && evidence.length >= HIGH_CONFIDENCE.minimumEvidence;
  const commonReason = !direction
    ? 'sem direção'
    : score < finalScore
      ? `score ${Math.round(score)} < ${finalScore}`
      : power < HIGH_CONFIDENCE.finalPower
        ? `poder ${Math.round(power)} < ${HIGH_CONFIDENCE.finalPower}`
        : evidence.length < HIGH_CONFIDENCE.minimumEvidence
          ? `confluências fortes ${evidence.length}/${HIGH_CONFIDENCE.minimumEvidence}`
          : 'alta confiança confirmada';

  if (mode === 'SIMPLES') {
    const setups = [
      {
        name: 'rejeição',
        ok: rejection,
        reason: `rejeição direcional=${rejection} | strength ${Math.round(rejectionStrength)} ${rejectionStrength >= thresholds.rejectionStrength ? '>=' : '<'} ${thresholds.rejectionStrength}`
      },
      {
        name: 'continuação',
        ok: continuation,
        reason: `continuação direcional=${analytics.continuationDirection === direction} | score ${Math.round(continuationScore)} ${continuationScore >= 55 ? '>=' : '<'} 55`
      },
      {
        name: 'momentum',
        ok: momentum,
        reason: `momentum direcional=${analytics.momentumDirection === direction} | score ${Math.round(momentumScore)} ${momentumScore >= 40 ? '>=' : '<'} 40`
      },
      {
        name: 'força da vela',
        ok: strongCandle,
        reason: `currentStrength ${Math.round(currentStrength)} ${strongCandle ? '>=' : '<'} ${thresholds.candleStrength}`
      }
    ];
    const matched = setups.find(item => item.ok) || null;
    return {
      // SIMPLES no longer bypasses setup quality: every final signal must have
      // high score, directional power and at least two independent confirmations.
      qualifies: commonReady,
      setup: matched ? matched.name : evidence.join(' + ') || 'alta confiança',
      checks: setups,
      mode,
      commonReady,
      commonReason
    };
  }

  // EXIGENTE preserves the v0.11.43 decision gates exactly.
  const setups = regime === 'range'
    ? [
        {
          name: 'rejeição no range',
          ok: power >= 52 && rejection,
          reason: `power>=52=${power >= 52} | rejeição direcional>=${thresholds.rejectionStrength}=${rejection}`
        },
        {
          name: 'continuação confirmada no range',
          ok: power >= 55 && score >= 64 && continuation && momentum,
          reason: `power>=55=${power >= 55} | score>=64=${score >= 64} | continuação>=55=${continuation} | momentum>=40=${momentum}`
        }
      ]
    : [
        {
          name: 'rejeição',
          ok: power >= 48 && rejection,
          reason: `power>=48=${power >= 48} | rejeição direcional>=${thresholds.rejectionStrength}=${rejection}`
        },
        {
          name: 'continuação',
          ok: power >= 50 && continuation,
          reason: `power>=50=${power >= 50} | continuação direcional>=55=${continuation}`
        },
        {
          name: 'momentum',
          ok: power >= 50 && strongCandle && momentum,
          reason: `power>=50=${power >= 50} | currentStrength>=${thresholds.candleStrength}=${strongCandle} | momentum direcional>=40=${momentum}`
        },
        {
          name: 'confluência forte',
          ok: power >= 48 && score >= 68 && momentum && (strongCandle || continuation),
          reason: `power>=48=${power >= 48} | score>=68=${score >= 68} | momentum=${momentum} | força/continuação=${strongCandle || continuation}`
        }
      ];
  const matched = commonReady ? setups.find(item => item.ok) || null : null;
  return {
    qualifies: !!matched,
    setup: matched?.name || null,
    checks: setups,
    mode,
    commonReady,
    commonReason
  };
}

function possibleQuality(signal = {}, direction = null, score = 0, thresholds = getThresholds()) {
  const possibleScore = Math.max(HIGH_CONFIDENCE.possibleScore, thresholds.possibleScore);
  if (!direction || Number(score) < possibleScore) return false;
  const analytics = signal.analytics || {};
  const power = Number(direction === 'BUY' ? analytics.buyPower : analytics.sellPower) || 0;
  if (power < HIGH_CONFIDENCE.possiblePower) return false;
  if (highConfidenceEvidence(signal, direction, thresholds).length < HIGH_CONFIDENCE.minimumEvidence) return false;
  const stableDirection = clean(signal.stability?.possibleDirection).toUpperCase();
  const publishedDirection = clean(signal.direction).toUpperCase();
  return stableDirection === direction || (signal.state === 'WATCH' && publishedDirection === direction);
}

function possibleWithHysteresis(cycle, allowed, direction, at) {
  if (allowed && direction) {
    cycle.possibleDirection = direction;
    cycle.possibleWeakHits = 0;
    cycle.possibleLastStrongAt = at;
    return direction;
  }
  // One weak/throttled observation must not make POSSÍVEL disappear. Preserve
  // the last confirmed candidate direction for one weak sample, then drop it
  // only after a second consecutive weak observation.
  if (!cycle.possibleDirection) return null;
  cycle.possibleWeakHits = Number(cycle.possibleWeakHits || 0) + 1;
  if (cycle.possibleWeakHits < POSSIBLE_DROP_HITS) return cycle.possibleDirection;
  cycle.possibleDirection = null;
  cycle.possibleWeakHits = 0;
  return null;
}

function seedCycle(key, snapshot, signal, state = {}) {
  const stored = state?.decisionCycle;
  let cycle = cycles.get(key);
  if (!cycle && stored?.key === key) cycle = { ...stored };
  if (!cycle) {
    cycle = {
      key, targetStart: targetStartOf(snapshot, signal), candidateDirection: null,
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

function upsertCandidateBlockerTrace(state = {}, row = {}) {
  const rows = Array.isArray(state.candidateBlockerTrace) ? state.candidateBlockerTrace.slice(-20) : [];
  if (!row?.key || !['BUY', 'SELL'].includes(row?.candidateDirection)) return rows;
  const previous = rows.find(item => item?.key === row.key) || {};
  const merged = {
    ...previous,
    ...row,
    lastWaitSeconds: row.lastWaitSeconds ?? previous.lastWaitSeconds ?? null,
    finalBlockMessage: row.finalBlockMessage ?? previous.finalBlockMessage ?? null
  };
  return [...rows.filter(item => item?.key !== row.key), merged].slice(-20);
}

function markCandidateWait(rows = [], key = '', secondsRemaining = null, message = '') {
  return (Array.isArray(rows) ? rows : []).map(row => row?.key === key
    ? {
        ...row,
        lastWaitSeconds: num(secondsRemaining),
        finalBlockMessage: clean(message || row.finalBlockMessage || '')
      }
    : row);
}

function enterSignal(signal, cycle, direction, score, reason = null) {
  return {
    ...signal, state: 'CONFIRM', direction, diagnosis: direction,
    uiState: direction === 'BUY' ? 'ENTER_BUY' : 'ENTER_SELL', provisional: false, phase: 'FINAL',
    score, analysisScore: score, setup: cycle.setup || signal.setup || null,
    reason: reason || `${direction === 'BUY' ? 'COMPRA' : 'VENDA'} — ALTA CONFIANÇA • ENTRAR NA PRÓXIMA VELA.`,
    hint: reason || `${direction === 'BUY' ? 'COMPRA' : 'VENDA'} — ALTA CONFIANÇA • ENTRAR NA PRÓXIMA VELA.`,
    targetStart: cycle.targetStart
  };
}

function waitSignal(signal, reason) {
  return {
    ...signal, state: 'NO_TRADE', direction: null, diagnosis: 'WAIT', uiState: 'WAIT',
    provisional: false, phase: 'FINAL', reason, hint: reason
  };
}

function possibleSignal(signal, windows, direction, score) {
  const seconds = Math.max(0, Math.ceil(Number(signal.secondsRemaining || 0)));
  const side = direction === 'BUY' ? 'COMPRA' : 'VENDA';
  const reason = `${side} — ALTA CONFIANÇA • PRÉ-SINAL • ${seconds}s — aguardando a janela final.`;
  return {
    ...signal,
    state: 'WATCH', direction, diagnosis: direction,
    uiState: direction === 'BUY' ? 'POSSIBLE_BUY' : 'POSSIBLE_SELL',
    provisional: true, phase: 'POSSIBLE', score, analysisScore: score,
    reason, hint: reason, decisionWindow: windows
  };
}

function decidingSignal(signal, windows) {
  const seconds = Math.max(0, Math.ceil(Number(signal.secondsRemaining || 0)));
  const reason = `AGUARDAR • ${seconds}s — confiança ainda abaixo do nível exigido para entrada.`;
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
  const confirmationMode = confirmationModeOf(state);
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
  const analytics = signal.analytics || {};
  const power = Number(direction === 'BUY' ? analytics.buyPower : analytics.sellPower) || 0;
  const rawPossible = possibleQuality(signal, direction, score, thresholds);
  const quality = decisionQuality(signal, direction, thresholds, confirmationMode);
  const technicalFinal = signal.state === 'CONFIRM' || ['ENTER_BUY', 'ENTER_SELL'].includes(clean(signal.uiState).toUpperCase());
  let candidateBlockerTrace = upsertCandidateBlockerTrace(state, {
    key,
    targetStart: cycle.targetStart,
    candidateDirection: direction,
    confirmationMode,
    score,
    power,
    currentStrength: Number(analytics.currentStrength || 0),
    rejectionStrength: Number(analytics.rejectionStrength || 0),
    continuationScore: Number(analytics.continuationScore || 0),
    momentumScore: Number(analytics.momentumScore || 0),
    possibleQuality: rawPossible,
    decisionQuality: {
      qualifies: quality.qualifies,
      setup: quality.setup,
      commonReady: quality.commonReady,
      commonReason: quality.commonReason,
      setups: quality.checks || []
    },
    technicalFinal,
    mandatoryPowerReady: power >= 50,
    secondsRemaining,
    updatedAt: at
  });
  const possibleDirection = possibleWithHysteresis(cycle, rawPossible, direction, at);
  const canShowPossible = !!possibleDirection;
  const recovered = resolveWrapperDecision(snapshot, result, key, state);
  const rolledLastConfirmed = newerDecision(newerDecision(result.lastConfirmed, latestWrapperCompleted(snapshot)), recovered);

  if (cycle.locked === 'ENTER') {
    return {
      ...result,
      lastConfirmed: rolledLastConfirmed || result.lastConfirmed,
      signal: enterSignal(signal, cycle, cycle.direction, Math.max(score, Number(cycle.score || 0)), cycle.reason),
      decisionCycle: { ...cycle },
      candidateBlockerTrace
    };
  }
  if (cycle.locked === 'WAIT') {
    const reason = cycle.reason || 'AGUARDAR — padrão não confirmou a tempo.';
    candidateBlockerTrace = markCandidateWait(candidateBlockerTrace, key, secondsRemaining, reason);
    return {
      ...result,
      lastConfirmed: rolledLastConfirmed || result.lastConfirmed,
      signal: waitSignal(signal, reason),
      decisionCycle: { ...cycle },
      candidateBlockerTrace
    };
  }

  if (secondsRemaining > windows.pre) {
    const nextSignal = signal.state === 'WATCH' || signal.provisional ? buildingSignal(signal, windows) : signal;
    if (clean(nextSignal?.uiState).toUpperCase() === 'WAIT' || nextSignal?.state === 'NO_TRADE') {
      candidateBlockerTrace = markCandidateWait(candidateBlockerTrace, key, secondsRemaining, nextSignal.reason);
    }
    return { ...result, lastConfirmed: rolledLastConfirmed || result.lastConfirmed, signal: nextSignal, decisionCycle: { ...cycle }, candidateBlockerTrace };
  }
  if (secondsRemaining > windows.decision) {
    const nextSignal = canShowPossible ? possibleSignal(signal, windows, possibleDirection, score) : signal;
    if (clean(nextSignal?.uiState).toUpperCase() === 'WAIT' || nextSignal?.state === 'NO_TRADE') {
      candidateBlockerTrace = markCandidateWait(candidateBlockerTrace, key, secondsRemaining, nextSignal.reason);
    }
    return { ...result, lastConfirmed: rolledLastConfirmed || result.lastConfirmed, signal: nextSignal, decisionCycle: { ...cycle }, candidateBlockerTrace };
  }

  if (signal.state === 'CONFIRM' && ['BUY', 'SELL'].includes(signal.direction) && quality.qualifies) {
    cycle.locked = 'ENTER';
    cycle.direction = signal.direction;
    cycle.score = Math.max(score, Number(signal.score || 0));
    cycle.setup = signal.setup || quality.setup || null;
    cycle.reason = signal.reason;
    cycle.decidedAt = at;
    cycles.set(key, cycle);
    const trace = appendTrace(state, { key, targetStart: cycle.targetStart, decision: 'ENTER', direction: cycle.direction, score: cycle.score, setup: cycle.setup, reason: cycle.reason, decidedAt: at });
    return { ...result, lastConfirmed: rolledLastConfirmed || result.lastConfirmed, decisionCycle: { ...cycle }, decisionTrace: trace, candidateBlockerTrace };
  }

  const stable = observeDecision(cycle, direction, quality.qualifies, at);
  if (quality.qualifies) cycle.setup = quality.setup;
  if (stable) {
    cycle.locked = 'ENTER';
    cycle.direction = direction;
    cycle.score = score;
    cycle.reason = `${direction === 'BUY' ? 'COMPRA' : 'VENDA'} — ALTA CONFIANÇA • ENTRAR NA PRÓXIMA VELA • score ${Math.round(score)}/100 • ${cycle.setup || 'confluência forte'}.`;
    cycle.decidedAt = at;
    cycles.set(key, cycle);
    const trace = appendTrace(state, { key, targetStart: cycle.targetStart, decision: 'ENTER', direction, score, setup: cycle.setup, reason: cycle.reason, decidedAt: at });
    return {
      ...result,
      lastConfirmed: rolledLastConfirmed || result.lastConfirmed,
      signal: enterSignal(signal, cycle, direction, score, cycle.reason),
      decisionCycle: { ...cycle },
      decisionTrace: trace,
      candidateBlockerTrace
    };
  }

  if (secondsRemaining <= windows.skip) {
    const blocker = clean(signal.waitingFor?.text || signal.reason || quality.commonReason || 'qualidade insuficiente para a próxima vela');
    cycle.locked = 'WAIT';
    cycle.direction = null;
    cycle.score = score;
    cycle.reason = `AGUARDAR — ${blocker}`;
    cycle.decidedAt = at;
    cycles.set(key, cycle);
    candidateBlockerTrace = markCandidateWait(candidateBlockerTrace, key, secondsRemaining, cycle.reason);
    const trace = appendTrace(state, { key, targetStart: cycle.targetStart, decision: 'WAIT', direction: null, score, setup: cycle.setup, reason: cycle.reason, decidedAt: at });
    return {
      ...result,
      lastConfirmed: rolledLastConfirmed || result.lastConfirmed,
      signal: waitSignal(signal, cycle.reason),
      decisionCycle: { ...cycle },
      decisionTrace: trace,
      candidateBlockerTrace
    };
  }

  cycles.set(key, cycle);
  const nextSignal = canShowPossible
    ? possibleSignal(signal, windows, possibleDirection, score)
    : decidingSignal(signal, windows);
  return { ...result, lastConfirmed: rolledLastConfirmed || result.lastConfirmed, signal: nextSignal, decisionCycle: { ...cycle }, candidateBlockerTrace };
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