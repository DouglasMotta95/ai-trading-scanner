const clean = value => String(value ?? '').trim();
const num = value => value == null || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null;

export const FAST_DECISION = Object.freeze({
  possibleScore: 44,
  confirmScore: 58,
  preSignalWindowSeconds: 30,
  finalWindowSeconds: 10,
  confirmHits: 2,
  maxHitGapMs: 5000
});

const trackers = new Map();

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

function quality(signal = {}, direction = null) {
  if (!direction) return { strong: false, power: 0, reasons: [] };
  const a = signal.analytics || {};
  const buy = direction === 'BUY';
  const power = Number(buy ? a.buyPower : a.sellPower) || 0;
  const continuation = a.continuationDirection === direction && Number(a.continuationScore || 0) >= 55;
  const momentum = a.momentumDirection === direction && Number(a.momentumScore || 0) >= 40;
  const rejection = a.rejectionDirection === direction && Number(a.rejectionStrength || 0) >= 50;
  const strength = Number(a.currentStrength || 0) >= 62;
  const reasons = [];
  if (continuation) reasons.push('continuação');
  if (momentum) reasons.push('momentum');
  if (rejection) reasons.push('rejeição');
  if (strength) reasons.push('força');
  return { strong: power >= 50 && reasons.length > 0, power, reasons };
}

function cycleKey(context = {}, signal = {}) {
  const asset = clean(context.asset || signal.asset || 'unknown').toUpperCase();
  const timeframe = clean(context.timeframe || signal.timeframe || 'M1').toUpperCase();
  const seconds = Math.max(0, Number(context.secondsRemaining ?? signal.secondsRemaining ?? 0));
  const now = Number(context.serverTime || Date.now());
  const target = num(signal.targetStart) ?? now + seconds * 1000;
  return `${asset}|${timeframe}|${Math.round(target / 5000) * 5000}`;
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
  const reason = `ENTRAR NA PRÓXIMA VELA: ${side} • ${seconds}s — score ${Math.round(score)}/100 • ${q.reasons.join(' + ') || 'setup confirmado'}.`;
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
  if (signal.uiState === 'ENTER_BUY' || signal.uiState === 'ENTER_SELL' || signal.state === 'CONFIRM') return signal;

  const score = Number(signal.analysisScore ?? signal.score ?? 0);
  const seconds = Math.max(0, Math.ceil(Number(context.secondsRemaining ?? signal.secondsRemaining ?? 0)));
  const direction = directionOf(signal);
  const q = quality(signal, direction);
  const key = cycleKey(context, signal);
  const at = Number(context.serverTime || Date.now());

  if (seconds <= 0) {
    trackers.delete(key);
    return waitFinal(signal, score, 'fechamento da vela em andamento');
  }

  if (seconds > FAST_DECISION.preSignalWindowSeconds) {
    trackers.delete(key);
    const text = `ANALISANDO VELA M1 • ${seconds}s — pré-sinal abre por volta de 30s.`;
    return { ...signal, state: 'WAIT', direction: null, diagnosis: 'WAIT', uiState: 'BUILDING_PATTERN', provisional: true, phase: 'BUILDING', reason: text, hint: text, fastDecision: true };
  }

  if (!direction || score < FAST_DECISION.possibleScore) {
    trackers.delete(key);
    const text = `AGUARDAR • ${seconds}s — leitura ainda fraca (${Math.round(score)}/${FAST_DECISION.possibleScore}).`;
    return { ...signal, state: 'WAIT', direction: null, diagnosis: 'WAIT', uiState: 'WAIT', provisional: true, phase: seconds <= FAST_DECISION.finalWindowSeconds ? 'FINAL' : 'LIVE', reason: text, hint: text, fastDecision: true };
  }

  if (seconds > FAST_DECISION.finalWindowSeconds) {
    observe(key, direction, false, at);
    return possible(signal, direction, score, seconds, q);
  }

  const strong = score >= FAST_DECISION.confirmScore && q.strong;
  const hits = observe(key, direction, strong, at);
  if (strong && hits >= FAST_DECISION.confirmHits) return enter(signal, direction, score, seconds, q);

  return waitFinal(signal, score, direction
    ? `decisão final sem confirmação suficiente para ${direction === 'BUY' ? 'COMPRA' : 'VENDA'}`
    : 'sem direção confiável');
}

export function resetFastLiveDecision() {
  trackers.clear();
}
