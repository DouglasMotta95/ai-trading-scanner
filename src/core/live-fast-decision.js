import { getThresholds, getOperationMode } from './analysis.js';
const clean = value => String(value ?? '').trim();
const num = value => value == null || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null;

export const FAST_DECISION = Object.freeze({
  confirmHits: 2,
  maxHitGapMs: 5000
});

const trackers = new Map();
const directionTrackers = new Map();
const DIRECTION_FLIP_HITS = 2;
const DIRECTION_FLIP_MIN_MS = 600;
const DIRECTION_FLIP_WINDOW_MS = 2600;

function directionOf(signal = {}) {
  const analysis = clean(signal.analysisDirection).toUpperCase();
  if (analysis === 'BUY' || analysis === 'SELL') return analysis;
  const published = clean(signal.direction).toUpperCase();
  if (published === 'BUY' || published === 'SELL') return published;
  const a = signal.analytics || {};
  const buy = Number(a.buyPower || 0), sell = Number(a.sellPower || 0);
  if (buy === sell) return null;
  return buy > sell ? 'BUY' : 'SELL';
}

function quality(signal = {}, direction = null, thresholds = getThresholds(), confirmationMode = 'SIMPLES') {
  if (!direction) return { strong: false, power: 0, reasons: [], setup: null };
  const a = signal.analytics || {};
  const buy = direction === 'BUY';
  const power = Number(buy ? a.buyPower : a.sellPower) || 0;
  const mode = clean(confirmationMode).toUpperCase() === 'EXIGENTE' ? 'EXIGENTE' : 'SIMPLES';

  if (mode === 'SIMPLES') {
    const continuationScore = Number(a.continuationScore || 0);
    const momentumScore = Number(a.momentumScore || 0);
    const rejectionStrength = Number(a.rejectionStrength || 0);
    const currentStrength = Number(a.currentStrength || 0);
    const directionalRejection = a.rejectionDirection === direction
      || Number(direction === 'BUY' ? a.rejectionBuy : a.rejectionSell) >= thresholds.rejectionStrength;
    const continuation = a.continuationDirection === direction && continuationScore >= 55;
    const momentum = a.momentumDirection === direction && momentumScore >= 40;
    const reasons = [];
    if (directionalRejection && rejectionStrength >= thresholds.rejectionStrength) reasons.push('rejeição');
    if (continuation) reasons.push('continuação');
    if (momentum) reasons.push('momentum');
    if (currentStrength >= thresholds.candleStrength) reasons.push('força');
    return {
      // In SIMPLES the final score check happens outside this helper. Power is
      // the only mandatory quality gate here; reasons are explanatory only.
      strong: power >= 50,
      power,
      reasons,
      setup: reasons.length ? 'confirmação simples' : 'direção + score + poder'
    };
  }

  // EXIGENTE preserves the v0.11.43 fast-path quality rule exactly.
  const continuation = a.continuationDirection === direction && Number(a.continuationScore || 0) >= 55;
  const momentum = a.momentumDirection === direction && Number(a.momentumScore || 0) >= 40;
  const rejection = a.rejectionDirection === direction && Number(a.rejectionStrength || 0) >= thresholds.rejectionStrength;
  const strength = Number(a.currentStrength || 0) >= thresholds.candleStrength;
  const reasons = [];
  if (continuation) reasons.push('continuação');
  if (momentum) reasons.push('momentum');
  if (rejection) reasons.push('rejeição');
  if (strength) reasons.push('força');
  return { strong: power >= 50 && reasons.length > 0, power, reasons, setup: reasons[0] || null };
}

function cycleKey(context = {}, signal = {}) {
  const asset = clean(context.asset || signal.asset || 'unknown').toUpperCase();
  const timeframe = clean(context.timeframe || signal.timeframe || 'M1').toUpperCase();
  const seconds = Math.max(0, Number(context.secondsRemaining ?? signal.secondsRemaining ?? 0));
  const now = Number(context.serverTime || Date.now());
  const target = num(context.targetStart) ?? num(signal.targetStart) ?? now + seconds * 1000;
  return `${asset}|${timeframe}|${Math.round(target / 5000) * 5000}`;
}

