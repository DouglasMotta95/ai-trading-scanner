import { rsi, macd } from './indicators.js';

const finite = v => v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null;
const clamp = (v, min = 0, max = 100) => Math.max(min, Math.min(max, Number(v) || 0));
const avg = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
const sum = a => a.reduce((s, v) => s + v, 0);

export const INDICATOR_SCORE_WEIGHTS = Object.freeze({
  rsiFavor: 8,
  macdFavor: 10,
  macdAgainst: -10,
  ema: 0,
  bollinger: 0
});

export const ANALYST_THRESHOLDS = Object.freeze({
  minimumClosedCandles: 2,
  preferredClosedCandles: 3,
  minimumPatternRows: 3,
  possibleScore: 44,
  confirmScore: 58,
  candleStrength: 62,
  rejectionStrength: 50
});

const formatLevel = value => {
  const n = finite(value);
  if (n == null) return '—';
  const abs = Math.abs(n);
  const digits = abs >= 1000 ? 2 : abs >= 100 ? 3 : abs >= 1 ? 5 : 8;
  return n.toFixed(digits).replace(/0+$/, '').replace(/\.$/, '');
};

export function waitingFor(recent = {}, direction = null, score = 0) {
  if (!recent?.ready) {
    return {
      type: 'history', direction: null, label: 'Histórico recente', level: null,
      current: Number(recent?.count || 0), required: ANALYST_THRESHOLDS.minimumPatternRows,
      text: 'Aguardando histórico recente suficiente para formar o padrão.'
    };
  }

  const metrics = recent.metrics || {};
  const chosenDirection = ['BUY', 'SELL'].includes(direction) ? direction : null;
  const lastClose = finite(recent.lastClose);
  const avgRange = Math.max(1e-12, finite(recent.averageRange) || Math.abs(Number(recent.resistance || 0) - Number(recent.support || 0)) || 1);
  const candidates = [];
  const add = candidate => {
    if (!candidate || !Number.isFinite(Number(candidate.gap))) return;
    candidates.push(candidate);
  };
  const levelGap = (level, side) => {
    const n = finite(level);
    if (n == null || lastClose == null) return Infinity;
    const distance = side === 'BUY' ? Math.max(0, n - lastClose) : Math.max(0, lastClose - n);
    return distance / avgRange;
  };

  if (!chosenDirection || chosenDirection === 'BUY') {
    const level = finite(recent.breakoutHigh);
    if (recent.breakout !== 'BUY' && level != null) add({
      type: 'breakout', direction: 'BUY', label: 'Rompimento da máxima', level,
      current: lastClose, required: level, gap: levelGap(level, 'BUY'),
      text: `Aguardando rompimento da máxima recente em ${formatLevel(level)}.`
    });
  }
  if (!chosenDirection || chosenDirection === 'SELL') {
    const level = finite(recent.breakoutLow);
    if (recent.breakout !== 'SELL' && level != null) add({
      type: 'breakout', direction: 'SELL', label: 'Rompimento da mínima', level,
      current: lastClose, required: level, gap: levelGap(level, 'SELL'),
      text: `Aguardando rompimento da mínima recente em ${formatLevel(level)}.`
    });
  }

  if (chosenDirection) {
    const buy = chosenDirection === 'BUY';
    const rejectionNow = Number(buy ? metrics.rejectionBuy : metrics.rejectionSell) || 0;
    if (recent.rejection !== chosenDirection) add({
      type: 'rejection', direction: chosenDirection,
      label: `Rejeição ${buy ? 'compradora' : 'vendedora'}`, level: null,
      current: rejectionNow, required: ANALYST_THRESHOLDS.rejectionStrength,
      gap: Math.max(0, ANALYST_THRESHOLDS.rejectionStrength - rejectionNow) / ANALYST_THRESHOLDS.rejectionStrength,
      text: `Aguardando confirmação de rejeição ${buy ? 'compradora' : 'vendedora'} (${Math.round(rejectionNow)}%/${ANALYST_THRESHOLDS.rejectionStrength}%).`
    });

    const power = Number(buy ? metrics.buyPower : metrics.sellPower) || 0;
    if (power < 50) add({
      type: 'power', direction: chosenDirection,
      label: `Poder ${buy ? 'comprador' : 'vendedor'}`, level: null,
      current: power, required: 50, gap: (50 - power) / 50,
      text: `Aguardando poder ${buy ? 'comprador' : 'vendedor'} atingir 50% (agora ${Math.round(power)}%).`
    });

    const strength = Number(metrics.currentStrength || 0);
    if (strength < ANALYST_THRESHOLDS.candleStrength) add({
      type: 'candle_strength', direction: chosenDirection,
      label: 'Força da vela atual', level: null,
      current: strength, required: ANALYST_THRESHOLDS.candleStrength,
      gap: Math.max(0, ANALYST_THRESHOLDS.candleStrength - strength) / ANALYST_THRESHOLDS.candleStrength,
      text: `Aguardando força da vela atingir ${ANALYST_THRESHOLDS.candleStrength}% (agora ${Math.round(strength)}%).`
    });

    const continuation = Number(recent.continuationScore || 0);
    if (recent.continuationDirection !== chosenDirection || continuation < 60) add({
      type: 'continuation', direction: chosenDirection,
      label: 'Continuação do movimento', level: null,
      current: continuation, required: 60,
      gap: Math.max(0, 60 - continuation) / 60,
      text: `Aguardando continuidade ${buy ? 'compradora' : 'vendedora'} ficar consistente (${Math.round(continuation)}%/60%).`
    });
  }

  const targetScore = Number(score) < ANALYST_THRESHOLDS.possibleScore
    ? ANALYST_THRESHOLDS.possibleScore
    : Number(score) < ANALYST_THRESHOLDS.confirmScore
      ? ANALYST_THRESHOLDS.confirmScore
      : null;
  if (targetScore != null) add({
    type: targetScore === ANALYST_THRESHOLDS.possibleScore ? 'possible_score' : 'confirm_score',
    direction: chosenDirection, label: 'Força do padrão', level: null,
    current: Number(score) || 0, required: targetScore,
    gap: Math.max(0, targetScore - Number(score || 0)) / targetScore,
    text: `Aguardando força do padrão atingir ${targetScore}/100 (agora ${Math.round(Number(score) || 0)}/100).`
  });

  if ((recent.lateral || (recent.reasons || []).some(reason => /compressão/i.test(String(reason)))) && candidates.length) {
    for (const candidate of candidates) if (candidate.type === 'breakout') candidate.gap *= .45;
  }

  candidates.sort((a, b) => a.gap - b.gap);
  const best = candidates[0];
  if (best) {
    const { gap, ...publicCandidate } = best;
    return publicCandidate;
  }
  return {
    type: 'stability', direction: chosenDirection, label: 'Confirmação estável', level: null,
    current: null, required: 2,
    text: 'Aguardando nova confirmação estável do padrão.'
  };
}

