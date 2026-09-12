import { CandleBuilder } from './candles.js';
import { analyzeCandles } from './analysis.js';

const builders = new Map();
const num = v => v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null;
const clean = v => String(v ?? '').trim();

function builderKey(snapshot = {}) {
  return `${clean(snapshot.platformId || 'casatrade')}|${clean(snapshot.asset)}|${clean(snapshot.analysisTimeframe || snapshot.timeframe || 'M1')}`;
}

function getBuilder(snapshot = {}) {
  const key = builderKey(snapshot);
  if (!builders.has(key)) builders.set(key, new CandleBuilder(snapshot.analysisTimeframe || snapshot.timeframe || 'M1'));
  return builders.get(key);
}

function confirmationReason(result = {}) {
  if (!result?.recent?.ready) return 'Aguardando pelo menos 3 velas reais fechadas.';
  if (!result.direction) return 'Sem confluência suficiente nas últimas velas.';
  if (result.recent?.breakout === result.direction) return `Rompimento recente confirmado para ${result.direction}.`;
  if (result.recent?.rejection === result.direction) return `Rejeição recente confirmou ${result.direction}.`;
  if (result.recent?.trend === result.direction) return `Direção das últimas velas favorece ${result.direction}.`;
  return `Confluência recente favorece ${result.direction}.`;
}

function buildSignal(result = {}, state = {}) {
  const ready = !!result?.recent?.ready;
  const direction = ['BUY', 'SELL'].includes(result.direction) ? result.direction : null;
  const aligned = state.platformControls?.aligned !== false;
  const live = state.connection === 'online' && state.price != null;
  const strong = ready && direction && (result.recent?.breakout === direction || result.recent?.rejection === direction || Number(result.recent?.aligned || 0) >= 3);
  let signalState = 'WAIT';
  if (live && ready && direction) signalState = strong && aligned ? 'CONFIRM' : 'WATCH';
  else if (live && !ready) signalState = 'SEARCHING';

  return {
    state: signalState,
    direction: signalState === 'CONFIRM' || signalState === 'WATCH' ? direction : null,
    provisional: signalState !== 'CONFIRM',
    hint: confirmationReason(result),
    reason: confirmationReason(result),
    candleCount: Number(result.recent?.count || 0),
    warmup: { current: Number(result.recent?.count || 0), required: 3 },
    timeframe: state.analysisTimeframe || state.timeframe || null,
    targetExpiration: state.targetExpiration || state.expiration || null,
    recentAnalysis: result.recent || null
  };
}

export function processSnapshot(snapshot = {}, state = {}) {
  const price = num(snapshot.price);
  if (!snapshot.asset || price == null) {
    return { signal: { state: 'WAIT', direction: null, provisional: true, hint: 'Aguardando ativo e cotação reais da CasaTrade.', reason: 'Aguardando ativo e cotação reais da CasaTrade.' } };
  }

  const builder = getBuilder(snapshot);
  if (Array.isArray(snapshot.candles) && snapshot.candles.length) builder.seed(snapshot.candles);
  if (snapshot.serverTime != null) builder.push({ price, time: Number(snapshot.serverTime) || Date.now() });
  else builder.push({ price, time: Date.now() });

  const candles = builder.closed();
  const result = analyzeCandles(candles.slice(-5));
  return {
    candles,
    signal: buildSignal(result, {
      ...state,
      connection: snapshot.connection || state.connection,
      price,
      analysisTimeframe: snapshot.analysisTimeframe || state.analysisTimeframe,
      timeframe: snapshot.timeframe || state.timeframe,
      targetExpiration: snapshot.targetExpiration || state.targetExpiration,
      expiration: snapshot.expiration || state.expiration
    })
  };
}

export function resetOrchestrator() {
  builders.clear();
}
