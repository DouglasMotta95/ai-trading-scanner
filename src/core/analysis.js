const finite = v => Number.isFinite(Number(v)) ? Number(v) : null;
const clamp = (v, min = 0, max = 100) => Math.max(min, Math.min(max, Number(v) || 0));
const avg = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;

function shape(c) {
  const open = finite(c?.open), high = finite(c?.high), low = finite(c?.low), close = finite(c?.close);
  if ([open, high, low, close].some(v => v == null)) return null;
  const range = Math.max(1e-12, high - low);
  const body = Math.abs(close - open);
  const upper = high - Math.max(open, close);
  const lower = Math.min(open, close) - low;
  return {
    open, high, low, close, range, body,
    bodyRatio: body / range,
    upperRatio: upper / range,
    lowerRatio: lower / range,
    direction: close > open ? 'BUY' : close < open ? 'SELL' : null
  };
}

export function recentPriceAction(candles = []) {
  const rows = (Array.isArray(candles) ? candles : []).map(shape).filter(Boolean).slice(-5);
  if (rows.length < 3) {
    return {
      ready: false, required: 3, count: rows.length, direction: null, score: 0,
      opinion: 'Aguardando pelo menos 3 velas fechadas reais.', breakout: null,
      lateral: false, doji: false, rejection: null, aligned: 0
    };
  }

  const last = rows.at(-1);
  const prev = rows.slice(0, -1);
  const support = Math.min(...rows.map(x => x.low));
  const resistance = Math.max(...rows.map(x => x.high));
  const up = rows.filter(x => x.direction === 'BUY').length;
  const down = rows.filter(x => x.direction === 'SELL').length;
  const aligned = Math.max(up, down);
  const majority = up === down ? null : up > down ? 'BUY' : 'SELL';
  const avgBody = avg(rows.map(x => x.bodyRatio));
  const rangeSpan = resistance - support;
  const tiny = rows.filter(x => x.bodyRatio < .2).length;
  const lateral = rangeSpan > 0 && Math.abs(last.close - rows[0].open) / rangeSpan < .2 && avgBody < .38;
  const doji = last.bodyRatio < .12 && last.upperRatio > .28 && last.lowerRatio > .28;
  const force = last.bodyRatio >= .62;
  const prevHigh = Math.max(...prev.slice(-3).map(x => x.high));
  const prevLow = Math.min(...prev.slice(-3).map(x => x.low));
  const breakout = last.close > prevHigh ? 'BUY' : last.close < prevLow ? 'SELL' : null;
  const rejection = last.lowerRatio >= .5 && last.close > last.open ? 'BUY' : last.upperRatio >= .5 && last.close < last.open ? 'SELL' : null;

  let buy = 0, sell = 0;
  const reasons = [];
  if (majority === 'BUY') { buy += aligned >= 4 ? 34 : aligned >= 3 ? 26 : 14; reasons.push(`${up} de ${rows.length} velas fecharam em alta`); }
  if (majority === 'SELL') { sell += aligned >= 4 ? 34 : aligned >= 3 ? 26 : 14; reasons.push(`${down} de ${rows.length} velas fecharam em baixa`); }
  if (force && last.direction === 'BUY') { buy += 24; reasons.push('Última vela fechou com força compradora'); }
  if (force && last.direction === 'SELL') { sell += 24; reasons.push('Última vela fechou com força vendedora'); }
  if (breakout === 'BUY') { buy += 28; reasons.push('Rompimento da máxima recente'); }
  if (breakout === 'SELL') { sell += 28; reasons.push('Rompimento da mínima recente'); }
  if (rejection === 'BUY') { buy += 28; reasons.push('Rejeição compradora nas últimas velas'); }
  if (rejection === 'SELL') { sell += 28; reasons.push('Rejeição vendedora nas últimas velas'); }

  let direction = buy === sell ? majority : buy > sell ? 'BUY' : 'SELL';
  let score = Math.max(buy, sell);
  if (aligned >= 3) score += 10;
  if (avgBody >= .48) score += 8;
  if (lateral) { score = Math.min(score, 54); direction = null; reasons.push('Mercado lateral nas últimas velas'); }
  if (doji && !rejection) { score = Math.min(score, 48); direction = null; reasons.push('Doji sem confirmação'); }
  if (tiny >= 3 && aligned < 4) { score = Math.min(score, 56); direction = null; reasons.push('Compressão: aguardando rompimento'); }
  score = clamp(score);

  const opinion = !direction
    ? (reasons.at(-1) || 'Sem direção clara nas últimas velas.')
    : reasons[0] || `Movimento recente favorece ${direction}.`;

  return {
    ready: true, required: 3, count: rows.length, direction, score, opinion,
    breakout, lateral, doji, rejection, aligned, up, down, reasons
  };
}

export function analyzeCandles(candles = []) {
  const rows = (Array.isArray(candles) ? candles : []).filter(c => [c?.open, c?.high, c?.low, c?.close].every(v => finite(v) != null));
  const recent = recentPriceAction(rows);
  if (!recent.ready) return { state: 'WAIT', score: 0, direction: null, reasons: [recent.opinion], recent };
  if (!recent.direction) return { state: 'NO_TRADE', score: recent.score, direction: null, reasons: recent.reasons, recent };
  return {
    state: recent.score >= 70 ? 'WATCH' : 'WAIT',
    score: recent.score,
    direction: recent.direction,
    reasons: recent.reasons,
    recent
  };
}
