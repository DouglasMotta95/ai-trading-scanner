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

const THRESHOLD_PROFILES = Object.freeze({
  RIGIDO: Object.freeze({
    profile: 'RIGIDO',
    label: 'MAIS SELETIVO',
    minimumClosedCandles: 2,
    preferredClosedCandles: 3,
    minimumPatternRows: 3,
    possibleScore: 44,
    confirmScore: 58,
    finalScore: 58,
    candleStrength: 62,
    rejectionStrength: 50,
    entryWindowSeconds: 10,
    holdSeconds: 3
  }),
  MEDIO: Object.freeze({
    profile: 'MEDIO',
    label: 'EQUILIBRADO',
    minimumClosedCandles: 2,
    preferredClosedCandles: 3,
    minimumPatternRows: 3,
    possibleScore: 40,
    confirmScore: 52,
    finalScore: 52,
    candleStrength: 55,
    rejectionStrength: 45,
    entryWindowSeconds: 12,
    holdSeconds: 2
  }),
  SOLTO: Object.freeze({
    profile: 'SOLTO',
    label: 'MAIS SINAIS',
    minimumClosedCandles: 2,
    preferredClosedCandles: 3,
    minimumPatternRows: 3,
    possibleScore: 36,
    confirmScore: 48,
    finalScore: 48,
    candleStrength: 50,
    rejectionStrength: 40,
    entryWindowSeconds: 15,
    holdSeconds: 1
  })
});

const SIGNAL_POLICIES = Object.freeze({
  RIGIDO: Object.freeze({
    possibleScore: 58,
    finalScore: 62,
    possiblePower: 45,
    finalPower: 45,
    minimumConfluence: 2,
    minimumStructure: 13,
    minimumLocation: 10,
    minimumTrigger: 10
  }),
  MEDIO: Object.freeze({
    possibleScore: 52,
    finalScore: 55,
    possiblePower: 45,
    finalPower: 45,
    minimumConfluence: 2,
    minimumStructure: 10,
    minimumLocation: 7,
    minimumTrigger: 8
  }),
  SOLTO: Object.freeze({
    possibleScore: 45,
    finalScore: 50,
    possiblePower: 45,
    finalPower: 45,
    minimumConfluence: 2,
    minimumStructure: 8,
    minimumLocation: 7,
    minimumTrigger: 8
  })
});