function stabilizeDirection(key, rawDirection, at, score) {
  if (!rawDirection) return { direction: null, transitioning: false };
  const old = directionTrackers.get(key);
  if (!old) {
    directionTrackers.set(key, { stable: rawDirection, stableScore: score, pending: null, pendingHits: 0, pendingSince: 0, at });
    return { direction: rawDirection, transitioning: false };
  }
  if (old.stable === rawDirection) {
    directionTrackers.set(key, { ...old, stableScore: score, pending: null, pendingHits: 0, pendingSince: 0, at });
    return { direction: rawDirection, transitioning: false };
  }
  const samePending = old.pending === rawDirection && at - Number(old.at || 0) <= DIRECTION_FLIP_WINDOW_MS;
  const pendingHits = samePending ? Number(old.pendingHits || 0) + 1 : 1;
  const pendingSince = samePending ? Number(old.pendingSince || at) : at;
  const next = { ...old, pending: rawDirection, pendingHits, pendingSince, at };
  const sustained = pendingHits >= DIRECTION_FLIP_HITS && at - pendingSince >= DIRECTION_FLIP_MIN_MS;
  const materiallyStronger = pendingHits >= DIRECTION_FLIP_HITS && Number(score || 0) >= Number(old.stableScore || 0) + 18;
  if (sustained || materiallyStronger) {
    directionTrackers.set(key, { stable: rawDirection, stableScore: score, pending: null, pendingHits: 0, pendingSince: 0, at });
    return { direction: rawDirection, transitioning: false, changed: true, from: old.stable };
  }
  directionTrackers.set(key, next);
  return { direction: old.stable, transitioning: true, from: old.stable, to: rawDirection, hits: pendingHits };
}

function observe(key, direction, strong, at) {
  if (!strong || !direction) {
    trackers.delete(key);
    return 0;
  }
  const old = trackers.get(key);
  const same = old?.direction === direction && at - Number(old?.at || 0) <= FAST_DECISION.maxHitGapMs;
  const hits = same ? Number(old.hits || 0) + 1 : 1;
  trackers.set(key, { direction, hits, at });
  return hits;
}

function possible(signal, direction, score, seconds, q) {
  const side = direction === 'BUY' ? 'COMPRA' : 'VENDA';
  const reason = `POSSÍVEL ${side} • ${seconds}s — score ${Math.round(score)}/100${q.reasons.length ? ` • ${q.reasons.join(' + ')}` : ''}.`;
  return {
    ...signal,
    state: 'WATCH', direction, diagnosis: direction,
    uiState: direction === 'BUY' ? 'POSSIBLE_BUY' : 'POSSIBLE_SELL',
    provisional: true, phase: 'POSSIBLE', score, analysisScore: score,
    reason, hint: reason, fastDecision: true
  };
}

function enter(signal, direction, score, seconds, q) {
  const side = direction === 'BUY' ? 'COMPRA' : 'VENDA';
  const reason = `ENTRAR NA PRÓXIMA VELA: ${side} • ${seconds}s — score ${Math.round(score)}/100 • ${q.setup || q.reasons.join(' + ') || 'setup confirmado'}.`;
  return {
    ...signal,
    state: 'CONFIRM', direction, diagnosis: direction,
    uiState: direction === 'BUY' ? 'ENTER_BUY' : 'ENTER_SELL',
    provisional: false, phase: 'FINAL', score, analysisScore: score,
    reason, hint: reason, fastDecision: true
  };
}

function waitFinal(signal, score, reason = '') {
  const text = `AGUARDAR — ${reason || `setup não confirmou (score ${Math.round(score)}/100)`}.`;
  return {
    ...signal,
    state: 'NO_TRADE', direction: null, diagnosis: 'WAIT', uiState: 'WAIT',
    provisional: false, phase: 'FINAL', score, analysisScore: score,
    reason: text, hint: text, fastDecision: true
  };
}

