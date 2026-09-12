import { CandleBuilder, TIMEFRAMES } from './candles.js';
import { analyzeCandles } from './analysis.js';

const builders = new Map();
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

function confirmationReason(result = {}) {
  if (!result?.recent?.ready) return 'Aguardando pelo menos 3 velas reais fechadas.';
  if (!result.direction) return 'Sem direção clara nas últimas velas.';
  if (result.recent?.breakout === result.direction) return result.direction === 'BUY'
    ? 'Rompimento recente favorece a próxima vela de alta.'
    : 'Rompimento recente favorece a próxima vela de baixa.';
  if (result.recent?.rejection === result.direction) return result.direction === 'BUY'
    ? 'Rejeição compradora favorece a próxima vela de alta.'
    : 'Rejeição vendedora favorece a próxima vela de baixa.';
  return result.direction === 'BUY'
    ? 'Movimento das últimas velas favorece a próxima vela de alta.'
    : 'Movimento das últimas velas favorece a próxima vela de baixa.';
}

function buildSignal(result = {}, state = {}) {
  const ready = !!result?.recent?.ready;
  const direction = ['BUY', 'SELL'].includes(result.direction) ? result.direction : null;
  const live = state.connection === 'online' && state.price != null;

  let signalState = 'WAIT';
  if (live && ready && direction) signalState = 'CONFIRM';
  else if (live && !ready) signalState = 'SEARCHING';
  else if (live && ready && !direction) signalState = 'NO_TRADE';

  return {
    state: signalState,
    direction: signalState === 'CONFIRM' ? direction : null,
    provisional: signalState !== 'CONFIRM',
    hint: confirmationReason(result),
    reason: confirmationReason(result),
    candleCount: Number(result.recent?.count || 0),
    warmup: { current: Number(result.recent?.count || 0), required: 3 },
    timeframe: state.analysisTimeframe || state.timeframe || 'M1',
    targetExpiration: state.targetExpiration || state.expiration || null,
    recentAnalysis: result.recent || null
  };
}

export function processSnapshot(snapshot = {}, state = {}) {
  const price = num(snapshot.price);
  if (!snapshot.asset || price == null) {
    return {
      signal: {
        state: 'WAIT', direction: null, provisional: true,
        hint: 'CasaTrade conectada. Aguardando ativo e cotação.',
        reason: 'CasaTrade conectada. Aguardando ativo e cotação.'
      }
    };
  }

  const normalizedSnapshot = {
    ...snapshot,
    analysisTimeframe: snapshot.analysisTimeframe || snapshot.timeframe || state.analysisTimeframe || state.timeframe || 'M1'
  };

  const builder = getBuilder(normalizedSnapshot);
  if (Array.isArray(snapshot.candles) && snapshot.candles.length) builder.seed(snapshot.candles);
  builder.push(price, Number(snapshot.serverTime) || Date.now());

  const candles = builder.snapshot().closed;
  const result = analyzeCandles(candles.slice(-5));

  return {
    candles,
    signal: buildSignal(result, {
      ...state,
      connection: snapshot.connection || state.connection,
      price,
      analysisTimeframe: normalizedSnapshot.analysisTimeframe,
      timeframe: snapshot.timeframe || state.timeframe || 'M1',
      targetExpiration: snapshot.targetExpiration || state.targetExpiration,
      expiration: snapshot.expiration || state.expiration
    })
  };
}

export function resetOrchestrator() {
  builders.clear();
}
