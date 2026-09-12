import { CandleBuilder, TIMEFRAMES } from './candles.js';
import { analyzeCandles } from './analysis.js';
import { confluence } from './confluence.js';
import { marketRegime, qualityGate } from './market-regime.js';
import { tradingGuard, dedupeSignal } from './risk-controls.js';
import { nextSignalState } from './signal-machine.js';

const builders = new Map();
const lastSignals = new Map();
const frame = s => String(s.analysisTimeframe || s.timeframe || 'M1').toUpperCase();
const key = s => `${s.platformId || 'unknown'}:${s.asset || 'unknown'}:${frame(s)}`;
const tf = s => TIMEFRAMES[frame(s)] || TIMEFRAMES.M1;

const priceOf = v => {
  if (Number.isFinite(v)) return Number(v);
  let s = String(v ?? '').trim().replace(/\s/g, '').replace(/[^\d,.-]/g, '');
  if (s.includes(',') && s.includes('.')) s = s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  else s = s.replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

const aligned = (direction, a, b) => direction === 'BUY' ? a > b : direction === 'SELL' ? a < b : false;
const clampScore = v => Math.max(50, Math.min(95, Number.isFinite(Number(v)) ? Number(v) : 78));
const recentFlow = candles => {
  const rows = candles.slice(-5);
  let up = 0, down = 0, flat = 0;
  for (const c of rows) {
    const o = Number(c?.open), cl = Number(c?.close);
    if (!Number.isFinite(o) || !Number.isFinite(cl)) continue;
    if (cl > o) up++; else if (cl < o) down++; else flat++;
  }
  return { count: rows.length, up, down, flat, direction: up === down ? null : up > down ? 'BUY' : 'SELL' };
};

const warm = (state, connected, candles, timeframe, targetExpiration, structured) => ({
  signal: {
    state: state.scanner === 'scanning' ? 'SEARCHING' : 'WAIT',
    score: 0,
    grade: '—',
    confirmations: '0 / 6',
    direction: null,
    timeframe,
    targetExpiration,
    hint: !connected
      ? 'Aguardando preço válido.'
      : state.scanner !== 'scanning'
        ? 'Scanner pronto.'
        : `Aquecendo motor • ${Math.min(candles.length, 21)}/21 candles ${structured ? 'estruturados' : 'provisórios'}.`,
    provisional: !structured,
    candleCount: candles.length,
    recentFlow: recentFlow(candles),
    warmup: { current: Math.min(candles.length, 21), required: 21 }
  }
});

export function resetOrchestrator() {
  builders.clear();
  lastSignals.clear();
}

export function processSnapshot(snapshot = {}, state = {}, risk = {}) {
  const price = priceOf(snapshot.price);
  const connected = price !== null;
  const k = key(snapshot);
  const analysisTimeframe = frame(snapshot);
  const targetExpiration = snapshot.targetExpiration || snapshot.expiration || null;
  const structured = !!snapshot.capabilities?.structuredQuotes;
  const minScore = clampScore(risk.minScore);
  const threshold = risk.onlyA ? Math.max(85, minScore) : minScore;

  const serverTime = Number(snapshot.serverTime);
  const staleMs = Math.max(1500, Number(risk.staleMs) || 6000);
  const stale = risk.staleBlock !== false && Number.isFinite(serverTime) && serverTime > 1e12 && Math.abs(Date.now() - serverTime) > staleMs;

  if (!builders.has(k)) builders.set(k, new CandleBuilder(tf(snapshot)));
  const builder = builders.get(k);
  if (Array.isArray(snapshot.candles) && snapshot.candles.length) builder.seed(snapshot.candles);
  const closed = connected ? builder.push(price, Number(snapshot.serverTime) || Date.now()) : null;
  const candles = builder.snapshot().closed;

  if (candles.length < 21) return warm(state, connected, candles, analysisTimeframe, targetExpiration, structured);
  if (!closed && state.signal?.updatedAt) {
    return {
      signal: {
        ...state.signal,
        timeframe: analysisTimeframe,
        targetExpiration,
        candleCount: candles.length,
        recentFlow: recentFlow(candles),
        provisional: !structured,
        warmup: { current: 21, required: 21 }
      }
    };
  }

  const analysis = analyzeCandles(candles);
  const regime = marketRegime(candles);
  const recent = recentFlow(candles);
  const rsi = analysis.indicators?.rsi14;
  const macd = analysis.indicators?.macd?.histogram;
  const e9 = analysis.indicators?.ema9;
  const e21 = analysis.indicators?.ema21;
  const d = analysis.direction;

  const checks = [
    { label: 'Direção quantitativa', weight: 20, passed: !!d },
    { label: 'Tendência EMA alinhada', weight: 20, passed: aligned(d, e9, e21) },
    { label: 'RSI compatível', weight: 20, passed: d === 'BUY' ? rsi >= 50 && rsi < 75 : d === 'SELL' ? rsi <= 50 && rsi > 25 : false },
    { label: 'MACD alinhado', weight: 20, passed: d === 'BUY' ? macd > 0 : d === 'SELL' ? macd < 0 : false },
    { label: 'Regime identificado', weight: 10, passed: regime.type !== 'unknown' },
    { label: 'Força quantitativa', weight: 10, passed: analysis.score >= 70 }
  ];

  const cf = confluence(checks);
  const gate = qualityGate({ connected, stale, regime, dataQuality: structured ? 1 : .85 });
  const guard = tradingGuard(risk);
  const candidate = { asset: snapshot.asset, direction: d, createdAt: Date.now() };
  const duplicate = !!d && dedupeSignal(lastSignals.get(k), candidate, risk.cooldownMs || 60000);
  const baseAllowed = gate.allowed && guard.allowed && !duplicate;
  const scoreReady = !!d && cf.score >= threshold;
  const provisionalWatch = !structured && baseAllowed && scoreReady;
  const allowed = structured && baseAllowed;
  const finalAnalysis = {
    ...analysis,
    score: cf.score,
    state: allowed ? (scoreReady ? 'WATCH' : 'WAIT') : provisionalWatch ? 'WATCH' : 'NO_TRADE'
  };
  const machine = provisionalWatch
    ? { state: 'WATCH', label: `${d} • PRÉ-SINAL PROVISÓRIO` }
    : nextSignalState(state.signal?.state, finalAnalysis, { connected, scanning: state.scanner === 'scanning', stale });

  const blocked = [
    ...gate.reasons,
    ...guard.reasons,
    duplicate ? 'Sinal duplicado em cooldown' : null,
    !structured && !provisionalWatch ? 'Feed estruturado ainda não validado' : null,
    baseAllowed && !scoreReady ? `Score ${cf.score}/${threshold} abaixo do mínimo` : null,
    risk.onlyA && cf.grade !== 'A+' ? 'Configuração exige setup A+' : null
  ].filter(Boolean);

  if (allowed && scoreReady && machine.state === 'CONFIRM') lastSignals.set(k, candidate);

  const readyDirection = baseAllowed && scoreReady ? d : null;
  const recentText = recent.count >= 3 ? `Últimas ${recent.count} velas: ${recent.up} alta • ${recent.down} baixa` : null;
  const hint = provisionalWatch
    ? `${machine.label} • aguardando validação do feed antes de confirmar entrada.`
    : allowed && scoreReady
      ? machine.label
      : blocked.join(' • ') || `Aguardando score mínimo ${threshold}.`;

  return {
    signal: {
      state: machine.state,
      score: baseAllowed ? cf.score : 0,
      rawScore: cf.score,
      grade: baseAllowed ? cf.grade : '—',
      confirmations: `${cf.confirmations} / ${cf.total}`,
      direction: readyDirection,
      timeframe: analysisTimeframe,
      targetExpiration,
      hint,
      reasons: [...new Set([...(analysis.reasons || []), ...(cf.reasons || []), recentText].filter(Boolean))],
      regime: regime.type,
      recentFlow: recent,
      provisional: !structured,
      candleCount: candles.length,
      warmup: { current: 21, required: 21 },
      threshold,
      updatedAt: Date.now()
    }
  };
}