function shape(c) {
  const open = finite(c?.open), high = finite(c?.high), low = finite(c?.low), close = finite(c?.close);
  if ([open, high, low, close].some(v => v == null)) return null;
  const range = Math.max(1e-12, high - low);
  const body = Math.abs(close - open);
  const upper = Math.max(0, high - Math.max(open, close));
  const lower = Math.max(0, Math.min(open, close) - low);
  const direction = close > open ? 'BUY' : close < open ? 'SELL' : null;
  const bodyRatio = body / range;
  const upperRatio = upper / range;
  const lowerRatio = lower / range;
  const closeFromLow = clamp(((close - low) / range) * 100);
  const closeFromHigh = clamp(((high - close) / range) * 100);
  const buyPressure = clamp(closeFromLow * .6 + (direction === 'BUY' ? bodyRatio * 100 * .4 : 0));
  const sellPressure = clamp(closeFromHigh * .6 + (direction === 'SELL' ? bodyRatio * 100 * .4 : 0));
  return {
    open, high, low, close, range, body, bodyRatio, upperRatio, lowerRatio, direction,
    strength: clamp(bodyRatio * 100),
    buyPressure,
    sellPressure
  };
}

function momentum(rows = []) {
  if (rows.length < 2) return { direction: null, score: 0, net: 0 };
  const deltas = rows.slice(1).map((row, index) => row.close - rows[index].close);
  const net = sum(deltas);
  const activity = sum(deltas.map(Math.abs));
  const avgRange = Math.max(1e-12, avg(rows.map(row => row.range)));
  const directionalConsistency = activity > 0 ? Math.abs(net) / activity : 0;
  const displacement = Math.min(1, Math.abs(net) / (avgRange * Math.max(1, deltas.length)));
  return {
    direction: net > 0 ? 'BUY' : net < 0 ? 'SELL' : null,
    score: clamp((directionalConsistency * .65 + displacement * .35) * 100),
    net
  };
}

