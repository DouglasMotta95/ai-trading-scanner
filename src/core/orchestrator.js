import { CandleBuilder, TIMEFRAMES } from './candles.js';
import { analyzeCandles } from './analysis.js';

const builders = new Map();
const finalDecisions = new Map();
const completedDecisions = new Map();
const num = v => v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null;
const clean = v => String(v ?? '').trim();

function timeframeMs(value = 'M1') {
  return TIMEFRAMES[clean(value).toUpperCase()] || TIMEFRAMES.M1;
}

function builderKey(snapshot = {}) {
  return `${clean(snapshot.platformId || 'casatrade')}|${clean(snapshot.asset)}|${clean(snapshot.analysisTimeframe || snapshot.timeframe || 'M1')}`;
}

function getBuilder(snapshot = {}) {
  const key = builderKey(snapshot);
  if (!builders.has(key)) builders.set(key, new CandleBuilder(timeframeMs(snapshot.analysisTimeframe || snapshot.timeframe || 'M1')));
  return builders.get(key);
}

function candleTime(raw = {}) {
  let t = Number(raw?.time ?? raw?.timestamp);
  if (Number.isFinite(t) && t > 0 && t < 1e12) t *= 1000;
  return Number.isFinite(t) ? t : null;
}

function validCandle(raw = {}) {
  const open = num(raw.open), high = num(raw.high), low = num(raw.low), close = num(raw.close);
  if ([open, high, low, close].some(v => v == null)) return null;
  return { ...raw, open, high, low, close };
}

function sameTimeframe(raw = {}, wanted = 'M1') {
  const tf = clean(raw?.timeframe).toUpperCase();
  return !tf || tf === clean(wanted).toUpperCase();
}

function currentFromSnapshot(candles = [], bucket, timeframeMsValue, timeframeLabel, price) {
  const row = [...(Array.isArray(candles) ? candles : [])].reverse().find(raw => {
    if (!sameTimeframe(raw, timeframeLabel)) return false;
    const t = candleTime(raw);
    return t != null && Math.floor(t / timeframeMsValue) * timeframeMsValue === bucket;
  });
  const c = row ? validCandle(row) : null;
  if (!c) return null;
  return {
    ...c,
    time: bucket,
    high: Math.max(c.high, price),
    low: Math.min(c.low, price),
    close: price
  };
}

function reasonFor(result = {}, direction = null, final = false) {
  if (!result?.recent?.ready) return 'AGUARDAR — ainda faltam velas suficientes para avaliar a próxima vela.';
  if (!direction) return final ? 'AGUARDAR — o padrão perdeu força. Não entrar na próxima vela.' : 'AGUARDAR — ainda não há direção firme para a próxima vela.';
  const side = direction === 'BUY' ? 'COMPRA' : 'VENDA';
  if (result.recent?.breakout === direction) return `${side} — ${final ? 'rompimento confirmado' : 'rompimento em formação'} e a vela atual favorece a direção.`;
  if (result.recent?.rejection === direction) return `${side} — ${final ? 'rejeição confirmada' : 'rejeição em formação'} e a vela atual favorece a direção.`;
  return `${side} — a sequência das últimas velas e a vela atual mantêm a direção.`;
}

function baseSignal({ state = 'WAIT', direction = null, provisional = true, reason, timeframe = 'M1', expiration = null, candleCount = 0, secondsRemaining = null, progress = null, currentCandle = null, score = 0, analysisDirection = null, analysisScore = null, phase = 'ANALYZING', targetStart = null } = {}) {
  const diagnosis = ['WATCH', 'CONFIRM'].includes(state) && ['BUY', 'SELL'].includes(direction)
    ? direction
    : 'WAIT';
  return {
    state,
    direction,
    diagnosis,
    provisional,
    phase,
    hint: reason,
    reason,
    candleCount,
    warmup: { current: candleCount, required: 3 },
    timeframe,
    targetExpiration: expiration,
    secondsRemaining,
    progress,
    currentCandle,
    score,
    analysisDirection,
    analysisScore: analysisScore == null ? score : analysisScore,
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

export function processSnapshot(snapshot = {}, state = {}) {
  const price = num(snapshot.price);
  if (!snapshot.asset || price == null) {
    return {
      lastConfirmed: null,
      signal: baseSignal({
        state: 'WAIT',
        phase: 'CONNECTING',
        reason: 'AGUARDAR — confirmando ativo e cotação reais da CasaTrade.'
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
  const liveResult = analyzeCandles(combined, indicatorHistory);
  const candleCount = closed.length;

  const clockRemaining = num(snapshot.secondsRemaining);
  const fallbackRemainingMs = Math.max(0, currentBucket + tfMs - sampleAt);
  const remainingMs = clockRemaining != null
    ? Math.max(0, Math.min(tfMs, Math.round(clockRemaining * 1000)))
    : fallbackRemainingMs;
  const secondsRemaining = Math.max(0, Math.ceil(remainingMs / 1000));
  const progress = Math.max(0, Math.min(100, Math.round(((tfMs - remainingMs) / tfMs) * 100)));
  const targetStart = clockRemaining != null ? sampleAt + remainingMs : currentBucket + tfMs;
  const direction = ['BUY', 'SELL'].includes(liveResult.direction) ? liveResult.direction : null;
  const score = Number(liveResult.score || 0);
  const expiration = snapshot.targetExpiration || state.targetExpiration || snapshot.expiration || state.expiration || null;
  const common = {
    timeframe: analysisTimeframe,
    expiration,
    candleCount,
    secondsRemaining,
    progress,
    currentCandle: current ? { ...current } : null,
    score,
    analysisDirection: direction,
    analysisScore: score,
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

  if (candleCount < 3 || !current) {
    return {
      candles: closed,
      currentCandle: current || null,
      lastConfirmed,
      signal: baseSignal({
        ...common,
        state: 'SEARCHING',
        phase: 'HISTORY',
        reason: `Lendo histórico de velas fechadas: ${candleCount}/3 disponíveis.`
      })
    };
  }

  if (secondsRemaining <= 10) {
    const confirmed = !!direction && score >= 58;
    const latestDecision = {
      bucket: currentBucket,
      state: confirmed ? 'CONFIRM' : 'NO_TRADE',
      direction: confirmed ? direction : null,
      provisional: false,
      reason: confirmed
        ? reasonFor(liveResult, direction, true)
        : 'AGUARDAR — confirmação final sem força suficiente. Não entrar na próxima vela.',
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
        score: latestDecision.score,
        targetStart
      })
    };
  }

  if (secondsRemaining <= 30 && direction && score >= 44) {
    return {
      candles: closed,
      currentCandle: current,
      lastConfirmed,
      signal: baseSignal({
        ...common,
        state: 'WATCH',
        direction,
        provisional: true,
        phase: 'POSSIBLE',
        reason: reasonFor(liveResult, direction, false)
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
      reason: secondsRemaining > 30
        ? 'AGUARDAR — analisando as velas fechadas e a vela atual. O pré-sinal abre nos últimos 30s.'
        : 'AGUARDAR — a vela atual ainda não formou um padrão forte o suficiente.'
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
}