export function fastLiveDecision(signal = {}, context = {}) {
  if (!signal || typeof signal !== 'object') return signal;
  const thresholds = getThresholds(context.sensitivityProfile || 'MEDIO');
  const confirmationMode = clean(context.confirmationMode || signal.confirmationMode).toUpperCase() === 'EXIGENTE' ? 'EXIGENTE' : 'SIMPLES';
  const operationMode = getOperationMode(context.operationMode || context.timeframe || 'M1');
  const preSignalWindowSeconds = operationMode.timeframe === 'M5' ? 90 : 30;
  const finalWindowSeconds = thresholds.entryWindowSeconds;
  if (signal.uiState === 'ENTER_BUY' || signal.uiState === 'ENTER_SELL' || signal.state === 'CONFIRM') return signal;

  const score = Number(signal.analysisScore ?? signal.score ?? 0);
  const seconds = Math.max(0, Math.ceil(Number(context.secondsRemaining ?? signal.secondsRemaining ?? 0)));
  const rawDirection = directionOf(signal);
  const key = cycleKey(context, signal);
  const at = Number(context.serverTime || Date.now());

  if (seconds <= 0) {
    trackers.delete(key);
    directionTrackers.delete(key);
    return waitFinal(signal, score, 'fechamento da vela em andamento');
  }

  if (seconds > preSignalWindowSeconds) {
    trackers.delete(key);
    directionTrackers.delete(key);
    const text = `ANALISANDO VELA ${operationMode.timeframe} • ${seconds}s — pré-sinal abre por volta de ${preSignalWindowSeconds}s.`;
    return { ...signal, state: 'WAIT', direction: null, diagnosis: 'WAIT', uiState: 'BUILDING_PATTERN', provisional: true, phase: 'BUILDING', reason: text, hint: text, fastDecision: true };
  }

  if (!rawDirection || score < thresholds.possibleScore) {
    trackers.delete(key);
    const text = `AGUARDAR • ${seconds}s — leitura ainda fraca (${Math.round(score)}/${thresholds.possibleScore}).`;
    return { ...signal, state: 'WAIT', direction: null, diagnosis: 'WAIT', uiState: 'WAIT', provisional: true, phase: seconds <= finalWindowSeconds ? 'FINAL' : 'LIVE', reason: text, hint: text, fastDecision: true };
  }

  const stabilized = stabilizeDirection(key, rawDirection, at, score);
  if (stabilized.transitioning) {
    const from = stabilized.from === 'BUY' ? 'COMPRA' : 'VENDA';
    const to = stabilized.to === 'BUY' ? 'COMPRA' : 'VENDA';
    const reason = `PADRÃO MUDANDO DE DIREÇÃO — REAVALIANDO ${from} → ${to} (${stabilized.hits}/${DIRECTION_FLIP_HITS}).`;
    return {
      ...signal,
      state: 'WATCH',
      direction: stabilized.direction,
      diagnosis: stabilized.direction,
      uiState: 'DECIDING',
      provisional: true,
      phase: 'REASSESSING',
      analysisScore: score,
      score,
      directionTransition: { from: stabilized.from, to: stabilized.to, hits: stabilized.hits, required: DIRECTION_FLIP_HITS, at },
      reason,
      hint: reason,
      fastDecision: true
    };
  }
  const direction = stabilized.direction;
  const q = quality(signal, direction, thresholds, confirmationMode);

  if (seconds > finalWindowSeconds) {
    observe(key, direction, false, at);
    return possible(signal, direction, score, seconds, q);
  }

  const strong = score >= thresholds.confirmScore && q.strong;
  const hits = observe(key, direction, strong, at);
  if (strong && hits >= FAST_DECISION.confirmHits) return enter(signal, direction, score, seconds, q);

  // The first valid final-window hit stays visible as POSSÍVEL. Only the second
  // hit inside the confirmation gap upgrades it to ENTRAR.
  if (strong && hits > 0) return possible(signal, direction, score, seconds, q);

  // Fast path is an accelerator, never a veto. While the candidate still has
  // a stable direction and remains above possibleScore, keep POSSÍVEL visible
  // and let the central orchestrator own the final rejection/confirmation.
  if (direction) {
    const pending = possible(signal, direction, score, seconds, q);
    const side = direction === 'BUY' ? 'COMPRA' : 'VENDA';
    const reason = `POSSÍVEL ${side} • ${seconds}s — aguardando confirmação técnica final (score ${Math.round(score)}/100).`;
    return { ...pending, phase: 'FINAL', reason, hint: reason };
  }
  return waitFinal(signal, score, 'sem direção confiável');
}

export function resetFastLiveDecision() {
  trackers.clear();
  directionTrackers.clear();
}
