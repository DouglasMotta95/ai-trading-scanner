import { clientToken } from './telemetry.js';

export const PUBLIC_AI_API = 'https://ai-trading-scanner-production-62f2.up.railway.app';
const REQUEST_TIMEOUT_MS = 7000;

const num = value => value == null || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null;
const text = (value, max = 220) => String(value ?? '').normalize('NFKC').replace(/[\u0000-\u001f\u007f-\u009f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
const candle = value => {
  if (!value || typeof value !== 'object') return null;
  const open = num(value.open), high = num(value.high), low = num(value.low), close = num(value.close);
  if ([open, high, low, close].some(v => v == null)) return null;
  return { open, high, low, close, time: num(value.time ?? value.timestamp) };
};

export function aiSnapshot(state = {}) {
  const signal = state.signal || {};
  const clock = state.diagnostics?.marketClock || {};
  const rows = (Array.isArray(state.candles) ? state.candles : []).map(candle).filter(Boolean).slice(-10);
  const current = candle(signal.currentCandle || state.currentCandle || {});
  return {
    asset: text(state.asset, 64),
    marketType: text(state.instrumentType && state.instrumentType !== 'unknown' ? state.instrumentType : state.marketType, 40),
    timeframe: text(state.analysisTimeframe || signal.timeframe || state.timeframe, 24),
    expiration: text(state.targetExpiration || signal.targetExpiration || state.expiration, 24),
    price: num(state.price),
    secondsRemaining: num(signal.secondsRemaining ?? state.secondsRemaining),
    targetStart: num(signal.targetStart),
    currentCandle: current,
    candles: rows,
    signal: {
      state: text(signal.state, 24),
      uiState: text(signal.uiState, 32),
      phase: text(signal.phase, 24),
      direction: ['BUY', 'SELL'].includes(String(signal.direction || '').toUpperCase()) ? String(signal.direction).toUpperCase() : null,
      analysisDirection: ['BUY', 'SELL'].includes(String(signal.analysisDirection || '').toUpperCase()) ? String(signal.analysisDirection).toUpperCase() : null,
      score: num(signal.score),
      analysisScore: num(signal.analysisScore),
      setup: text(signal.setup, 80),
      reason: text(signal.reason, 260),
      waitingFor: signal.waitingFor && typeof signal.waitingFor === 'object' ? {
        direction: ['BUY', 'SELL'].includes(String(signal.waitingFor.direction || '').toUpperCase()) ? String(signal.waitingFor.direction).toUpperCase() : null,
        text: text(signal.waitingFor.text, 220),
        level: num(signal.waitingFor.level)
      } : {},
      regime: signal.regime && typeof signal.regime === 'object' ? {
        type: text(signal.regime.type, 40),
        efficiency: num(signal.regime.efficiency),
        slope: num(signal.regime.slope)
      } : {},
      analytics: signal.analytics && typeof signal.analytics === 'object' ? {
        buyPower: num(signal.analytics.buyPower),
        sellPower: num(signal.analytics.sellPower),
        currentStrength: num(signal.analytics.currentStrength),
        rejectionStrength: num(signal.analytics.rejectionStrength),
        rejectionDirection: text(signal.analytics.rejectionDirection, 16),
        continuationDirection: text(signal.analytics.continuationDirection, 16),
        continuationScore: num(signal.analytics.continuationScore),
        momentumDirection: text(signal.analytics.momentumDirection, 16),
        momentumScore: num(signal.analytics.momentumScore),
        breakoutHigh: num(signal.analytics.breakoutHigh),
        breakoutLow: num(signal.analytics.breakoutLow),
        support: num(signal.analytics.support),
        resistance: num(signal.analytics.resistance)
      } : {}
    },
    clock: {
      verified: clock.verified === true,
      role: text(clock.role, 32),
      source: text(clock.source, 48)
    }
  };
}

export function aiSnapshotReady(snapshot = {}) {
  return !!snapshot.asset && snapshot.price != null && Array.isArray(snapshot.candles) && snapshot.candles.length >= 2 && snapshot.clock?.verified === true;
}

export async function requestAiAnalysis(state = {}) {
  const snapshot = aiSnapshot(state);
  if (!aiSnapshotReady(snapshot)) return { ok: false, error: 'insufficient_market_data' };
  const token = await clientToken();
  if (!token) return { ok: false, error: 'client_token_missing' };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${PUBLIC_AI_API}/v1/ai/analyze`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`
      },
      signal: controller.signal,
      body: JSON.stringify(snapshot)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data?.ok === false) return { ok: false, status: response.status, error: data?.error || `http_${response.status}` };
    return { ok: true, analysis: data.analysis || null };
  } catch (error) {
    return { ok: false, error: error?.name === 'AbortError' ? 'ai_timeout' : 'ai_unreachable' };
  } finally {
    clearTimeout(timeout);
  }
}