function indicatorReinforcement(candles = [], direction = null) {
  const closes = (Array.isArray(candles) ? candles : [])
    .map(c => finite(c?.close))
    .filter(v => v != null);
  const rsiValue = rsi(closes);
  const macdValue = macd(closes);
  let rsiEffect = 0;
  let macdEffect = 0;
  const reasons = [];

  if (direction === 'BUY' && rsiValue != null && rsiValue > 50) rsiEffect = INDICATOR_SCORE_WEIGHTS.rsiFavor;
  if (direction === 'SELL' && rsiValue != null && rsiValue < 50) rsiEffect = INDICATOR_SCORE_WEIGHTS.rsiFavor;
  if (rsiEffect) reasons.push(`RSI ${rsiValue.toFixed(1)} reforça ${direction} (+${rsiEffect})`);

  const histogram = finite(macdValue?.histogram);
  if (direction && histogram != null && histogram !== 0) {
    const favorsDirection = direction === 'BUY' ? histogram > 0 : histogram < 0;
    macdEffect = favorsDirection ? INDICATOR_SCORE_WEIGHTS.macdFavor : INDICATOR_SCORE_WEIGHTS.macdAgainst;
    reasons.push(`MACD ${favorsDirection ? 'a favor' : 'contra'} ${direction} (${macdEffect > 0 ? '+' : ''}${macdEffect})`);
  }

  return {
    weights: { ...INDICATOR_SCORE_WEIGHTS },
    rsi: { value: rsiValue, effect: rsiEffect },
    macd: { ...(macdValue || { macd: null, signal: null, histogram: null }), effect: macdEffect },
    ema: { effect: INDICATOR_SCORE_WEIGHTS.ema },
    bollinger: { effect: INDICATOR_SCORE_WEIGHTS.bollinger },
    adjustment: rsiEffect + macdEffect,
    reasons
  };
}

function analystMetrics(rows = []) {
  const window = rows.slice(-5);
  const last = window[window.length - 1] || null;
  const previous = window.slice(0, -1);
  const buyPower = clamp(avg(window.map(row => row.buyPressure)));
  const sellPower = clamp(avg(window.map(row => row.sellPressure)));
  const momentumValue = momentum(window);
  const currentStrength = clamp(last?.strength || 0);
  const rejectionBuy = clamp((last?.lowerRatio || 0) * 100);
  const rejectionSell = clamp((last?.upperRatio || 0) * 100);
  const rejectionDirection = rejectionBuy >= ANALYST_THRESHOLDS.rejectionStrength && last?.close > last?.open
    ? 'BUY'
    : rejectionSell >= ANALYST_THRESHOLDS.rejectionStrength && last?.close < last?.open
      ? 'SELL'
      : null;
  const rejectionStrength = rejectionDirection === 'BUY' ? rejectionBuy : rejectionDirection === 'SELL' ? rejectionSell : Math.max(rejectionBuy, rejectionSell);
  const previousBody = avg(previous.map(row => row.bodyRatio));
  const bodyLoss = previousBody > 0 ? clamp(((previousBody - (last?.bodyRatio || 0)) / previousBody) * 100) : 0;
  const oppositeWick = last?.direction === 'BUY' ? rejectionSell : last?.direction === 'SELL' ? rejectionBuy : Math.max(rejectionBuy, rejectionSell);
  const lossOfStrength = clamp(bodyLoss * .7 + oppositeWick * .3);

  return {
    buyPower,
    sellPower,
    currentStrength,
    rejectionDirection,
    rejectionStrength,
    rejectionBuy,
    rejectionSell,
    momentumDirection: momentumValue.direction,
    momentumScore: momentumValue.score,
    lossOfStrength
  };
}

