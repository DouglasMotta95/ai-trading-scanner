import { CandleBuilder, TIMEFRAMES } from './candles.js';
import { analyzeCandles } from './analysis.js';

const builders = new Map();
const finalDecisions = new Map();
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

function currentFromSnapshot(candles = [], bucket, timeframe, price) {
  const row = [...(Array.isArray(candles) ? candles : [])].reverse().find(raw => {
    const t = candleTime(raw);
    return t != null && Math.floor(t / timeframe) * timeframe === bucket;
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
  if (!result?.recent?.ready) return 'Lendo as velas anteriores e a vela atual.';
  if (!direction) return final ? 'Padrão perdeu força. Não entrar na próxima vela.' : 'Sem direção firme ainda. Continuando a análise.';
  const side = direction === 'BUY' ? 'compra' : 'venda';
  if (result.recent?.breakout === direction) return `${final ? 'Confirmado' : 'Possível'} ${side}: rompimento + vela atual favorecem a direção.`;
  if (result.recent?.rejection === direction) return `${final ? 'Confirmado' : 'Possível'} ${side}: rejeição + vela atual favorecem a direção.`;
  return `${final ? 'Confirmado' : 'Possível'} ${side}: sequência recente e vela atual mantêm a direção.`;
}

function baseSignal({ state = 'WAIT', direction = null, provisional = true, reason, timeframe = 'M1', expiration = null, candleCount = 0, secondsRemaining = null, progress = null, currentCandle = null, score = 0, phase = 'ANALYZING', targetStart = null } = {}) {
  return {
    state,
    direction,
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
    targetStart,
    targetLabel: targetStart ? new Date(targetStart).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : null
  };
}

export function processSnapshot(snapshot = {}, state = {}) {
  const price = num(snapshot.price);
  if (!snapshot.asset || price == null) {
    return {
      signal: baseSignal({
        state: 'WAIT',
        reason: 'CasaTrade conectada. Aguardando ativo e cotação reais.'
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
    const t = candleTime(raw);
    return t != null && Math.floor(t / tfMs) * tfMs < currentBucket;
  });
  if (history.length) builder.seed(history);
  builder.push(price, sampleAt);

  const shot = builder.snapshot();
  const closed = shot.closed.slice(-120);
  const current = currentFromSnapshot(snapshot.candles, currentBucket, tfMs, price) || shot.current;
  const combined = current ? [...closed.slice(-4), current] : closed.slice(-5);
  const liveResult = analyzeCandles(combined);
  const candleCount = closed.length;

  const endAt = currentBucket + tfMs;
  const remainingMs = Math.max(0, endAt - sampleAt);
  const secondsRemaining = Math.max(0, Math.ceil(remainingMs / 1000));
  const progress = Math.max(0, Math.min(100, Math.round(((tfMs - remainingMs) / tfMs) * 100)));
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
    targetStart: endAt
  };

  const previousDecision = finalDecisions.get(key);
  if (previousDecision && previousDecision.bucket !== currentBucket) finalDecisions.delete(key);

  if (candleCount < 3 || !current) {
    return {
      candles: closed,
      currentCandle: current || null,
      signal: baseSignal({
        ...common,
        state: 'SEARCHING',
        phase: 'ANALYZING',
        reason: `Lendo histórico real: ${candleCount}/3 velas fechadas disponíveis.`
      })
    };
  }

  if (secondsRemaining <= 10) {
    let locked = finalDecisions.get(key);
    if (!locked || locked.bucket !== currentBucket) {
      const confirmed = !!direction && score >= 58;
      locked = {
        bucket: currentBucket,
        state: confirmed ? 'CONFIRM' : 'NO_TRADE',
        direction: confirmed ? direction : null,
        provisional: false,
        reason: confirmed
          ? reasonFor(liveResult, direction, true)
          : 'Confirmação final sem força suficiente. Não entrar na próxima vela.',
        score
      };
      finalDecisions.set(key, locked);
    }
    return {
      candles: closed,
      currentCandle: current,
      signal: baseSignal({
        ...common,
        ...locked,
        phase: 'FINAL',
        score: locked.score,
        targetStart: endAt
      })
    };
  }

  if (secondsRemaining <= 30 && direction && score >= 44) {
    return {
      candles: closed,
      currentCandle: current,
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
    signal: baseSignal({
      ...common,
      state: 'WAIT',
      direction: null,
      provisional: true,
      phase: 'ANALYZING',
      reason: secondsRemaining > 30
        ? `Analisando velas anteriores + vela atual. Pré-sinal abre nos últimos 30s.`
        : 'Analisando a vela atual. Aguardando padrão mais forte.'
    })
  };
}

export function resetOrchestrator() {
  builders.clear();
  finalDecisions.clear();
}
