// Motor quantitativo local v0.2 — sem promessas de probabilidade.
// Trabalha apenas com dados observados e devolve score de confluência.
export function ema(values, period) {
  if (!values?.length) return null;
  const k = 2 / (period + 1);
  let out = values[0];
  for (let i = 1; i < values.length; i++) out = values[i] * k + out * (1 - k);
  return out;
}

export function rsi(values, period = 14) {
  if (!values || values.length <= period) return null;
  let gains = 0, losses = 0;
  for (let i = values.length - period; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gains += d; else losses -= d;
  }
  if (losses === 0) return 100;
  const rs = (gains / period) / (losses / period);
  return 100 - 100 / (1 + rs);
}

export function analyzeCandles(candles = []) {
  if (candles.length < 21) return { state:'NO_TRADE', score:0, direction:null, reasons:['Dados insuficientes'] };
  const closes = candles.map(c => Number(c.close)).filter(Number.isFinite);
  if (closes.length < 21) return { state:'NO_TRADE', score:0, direction:null, reasons:['Candles inválidos'] };
  const e9 = ema(closes.slice(-30), 9), e21 = ema(closes.slice(-40), 21), momentum = rsi(closes, 14);
  const last = closes.at(-1);
  let buy = 0, sell = 0; const reasons = [];
  if (e9 > e21) { buy += 30; reasons.push('EMA 9 acima da EMA 21'); } else { sell += 30; reasons.push('EMA 9 abaixo da EMA 21'); }
  if (last > e9) buy += 20; else sell += 20;
  if (momentum != null && momentum >= 52 && momentum <= 72) { buy += 25; reasons.push('Momentum comprador saudável'); }
  if (momentum != null && momentum <= 48 && momentum >= 28) { sell += 25; reasons.push('Momentum vendedor saudável'); }
  const direction = buy === sell ? null : buy > sell ? 'BUY' : 'SELL';
  const score = Math.max(buy, sell);
  return { state: score >= 70 ? 'WATCH' : 'WAIT', score, direction, reasons, indicators:{ ema9:e9, ema21:e21, rsi14:momentum } };
}