export function recentPriceAction(candles = []) {
  const rows = (Array.isArray(candles) ? candles : []).map(shape).filter(Boolean).slice(-10);
  if (rows.length < ANALYST_THRESHOLDS.minimumPatternRows) {
    return {
      ready: false,
      required: ANALYST_THRESHOLDS.minimumPatternRows,
      count: rows.length,
      direction: null,
      score: 0,
      opinion: 'Montando padrão com as velas recentes e a vela atual.',
      breakout: null,
      lateral: false,
      doji: false,
      rejection: null,
      aligned: 0,
      metrics: analystMetrics(rows),
      breakoutHigh: null,
      breakoutLow: null,
      support: null,
      resistance: null,
      averageRange: null,
      lastClose: rows[rows.length - 1]?.close ?? null
    };
  }

  const last = rows[rows.length - 1];
  const prev = rows.slice(0, -1);
  const support = Math.min(...rows.map(x => x.low));
  const resistance = Math.max(...rows.map(x => x.high));
  const up = rows.filter(x => x.direction === 'BUY').length;
  const down = rows.filter(x => x.direction === 'SELL').length;
  const aligned = Math.max(up, down);
  const agreement = aligned / rows.length;
  const majority = up === down ? null : up > down ? 'BUY' : 'SELL';
  const avgBody = avg(rows.map(x => x.bodyRatio));
  const rangeSpan = resistance - support;
  const tiny = rows.filter(x => x.bodyRatio < .2).length;
  const lateral = rangeSpan > 0 && Math.abs(last.close - rows[0].open) / rangeSpan < .2 && avgBody < .38;
  const doji = last.bodyRatio < .12 && last.upperRatio > .28 && last.lowerRatio > .28;
  const force = last.bodyRatio >= ANALYST_THRESHOLDS.candleStrength / 100;
  const prevHigh = Math.max(...prev.slice(-4).map(x => x.high));
  const prevLow = Math.min(...prev.slice(-4).map(x => x.low));
  const averageRange = avg(rows.map(x => x.range));
  const priorAverageRange = Math.max(1e-12, avg(prev.slice(-5).map(x => x.range)) || averageRange);
  const currentRangeMultiple = last.range / priorAverageRange;
  const breakout = last.close > prevHigh ? 'BUY' : last.close < prevLow ? 'SELL' : null;
  const breakoutDistance = breakout === 'BUY'
    ? Math.max(0, last.close - prevHigh)
    : breakout === 'SELL'
      ? Math.max(0, prevLow - last.close)
      : 0;
  const breakoutDistanceRatio = breakoutDistance / priorAverageRange;
  const strongBreakout = !!breakout
    && breakoutDistanceRatio >= .18
    && last.bodyRatio >= .52
    && currentRangeMultiple <= 1.55;
  const overextendedImpulse = currentRangeMultiple >= 1.55 && last.bodyRatio >= .58;
  const exhaustionRisk = overextendedImpulse && !strongBreakout;
  const rejection = last.lowerRatio >= ANALYST_THRESHOLDS.rejectionStrength / 100 && last.close > last.open
    ? 'BUY'
    : last.upperRatio >= ANALYST_THRESHOLDS.rejectionStrength / 100 && last.close < last.open
      ? 'SELL'
      : null;
  const metrics = analystMetrics(rows);

  let buy = 0, sell = 0;
  const reasons = [];
  const trendPoints = agreement >= .7 ? 34 : agreement >= .6 ? 26 : 14;
  if (majority === 'BUY') { buy += trendPoints; reasons.push(`${up} de ${rows.length} velas favorecem alta`); }
  if (majority === 'SELL') { sell += trendPoints; reasons.push(`${down} de ${rows.length} velas favorecem baixa`); }
  if (force && last.direction === 'BUY') { buy += 24; reasons.push('Vela atual mostra força compradora'); }
  if (force && last.direction === 'SELL') { sell += 24; reasons.push('Vela atual mostra força vendedora'); }
  if (breakout === 'BUY') { buy += 28; reasons.push('Preço rompe a máxima recente'); }
  if (breakout === 'SELL') { sell += 28; reasons.push('Preço rompe a mínima recente'); }
  if (rejection === 'BUY') { buy += 28; reasons.push('Rejeição compradora confirmada na formação atual'); }
  if (rejection === 'SELL') { sell += 28; reasons.push('Rejeição vendedora confirmada na formação atual'); }

  const powerDiff = metrics.buyPower - metrics.sellPower;
  if (powerDiff >= 12) reasons.push(`Poder comprador ${Math.round(metrics.buyPower)}% domina o vendedor`);
  if (powerDiff <= -12) reasons.push(`Poder vendedor ${Math.round(metrics.sellPower)}% domina o comprador`);
  if (metrics.momentumDirection === 'BUY' && metrics.momentumScore >= 45) reasons.push('Momentum recente favorece alta');
  if (metrics.momentumDirection === 'SELL' && metrics.momentumScore >= 45) reasons.push('Momentum recente favorece baixa');

  let direction = buy === sell ? majority : buy > sell ? 'BUY' : 'SELL';
  let score = Math.max(buy, sell);
  if (agreement >= .6) score += 10;
  if (avgBody >= .48) score += 8;

  const continuationDirection = direction && last.direction === direction && metrics.momentumDirection === direction ? direction : null;
  const continuationScore = continuationDirection
    ? clamp(agreement * 45 + metrics.momentumScore * .3 + metrics.currentStrength * .25)
    : 0;
  if (continuationDirection && continuationScore >= 60) {
    reasons.push(`Continuação ${direction === 'BUY' ? 'compradora' : 'vendedora'} consistente`);
  }

  if (metrics.lossOfStrength >= 72 && !breakout && !rejection) {
    reasons.push('A vela atual perdeu força; confirmação exige continuidade');
  }
  if (overextendedImpulse) {
    reasons.push(`Vela atual esticada (${currentRangeMultiple.toFixed(1)}x a faixa média recente)`);
  }
  if (breakout && !strongBreakout) {
    reasons.push('Rompimento ainda sem margem suficiente para perseguir continuação');
  }
  const decisiveLocalSetup = !!rejection || strongBreakout || (continuationDirection && continuationScore >= 65 && !exhaustionRisk);
  if (lateral && !decisiveLocalSetup) { score = Math.min(score, 54); direction = null; reasons.push('Mercado lateral nas últimas velas'); }
  if (doji && !rejection) { score = Math.min(score, 48); direction = null; reasons.push('Doji sem confirmação'); }
  if (tiny >= Math.ceil(rows.length * .6) && agreement < .75 && !decisiveLocalSetup) { score = Math.min(score, 56); direction = null; reasons.push('Compressão: aguardando rompimento'); }
  if (lateral && decisiveLocalSetup) reasons.push('Mercado lateral, mas com gatilho local confirmado');
  // Do not turn the last oversized impulse into an automatic next-candle
  // continuation. It may be exhaustion/mean reversion, especially in range.
  if (exhaustionRisk && continuationDirection === direction && !rejection) {
    score = Math.min(score, ANALYST_THRESHOLDS.confirmScore - 1);
    reasons.push('Anti-chase: impulso esticado não confirma continuação da próxima vela');
  }
  score = clamp(score);

  const opinion = !direction
    ? (reasons[reasons.length - 1] || 'Sem direção clara no padrão atual.')
    : reasons[0] || `Movimento recente favorece ${direction}.`;

  return {
    ready: true,
    required: ANALYST_THRESHOLDS.minimumPatternRows,
    count: rows.length,
    direction,
    score,
    opinion,
    breakout,
    lateral,
    doji,
    rejection,
    aligned,
    agreement,
    up,
    down,
    force,
    continuationDirection,
    continuationScore,
    metrics,
    breakoutHigh: prevHigh,
    breakoutLow: prevLow,
    support,
    resistance,
    averageRange,
    priorAverageRange,
    currentRangeMultiple,
    breakoutDistance,
    breakoutDistanceRatio,
    strongBreakout,
    overextendedImpulse,
    exhaustionRisk,
    lastClose: last.close,
    reasons
  };
}

