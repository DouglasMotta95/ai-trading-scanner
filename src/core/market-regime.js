const finite = value => value == null || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null;

export function marketRegime(candles = []) {
  const recent = (Array.isArray(candles) ? candles : [])
    .map(candle => ({ high: finite(candle?.high), low: finite(candle?.low), close: finite(candle?.close) }))
    .filter(candle => candle.high != null && candle.low != null && candle.close != null)
    .slice(-20);

  if (recent.length < 20) return { type: 'unknown', volatility: 0, directional: 0, efficiency: 0, consistency: 0 };

  const ranges = recent.map(candle => Math.abs(candle.high - candle.low));
  const volatility = ranges.reduce((sum, value) => sum + value, 0) / Math.max(1, ranges.length);
  const closes = recent.map(candle => candle.close);
  const deltas = closes.slice(1).map((close, index) => close - closes[index]);
  const net = closes.at(-1) - closes[0];
  const move = Math.abs(net);
  const closePath = deltas.reduce((sum, delta) => sum + Math.abs(delta), 0);
  const efficiency = closePath > 0 ? Math.min(1, move / closePath) : 0;
  const upSteps = deltas.filter(delta => delta > 0).length;
  const downSteps = deltas.filter(delta => delta < 0).length;
  const consistency = deltas.length ? Math.max(upSteps, downSteps) / deltas.length : 0;
  const directional = volatility > 0 ? move / (volatility * recent.length) : 0;

  const directionalTrend = directional >= .28 && consistency >= .63;
  const efficientTrend = efficiency >= .48 && consistency >= .58;
  const trending = move > 0 && (directionalTrend || efficientTrend);

  return {
    type: trending ? (net > 0 ? 'uptrend' : 'downtrend') : 'range',
    volatility,
    directional,
    efficiency,
    consistency
  };
}

export function qualityGate({ connected, stale, regime, newsBlocked = false, dataQuality = 1 } = {}) {
  const reasons = [];
  if (!connected) reasons.push('Sem conexão');
  if (stale) reasons.push('Feed desatualizado');
  if (newsBlocked) reasons.push('Evento de alto impacto');
  if (dataQuality < .8) reasons.push('Qualidade de dados insuficiente');
  if (regime?.type === 'unknown') reasons.push('Regime não identificado');
  return { allowed: reasons.length === 0, reasons };
}