export function getThresholds(profile = 'MEDIO') {
  const raw = String(profile ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toUpperCase();
  return THRESHOLD_PROFILES[raw] || THRESHOLD_PROFILES.MEDIO;
}

export function getSignalPolicy(profile = 'MEDIO') {
  const thresholds = getThresholds(profile);
  const policy = SIGNAL_POLICIES[thresholds.profile] || SIGNAL_POLICIES.MEDIO;
  return Object.freeze({
    profile: thresholds.profile,
    label: thresholds.label,
    possibleScore: policy.possibleScore,
    finalScore: policy.finalScore,
    holdSeconds: thresholds.holdSeconds,
    ...policy
  });
}

export function getOperationMode(value = 'M1') {
  const raw = String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toUpperCase();
  const isM5 = raw === 'M5' || raw === '5M' || raw.includes('M5 +') || raw.includes('5 MIN');
  return isM5
    ? Object.freeze({ timeframe: 'M5', expiration: '300s', durationSeconds: 300 })
    : Object.freeze({ timeframe: 'M1', expiration: '60s', durationSeconds: 60 });
}

// Compatibility export for older tests/imports. Runtime signal sensitivity uses
// getThresholds(profile); RIGIDO remains the exact historical threshold set.
export const ANALYST_THRESHOLDS = THRESHOLD_PROFILES.RIGIDO;

const formatLevel = value => {
  const n = finite(value);
  if (n == null) return '—';
  const abs = Math.abs(n);
  const digits = abs >= 1000 ? 2 : abs >= 100 ? 3 : abs >= 1 ? 5 : 8;
  return n.toFixed(digits).replace(/0+$/, '').replace(/\.$/, '');
};

export function waitingFor(recent = {}, direction = null, score = 0, profile = 'MEDIO') {
  const thresholds = getThresholds(profile);
  if (!recent?.ready) {
    return {
      type: 'history', direction: null, label: 'Histórico recente', level: null,
      current: Number(recent?.count || 0), required: thresholds.minimumPatternRows,
      text: 'Aguardando histórico recente suficiente para formar o padrão.'
    };
  }

  const metrics = recent.metrics || {};
  const chosenDirection = ['BUY', 'SELL'].includes(direction) ? direction : null;
  const lastClose = finite(recent.lastClose);
  const avgRange = Math.max(1e-12, finite(recent.averageRange) || Math.abs(Number(recent.resistance || 0) - Number(recent.support || 0)) || 1);
  const profilePolicy = getSignalPolicy(thresholds.profile);
  if (chosenDirection) {
    const directionalPower = Number(chosenDirection === 'BUY' ? metrics.buyPower : metrics.sellPower) || 0;
    if (Number(score) >= profilePolicy.possibleScore && directionalPower >= 45) {
      const side = chosenDirection === 'BUY' ? 'COMPRA' : 'VENDA';
      const finalReady = Number(score) >= profilePolicy.finalScore;
      return {
        type: 'profile_candidate', direction: chosenDirection, label: 'Critério do perfil',
        level: null, current: Number(score) || 0, required: profilePolicy.finalScore,
        text: finalReady
          ? 'Aguardando janela final e relógio válido — critério final do perfil ' + thresholds.profile + ' atingido para ' + side + '.'
          : 'POSSÍVEL ' + side + ' liberado pelo perfil ' + thresholds.profile + ' (score ' + Math.round(Number(score) || 0) + ', poder ' + Math.round(directionalPower) + '%); decisão final exige score ' + profilePolicy.finalScore + '/100 na janela final.'
      };
    }
  }
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

  const pullbackPattern = recent.pullbackContinuation || null;
  if (pullbackPattern?.observed && !pullbackPattern.qualified && pullbackPattern.reason) {
    const roomGap = pullbackPattern.roomToLevel == null ? 0.2 : Math.max(0, 0.35 - Number(pullbackPattern.roomToLevel)) / 0.35;
    const stretchGap = pullbackPattern.notStretched ? 0 : Math.max(0.1, Number(pullbackPattern.stretchRatio || 1) - 1);
    add({
      type: 'pullback_continuation',
      direction: pullbackPattern.direction,
      label: 'Pullback + continuação',
      level: null,
      current: Number(pullbackPattern.score || 0),
      required: 80,
      gap: 0.03 + Math.min(1, Math.max(roomGap * 0.45, stretchGap * 0.35)),
      text: pullbackPattern.reason
    });
  }

  if (chosenDirection) {
    const buy = chosenDirection === 'BUY';
    const rejectionNow = Number(buy ? metrics.rejectionBuy : metrics.rejectionSell) || 0;
    if (recent.rejection !== chosenDirection) add({
      type: 'rejection', direction: chosenDirection,
      label: `Rejeição ${buy ? 'compradora' : 'vendedora'}`, level: null,
      current: rejectionNow, required: thresholds.rejectionStrength,
      gap: Math.max(0, thresholds.rejectionStrength - rejectionNow) / thresholds.rejectionStrength,
      text: `Aguardando confirmação de rejeição ${buy ? 'compradora' : 'vendedora'} (${Math.round(rejectionNow)}%/${thresholds.rejectionStrength}%).`
    });

    const power = Number(buy ? metrics.buyPower : metrics.sellPower) || 0;
    if (power < 45) add({
      type: 'power', direction: chosenDirection,
      label: `Poder ${buy ? 'comprador' : 'vendedor'}`, level: null,
      current: power, required: 45, gap: (45 - power) / 45,
      text: `Aguardando poder ${buy ? 'comprador' : 'vendedor'} atingir 45% (agora ${Math.round(power)}%).`
    });

    const strength = Number(metrics.currentStrength || 0);
    if (strength < thresholds.candleStrength) add({
      type: 'candle_strength', direction: chosenDirection,
      label: 'Força da vela atual', level: null,
      current: strength, required: thresholds.candleStrength,
      gap: Math.max(0, thresholds.candleStrength - strength) / thresholds.candleStrength,
      text: `Aguardando força da vela atingir ${thresholds.candleStrength}% (agora ${Math.round(strength)}%).`
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

  const targetScore = Number(score) < profilePolicy.possibleScore
    ? profilePolicy.possibleScore
    : Number(score) < profilePolicy.finalScore
      ? profilePolicy.finalScore
      : null;
  if (targetScore != null) add({
    type: targetScore === thresholds.possibleScore ? 'possible_score' : 'confirm_score',
    direction: chosenDirection, label: 'Força do padrão', level: null,
    current: Number(score) || 0, required: targetScore,
    gap: Math.max(0, targetScore - Number(score || 0)) / targetScore,
    text: 'Aguardando limiar do perfil ' + thresholds.profile + ' atingir ' + targetScore + '/100 (agora ' + Math.round(Number(score) || 0) + '/100).'
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

function analystMetrics(rows = [], profile = 'MEDIO') {
  const thresholds = getThresholds(profile);
  const window = rows.slice(-5);
  const last = window[window.length - 1] || null;
  const previous = window.slice(0, -1);
  const buyPower = clamp(avg(window.map(row => row.buyPressure)));
  const sellPower = clamp(avg(window.map(row => row.sellPressure)));
  const momentumValue = momentum(window);
  const currentStrength = clamp(last?.strength || 0);
  const rejectionBuy = clamp((last?.lowerRatio || 0) * 100);
  const rejectionSell = clamp((last?.upperRatio || 0) * 100);
  const rejectionDirection = rejectionBuy >= thresholds.rejectionStrength && last?.close > last?.open
    ? 'BUY'
    : rejectionSell >= thresholds.rejectionStrength && last?.close < last?.open
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


/**
 * Detect a non-extended pullback continuation before scoring it as a trade candidate.
 * The pattern requires an impulse, a shallow/opposite pullback with a higher low/high,
 * a directional resumption, and measurable room to the nearest opposing swing level.
 * It is evidence for a candidate only; normal clock/expiration/confluence gates still apply.
 */
export function detectPullbackContinuation(inputRows = []) {
  const empty = {
    observed: false, qualified: false, direction: null, score: 0,
    higherStructure: false, notStretched: false, roomToLevel: null,
    stretchRatio: null, reason: null
  };
  const rows = (Array.isArray(inputRows) ? inputRows : [])
    .map(row => row && Number.isFinite(Number(row.bodyRatio)) && Number.isFinite(Number(row.range)) ? row : shape(row))
    .filter(Boolean)
    .slice(-6);
  if (rows.length < 5) return empty;

  const current = rows[rows.length - 1];
  if (!['BUY', 'SELL'].includes(current.direction)) return empty;
  const baselineRange = Math.max(1e-12, avg(rows.slice(0, -1).map(row => row.range)));
  const prior = rows.slice(0, -1);
  const nearbyHigh = Math.max(...prior.map(row => row.high));
  const nearbyLow = Math.min(...prior.map(row => row.low));
  const candidates = [];

  // A pullback can be the immediately preceding candle or one candle earlier
  // when the first resumption candle has already printed.
  for (const index of [rows.length - 2, rows.length - 3]) {
    if (index < 2) continue;
    const pullback = rows[index];
    const impulse = rows[index - 1];
    const anchor = rows[Math.max(0, index - 3)];
    const direction = current.direction;
    const buy = direction === 'BUY';
    const trendMove = buy ? impulse.close - anchor.close : anchor.close - impulse.close;
    const trendReady = impulse.direction === direction && trendMove >= baselineRange * .15;
    const pullbackAgainst = pullback.direction === (buy ? 'SELL' : 'BUY') || pullback.bodyRatio <= .40;
    const rebound = buy
      ? current.close > pullback.close && current.close >= current.low + current.range * .55
      : current.close < pullback.close && current.close <= current.low + current.range * .45;
    const higherReferenceRows = rows.slice(0, index);
    if (!higherReferenceRows.length) continue;
    const referenceExtreme = buy
      ? Math.min(...higherReferenceRows.map(row => row.low))
      : Math.max(...higherReferenceRows.map(row => row.high));
    const higherStructure = buy
      ? pullback.low >= referenceExtreme - baselineRange * .08
      : pullback.high <= referenceExtreme + baselineRange * .08;
    const stretchRatio = Math.max(
      current.range / baselineRange,
      current.body / baselineRange,
      Math.abs(current.close - anchor.close) / (baselineRange * 2.6)
    );
    const notStretched = current.range <= baselineRange * 1.45
      && current.body <= baselineRange * .90
      && Math.abs(current.close - anchor.close) <= baselineRange * 2.6
      && current.bodyRatio >= .14;
    const roomToLevel = buy
      ? (nearbyHigh - current.close) / baselineRange
      : (current.close - nearbyLow) / baselineRange;
    const roomReady = roomToLevel >= .35;
    const observed = trendReady && pullbackAgainst && rebound;
    if (!observed) continue;

    const score = Math.round(
      (trendReady ? 20 : 0)
      + (pullbackAgainst ? 20 : 0)
      + (higherStructure ? 20 : 0)
      + (rebound ? 20 : 0)
      + (notStretched ? 10 : 0)
      + (roomReady ? 10 : 0)
    );
    const qualified = higherStructure && notStretched && roomReady && score >= 80;
    const side = buy ? 'compradora' : 'vendedora';
    let reason;
    if (!higherStructure) {
      reason = `Pullback ${side} identificado, mas o fundo/topo não confirmou uma estrutura mais favorável.`;
    } else if (!notStretched) {
      reason = `Pullback ${side} identificado, mas o candle ou o deslocamento já está esticado (${(current.range / baselineRange).toFixed(1)}× a faixa média); aguardar novo recuo.`;
    } else if (!roomReady) {
      reason = roomToLevel <= 0
        ? `Retomada ${side} encostou/rompeu a máxima/mínima recente; precisa de confirmação do rompimento, não perseguir o preço.`
        : `Padrão de continuação ${side} em formação, mas há apenas ${roomToLevel.toFixed(1)}× a faixa média até o nível contrário; aguardar mais espaço ou um recuo.`;
    } else if (!qualified) {
      reason = `Padrão de continuação ${side} em formação; aguardando estabilidade do candle de retomada.`;
    } else {
      reason = `Pullback ${side} qualificado: estrutura mais alta/baixa, retomada sem esticamento e ${roomToLevel.toFixed(1)}× a faixa média de espaço até o nível contrário.`;
    }
    candidates.push({
      observed: true, qualified, direction, score, higherStructure,
      notStretched, roomToLevel, stretchRatio, reason
    });
  }

  if (!candidates.length) return empty;
  candidates.sort((a, b) => Number(b.qualified) - Number(a.qualified) || b.score - a.score);
  return candidates[0];
}

export function recentPriceAction(candles = [], profile = 'MEDIO') {
  const thresholds = getThresholds(profile);
  const rows = (Array.isArray(candles) ? candles : []).map(shape).filter(Boolean).slice(-10);
  if (rows.length < thresholds.minimumPatternRows) {
    return {
      ready: false,
      required: thresholds.minimumPatternRows,
      count: rows.length,
      direction: null,
      score: 0,
      opinion: 'Montando padrão com as velas recentes e a vela atual.',
      breakout: null,
      lateral: false,
      doji: false,
      rejection: null,
      aligned: 0,
      metrics: analystMetrics(rows, profile),
      breakoutHigh: null,
      breakoutLow: null,
      support: null,
      resistance: null,
      averageRange: null,
      lastClose: rows[rows.length - 1]?.close ?? null,
      pullbackContinuation: null
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
  const force = last.bodyRatio >= thresholds.candleStrength / 100;
  const prevHigh = Math.max(...prev.slice(-4).map(x => x.high));
  const prevLow = Math.min(...prev.slice(-4).map(x => x.low));
  const averageRange = avg(rows.map(x => x.range));
  const breakout = last.close > prevHigh ? 'BUY' : last.close < prevLow ? 'SELL' : null;
  const rejection = last.lowerRatio >= thresholds.rejectionStrength / 100 && last.close > last.open
    ? 'BUY'
    : last.upperRatio >= thresholds.rejectionStrength / 100 && last.close < last.open
      ? 'SELL'
      : null;
  const metrics = analystMetrics(rows, profile);
  const pullbackContinuation = detectPullbackContinuation(rows);

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

  if (pullbackContinuation.qualified) {
    if (pullbackContinuation.direction === 'BUY') buy += 18;
    if (pullbackContinuation.direction === 'SELL') sell += 18;
    reasons.push(pullbackContinuation.reason);
  } else if (pullbackContinuation.observed && pullbackContinuation.reason) {
    reasons.push(pullbackContinuation.reason);
  }

  const powerDiff = metrics.buyPower - metrics.sellPower;
  if (powerDiff >= 12) reasons.push(`Poder comprador ${Math.round(metrics.buyPower)}% domina o vendedor`);
  if (powerDiff <= -12) reasons.push(`Poder vendedor ${Math.round(metrics.sellPower)}% domina o comprador`);
  if (metrics.momentumDirection === 'BUY' && metrics.momentumScore >= 45) reasons.push('Momentum recente favorece alta');
  if (metrics.momentumDirection === 'SELL' && metrics.momentumScore >= 45) reasons.push('Momentum recente favorece baixa');

  const candidateContinuationScore = clamp(agreement * 45 + metrics.momentumScore * .3 + metrics.currentStrength * .25);
  let direction = buy === sell ? majority : buy > sell ? 'BUY' : 'SELL';
  // A local trigger is stronger than a weak lateral/doji label. Preserve its
  // direction when the aggregate scores tie or the trend majority is absent.
  if (!direction && breakout) direction = breakout;
  if (!direction && rejection) direction = rejection;
  if (!direction && pullbackContinuation.qualified) direction = pullbackContinuation.direction;
  if (!direction && metrics.momentumDirection && metrics.momentumDirection === last.direction && candidateContinuationScore >= 60) {
    direction = metrics.momentumDirection;
  }
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
  const decisiveLocalSetup = !!breakout || !!rejection || (continuationDirection && continuationScore >= 60)
    || (pullbackContinuation.qualified && pullbackContinuation.direction === direction)
    || (!!direction && direction === last.direction && metrics.momentumDirection === direction && candidateContinuationScore >= 60);
  if (lateral && !decisiveLocalSetup) { score = Math.min(score, 54); direction = null; reasons.push('Mercado lateral nas últimas velas'); }
  if (doji && !decisiveLocalSetup) { score = Math.min(score, 48); direction = null; reasons.push('Doji sem confirmação'); }
  if (tiny >= Math.ceil(rows.length * .6) && agreement < .75 && !decisiveLocalSetup) { score = Math.min(score, 56); direction = null; reasons.push('Compressão: aguardando rompimento'); }
  if (lateral && decisiveLocalSetup) reasons.push('Mercado lateral, mas com gatilho local confirmado');
  score = clamp(score);

  const opinion = !direction
    ? (reasons[reasons.length - 1] || 'Sem direção clara no padrão atual.')
    : reasons[0] || `Movimento recente favorece ${direction}.`;

  return {
    ready: true,
    required: thresholds.minimumPatternRows,
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
    lastClose: last.close,
    pullbackContinuation,
    reasons
  };
}


function professionalContextScore(recent = {}, indicators = {}, thresholds = getThresholds()) {
  const policy = getSignalPolicy(thresholds.profile);
  const direction = ['BUY', 'SELL'].includes(recent?.direction) ? recent.direction : null;
  const metrics = recent?.metrics || {};
  if (!direction) {
    return {
      score: clamp(Number(recent?.score || 0)),
      legacyScore: clamp(Number(recent?.score || 0)),
      direction: null,
      contextReady: false,
      positionReady: false,
      triggerReady: false,
      blocks: { structure: 0, location: 0, trigger: 0, momentum: 0, indicators: 0, quality: 0 },
      reasons: ['Contexto profissional ainda sem direção definida.']
    };
  }

  const buy = direction === 'BUY';
  const agreement = Number(recent.agreement || 0);
  const momentumScore = Number(metrics.momentumScore || 0);
  const continuationScore = Number(recent.continuationScore || 0);
  const directionalPower = Number(buy ? metrics.buyPower : metrics.sellPower) || 0;
  const avgRange = Math.max(1e-12, Number(recent.averageRange || 0) || 1);
  const lastClose = Number(recent.lastClose);
  const keyLevel = buy ? Number(recent.support) : Number(recent.resistance);
  const distanceToLevel = Number.isFinite(lastClose) && Number.isFinite(keyLevel)
    ? Math.abs(lastClose - keyLevel) / avgRange
    : Infinity;

  const breakout = recent.breakout === direction;
  const rejection = recent.rejection === direction
    && Number(metrics.rejectionStrength || 0) >= thresholds.rejectionStrength;
  const continuation = recent.continuationDirection === direction && continuationScore >= 60;
  const pullbackContinuation = recent.pullbackContinuation?.qualified === true && recent.pullbackContinuation?.direction === direction;
  const momentumAligned = metrics.momentumDirection === direction && momentumScore >= 45;
  const nearKeyLevel = distanceToLevel <= 0.75;
  const strongCandle = Number(metrics.currentStrength || 0) >= thresholds.candleStrength;

  let structure = 0;
  if (agreement >= .7) structure += 12;
  else if (agreement >= .6) structure += 9;
  else if (agreement >= .55) structure += 6;
  if (momentumAligned) structure += momentumScore >= 70 ? 8 : momentumScore >= 55 ? 6 : 4;
  if (continuation) structure += 5;
  if (pullbackContinuation) structure += 5;
  structure = clamp(structure, 0, 25);

  let location = 0;
  if (nearKeyLevel) location += distanceToLevel <= .4 ? 10 : 7;
  if (breakout) location += 10;
  if (rejection) location += 8;
  if (pullbackContinuation) location += 8;
  location = clamp(location, 0, 20);

  let trigger = 0;
  if (breakout) trigger += 10;
  if (rejection) trigger += 10;
  if (continuation) trigger += 8;
  if (pullbackContinuation) trigger += 8;
  if (strongCandle) trigger += 5;
  trigger = clamp(trigger, 0, 25);

  let momentum = 0;
  if (directionalPower >= 65) momentum += 7;
  else if (directionalPower >= 58) momentum += 5;
  else if (directionalPower >= 52) momentum += 3;
  if (momentumAligned) momentum += momentumScore >= 65 ? 5 : 3;
  if (continuation) momentum += 3;
  if (pullbackContinuation) momentum += 2;
  momentum = clamp(momentum, 0, 15);

  let indicatorScore = 0;
  const rsiValue = Number(indicators?.rsi?.value);
  const macdHistogram = Number(indicators?.macd?.histogram);
  const rsiAligned = Number.isFinite(rsiValue) && (buy ? rsiValue > 50 : rsiValue < 50);
  const macdAligned = Number.isFinite(macdHistogram) && macdHistogram !== 0 && (buy ? macdHistogram > 0 : macdHistogram < 0);
  if (rsiAligned) indicatorScore += 4;
  if (macdAligned) indicatorScore += 6;
  indicatorScore = clamp(indicatorScore, 0, 10);

  let quality = 0;
  if (!recent.lateral) quality += 2;
  if (!recent.doji) quality += 1;
  if (Number(metrics.lossOfStrength || 0) < 55) quality += 2;
  if (pullbackContinuation && recent.pullbackContinuation?.notStretched) quality += 1;
  quality = clamp(quality, 0, 5);

  const positionReady = (breakout || rejection || nearKeyLevel || pullbackContinuation) && location >= policy.minimumLocation;
  const triggerReady = (breakout || rejection || continuation || pullbackContinuation) && trigger >= policy.minimumTrigger;
  const contextReady = structure >= policy.minimumStructure && positionReady;
  const score = clamp(structure + location + trigger + momentum + indicatorScore + quality);
  const reasons = [
    `Estrutura ${Math.round(structure)}/25`,
    `Região ${Math.round(location)}/20`,
    `Gatilho ${Math.round(trigger)}/25`,
    `Momentum ${Math.round(momentum)}/15`,
    `Indicadores ${Math.round(indicatorScore)}/10`,
    `Qualidade ${Math.round(quality)}/5`
  ];

  return {
    score,
    legacyScore: clamp(Number(recent.score || 0) + Number(indicators?.adjustment || 0)),
    direction,
    contextReady,
    positionReady,
    triggerReady,
    breakout,
    rejection,
    continuation,
    pullbackContinuation,
    pullbackPatternScore: Number(recent.pullbackContinuation?.score || 0),
    momentumAligned,
    nearKeyLevel,
    distanceToLevel: Number.isFinite(distanceToLevel) ? distanceToLevel : null,
    directionalPower,
    profilePolicy: policy,
    blocks: {
      structure,
      location,
      trigger,
      momentum,
      indicators: indicatorScore,
      quality
    },
    reasons
  };
}

export function analyzeCandles(candles = [], indicatorCandles = candles, profile = 'MEDIO') {
  const thresholds = getThresholds(profile);
  const rows = (Array.isArray(candles) ? candles : []).filter(c => [c?.open, c?.high, c?.low, c?.close].every(v => finite(v) != null));
  const indicatorRows = (Array.isArray(indicatorCandles) ? indicatorCandles : []).filter(c => finite(c?.close) != null);
  const recent = recentPriceAction(rows, thresholds.profile);
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
      waitingFor: waitingFor(recent, null, 0, thresholds.profile)
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
      waitingFor: waitingFor(recent, null, recent.score, thresholds.profile)
    };
  }

  const indicators = indicatorReinforcement(indicatorRows, recent.direction);
  const professional = professionalContextScore(recent, indicators, thresholds);
  const score = professional.score;
  const candidateReady = professional.contextReady && professional.triggerReady;
  const professionalReason = candidateReady
    ? `Leitura profissional: contexto + região + gatilho confirmados (${Math.round(score)}/100).`
    : `AGUARDAR — leitura profissional incompleta: ${!professional.contextReady ? 'contexto/região' : 'gatilho'} ainda não confirmado.`;
  return {
    state: candidateReady && score >= thresholds.possibleScore ? 'WATCH' : 'WAIT',
    score,
    baseScore: recent.score,
    direction: recent.direction,
    reasons: [...recent.reasons, ...indicators.reasons, professionalReason],
    recent,
    indicators,
    waitingFor: waitingFor(recent, recent.direction, score, thresholds.profile),
    analytics: {
      ...(recent.metrics || {}),
      ...levelAnalytics,
      pullbackContinuation: recent.pullbackContinuation || null,
      continuationDirection: recent.continuationDirection || null,
      continuationScore: Number(recent.continuationScore || 0),
      rsi: indicators.rsi?.value ?? null,
      macdHistogram: indicators.macd?.histogram ?? null,
      legacyScore: professional.legacyScore,
      professional
    }
  };
}