export function analyzeCandles(candles = [], indicatorCandles = candles) {
  const rows = (Array.isArray(candles) ? candles : []).filter(c => [c?.open, c?.high, c?.low, c?.close].every(v => finite(v) != null));
  const indicatorRows = (Array.isArray(indicatorCandles) ? indicatorCandles : []).filter(c => finite(c?.close) != null);
  const recent = recentPriceAction(rows);
  const levelAnalytics = {
    breakoutHigh: recent.breakoutHigh ?? null,
    breakoutLow: recent.breakoutLow ?? null,
    support: recent.support ?? null,
    resistance: recent.resistance ?? null,
    trendDirection: recent.direction || null
  };
  if (!recent.ready) {
    return {
      state: 'WAIT',
      score: 0,
      baseScore: 0,
      direction: null,
      reasons: [recent.opinion],
      recent,
      indicators: indicatorReinforcement(indicatorRows, null),
      analytics: { ...(recent.metrics || {}), ...levelAnalytics },
      waitingFor: waitingFor(recent, null, 0)
    };
  }
  if (!recent.direction) {
    return {
      state: 'NO_TRADE',
      score: recent.score,
      baseScore: recent.score,
      direction: null,
      reasons: recent.reasons,
      recent,
      indicators: indicatorReinforcement(indicatorRows, null),
      analytics: { ...(recent.metrics || {}), ...levelAnalytics },
      waitingFor: waitingFor(recent, null, recent.score)
    };
  }

  const indicators = indicatorReinforcement(indicatorRows, recent.direction);
  const score = clamp(recent.score + indicators.adjustment);
  return {
    state: score >= ANALYST_THRESHOLDS.possibleScore ? 'WATCH' : 'WAIT',
    score,
    baseScore: recent.score,
    direction: recent.direction,
    reasons: [...recent.reasons, ...indicators.reasons],
    recent,
    indicators,
    waitingFor: waitingFor(recent, recent.direction, score),
    analytics: {
      ...(recent.metrics || {}),
      ...levelAnalytics,
      continuationDirection: recent.continuationDirection || null,
      continuationScore: Number(recent.continuationScore || 0),
      breakoutDirection: recent.breakout || null,
      breakoutDistanceRatio: Number(recent.breakoutDistanceRatio || 0),
      currentRangeMultiple: Number(recent.currentRangeMultiple || 0),
      strongBreakout: recent.strongBreakout === true,
      overextendedImpulse: recent.overextendedImpulse === true,
      exhaustionRisk: recent.exhaustionRisk === true,
      rsi: indicators.rsi?.value ?? null,
      macdHistogram: indicators.macd?.histogram ?? null
    }
  };
}
