import { atr } from './indicators.js';

export const A_PLUS_WEIGHTS = Object.freeze({
  structure: 25,
  supportResistance: 20,
  priceAction: 20,
  momentum: 10,
  breakout: 10,
  volatility: 10,
  stability: 5
});

export const A_PLUS_PROFILES = Object.freeze({
  M1: Object.freeze({
    operatingTimeframe: 'M1',
    contextTimeframe: 'M5',
    operatingMs: 60_000,
    contextMs: 300_000,
    requiredExpiration: '60s',
    minimumOperatingBars: 20,
    minimumContextBars: 6,
    possibleScore: 62,
    enterScore: 78,
    preferredStableMs: 5000
  }),
  M5: Object.freeze({
    operatingTimeframe: 'M5',
    contextTimeframe: 'M15',
    operatingMs: 300_000,
    contextMs: 900_000,
    requiredExpiration: '300s',
    minimumOperatingBars: 20,
    minimumContextBars: 6,
    possibleScore: 64,
    enterScore: 80,
    preferredStableMs: 7000
  })
});

export const A_PLUS_THRESHOLDS = Object.freeze({
  possibleScore: 62,
  enterScore: 78,
  opposingLevelAtr: .35,
  breakoutMarginAtr: .18,
  maxImpulseRangeMultiple: 1.75,
  minStableMs: 3000,
  preferredStableMs: 5000,
  adaptiveMinSamples: 20,
  adaptiveMinWinRate: .52
});

const num = value => value == null || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null;
const clamp = (value, min = 0, max = 100) => Math.max(min, Math.min(max, Number(value) || 0));
const avg = rows => rows.length ? rows.reduce((sum, value) => sum + Number(value || 0), 0) / rows.length : 0;
const clean = value => String(value ?? '').trim();

export function profileForTimeframe(value = 'M1') {
  const tf = clean(value).toUpperCase();
  return A_PLUS_PROFILES[tf] || A_PLUS_PROFILES.M1;
}

function normalizeTime(value) {
  let n = num(value);
  if (n != null && n > 0 && n < 1e12) n *= 1000;
  return Number.isFinite(n) ? n : null;
}

function rowsOf(candles = []) {
  return (Array.isArray(candles) ? candles : [])
    .map(row => ({
      time: normalizeTime(row?.time ?? row?.timestamp),
      open: num(row?.open),
      high: num(row?.high),
      low: num(row?.low),
      close: num(row?.close),
      timeframe: clean(row?.timeframe).toUpperCase()
    }))
    .filter(row => row.time != null && [row.open,row.high,row.low,row.close].every(Number.isFinite))
    .sort((a,b) => a.time - b.time);
}

function median(values = []) {
  const rows = values.filter(Number.isFinite).sort((a,b) => a-b);
  if (!rows.length) return 0;
  const mid = Math.floor(rows.length / 2);
  return rows.length % 2 ? rows[mid] : (rows[mid - 1] + rows[mid]) / 2;
}

function inferredInterval(rows = []) {
  const diffs = [];
  for (let i = 1; i < rows.length; i += 1) {
    const diff = rows[i].time - rows[i - 1].time;
    if (diff > 0 && diff <= 3_600_000) diffs.push(diff);
  }
  return median(diffs.slice(-40));
}

function aggregate(candles = [], bucketMs = 300000) {
  const buckets = new Map();
  for (const row of candles) {
    const bucket = Math.floor(row.time / bucketMs) * bucketMs;
    const current = buckets.get(bucket);
    if (!current) {
      buckets.set(bucket, {
        time: bucket,
        open: row.open,
        high: row.high,
        low: row.low,
        close: row.close,
        samples: 1
      });
    } else {
      current.high = Math.max(current.high, row.high);
      current.low = Math.min(current.low, row.low);
      current.close = row.close;
      current.samples += 1;
    }
  }
  return [...buckets.values()].sort((a,b) => a.time - b.time);
}

function operationalBars(allRows = [], profile = A_PLUS_PROFILES.M1) {
  const explicit = allRows.filter(row => row.timeframe === profile.operatingTimeframe);
  if (explicit.length >= profile.minimumOperatingBars) return explicit.map(row => ({ ...row, samples: 1 }));

  const interval = inferredInterval(allRows);
  if (interval >= profile.operatingMs * .8 && interval <= profile.operatingMs * 1.2) {
    return allRows.map(row => ({ ...row, samples: 1 }));
  }

  if (interval > 0 && interval < profile.operatingMs * .8) {
    const expectedSamples = Math.max(1, Math.round(profile.operatingMs / interval));
    return aggregate(allRows, profile.operatingMs).filter(row => row.samples >= Math.max(1, expectedSamples - 1));
  }

  return aggregate(allRows, profile.operatingMs);
}

function contextBars(operating = [], profile = A_PLUS_PROFILES.M1) {
  const expectedSamples = Math.max(2, Math.round(profile.contextMs / profile.operatingMs));
  return aggregate(operating, profile.contextMs).filter(row => row.samples >= expectedSamples);
}

function directionalStructure(rows = [], lookback = 8) {
  const sample = rows.slice(-Math.max(6, lookback));
  if (sample.length < 6) return {
    direction: null,
    confidence: 0,
    higherHigh: false,
    higherLow: false,
    lowerHigh: false,
    lowerLow: false
  };
  const split = Math.floor(sample.length / 2);
  const older = sample.slice(0, split);
  const newer = sample.slice(split);
  const oldHigh = Math.max(...older.map(row => row.high));
  const oldLow = Math.min(...older.map(row => row.low));
  const newHigh = Math.max(...newer.map(row => row.high));
  const newLow = Math.min(...newer.map(row => row.low));
  const higherHigh = newHigh > oldHigh;
  const higherLow = newLow > oldLow;
  const lowerHigh = newHigh < oldHigh;
  const lowerLow = newLow < oldLow;
  const closeDelta = newer.at(-1).close - older[0].close;
  const range = Math.max(1e-12, Math.max(...sample.map(row=>row.high)) - Math.min(...sample.map(row=>row.low)));
  const displacement = Math.min(1, Math.abs(closeDelta) / range);
  let direction = null;
  let confidence = 0;
  if (higherHigh && higherLow) { direction = 'BUY'; confidence = 70 + displacement * 30; }
  else if (lowerHigh && lowerLow) { direction = 'SELL'; confidence = 70 + displacement * 30; }
  else if (displacement >= .35) { direction = closeDelta > 0 ? 'BUY' : 'SELL'; confidence = 45 + displacement * 30; }
  return { direction, confidence: clamp(confidence), higherHigh, higherLow, lowerHigh, lowerLow };
}

function pivots(rows = [], radius = 2) {
  const highs = [], lows = [];
  for (let i = radius; i < rows.length - radius; i += 1) {
    const row = rows[i];
    const neighbors = rows.slice(i-radius, i+radius+1).filter((_,j)=>j!==radius);
    if (neighbors.every(other => row.high >= other.high)) highs.push(row.high);
    if (neighbors.every(other => row.low <= other.low)) lows.push(row.low);
  }
  return { highs, lows };
}

function nearestLevels(rows = [], price, atrValue) {
  const sample = rows.slice(-30);
  const { highs, lows } = pivots(sample, 2);
  const safeAtr = Math.max(1e-12, Number(atrValue) || median(sample.map(row=>Math.abs(row.high-row.low))) || 1);
  const resistanceCandidates = highs.filter(level => level > price).sort((a,b)=>a-b);
  const supportCandidates = lows.filter(level => level < price).sort((a,b)=>b-a);
  const resistance = resistanceCandidates[0] ?? null;
  const support = supportCandidates[0] ?? null;
  return {
    support,
    resistance,
    supportDistanceAtr: Number.isFinite(support) ? (price - support) / safeAtr : Infinity,
    resistanceDistanceAtr: Number.isFinite(resistance) ? (resistance - price) / safeAtr : Infinity
  };
}

function volatilityContext(rows = [], currentRangeMultiple = 0) {
  const recent = rows.slice(-20);
  if (recent.length < 12) return { quality: 0, ratio: null, dead: false, explosive: false };
  const ranges = recent.map(row => Math.abs(row.high-row.low));
  const fast = avg(ranges.slice(-5));
  const slow = Math.max(1e-12, avg(ranges.slice(-15,-5)) || median(ranges));
  const ratio = fast / slow;
  const dead = ratio < .48;
  const explosive = ratio > 1.9 || Number(currentRangeMultiple || 0) > 1.75;
  const quality = dead || explosive ? 0 : ratio >= .65 && ratio <= 1.55 ? 10 : 5;
  return { quality, ratio, dead, explosive };
}

function historyStats(journal = [], signal = {}, direction = null, operatingTimeframe = 'M1') {
  const setup = clean(signal?.setup).toLowerCase();
  const regime = clean(signal?.regime?.type).toLowerCase();
  const tf = clean(operatingTimeframe).toUpperCase();
  const rows = (Array.isArray(journal) ? journal : []).filter(row =>
    row?.resolved === true
    && row?.direction === direction
    && (!row?.timeframe || clean(row.timeframe).toUpperCase() === tf)
    && (!setup || clean(row?.setup).toLowerCase() === setup)
    && (!regime || clean(row?.regime).toLowerCase() === regime)
  );
  if (!rows.length) return { samples: 0, wins: 0, losses: 0, draws: 0, winRate: null };
  const wins = rows.filter(row => row.outcome === 'WIN').length;
  const losses = rows.filter(row => row.outcome === 'LOSS').length;
  const draws = rows.filter(row => row.outcome === 'DRAW').length;
  const decided = wins + losses;
  return { samples: rows.length, wins, losses, draws, winRate: decided ? wins / decided : null };
}

export function assessHighConfidence({
  candles = [],
  currentCandle = null,
  signal = {},
  direction = null,
  cycle = {},
  journal = [],
  operatingTimeframe = 'M1',
  now = Date.now()
} = {}) {
  const profile = profileForTimeframe(operatingTimeframe);
  const dir = ['BUY','SELL'].includes(direction) ? direction : null;
  const allRows = rowsOf(candles);
  const currentTime = normalizeTime(currentCandle?.time ?? currentCandle?.timestamp);
  const currentBucket = currentTime == null ? null : Math.floor(currentTime / profile.operatingMs) * profile.operatingMs;
  const opAll = operationalBars(allRows, profile);
  const operating = currentBucket == null
    ? opAll.slice(0,-1)
    : opAll.filter(row => Math.floor(row.time / profile.operatingMs) * profile.operatingMs < currentBucket);
  const context = contextBars(operating, profile);
  const analytics = signal.analytics || {};
  const regime = clean(signal.regime?.type).toLowerCase() || 'unknown';
  const lastPrice = num(currentCandle?.close) ?? opAll.at(-1)?.close ?? null;
  const atrValue = atr(operating.slice(-40), 14);
  const structureOperating = directionalStructure(operating, 10);
  const structureContext = directionalStructure(context, 6);
  const levels = lastPrice == null ? null : nearestLevels(operating, lastPrice, atrValue);
  const volatility = volatilityContext(operating, analytics.currentRangeMultiple);
  const hardVetoes = [];
  const warnings = [];
  const factors = {
    structure: 0,
    supportResistance: 0,
    priceAction: 0,
    momentum: 0,
    breakout: 0,
    volatility: 0,
    stability: 0
  };

  if (!dir) hardVetoes.push('sem-direção');
  if (operating.length < profile.minimumOperatingBars) hardVetoes.push('histórico-operacional-insuficiente');
  if (context.length < profile.minimumContextBars) hardVetoes.push('histórico-contexto-insuficiente');

  if (dir) {
    const opAligned = structureOperating.direction === dir;
    const contextAligned = structureContext.direction === dir;
    const opOpposite = structureOperating.direction && structureOperating.direction !== dir;
    const contextOpposite = structureContext.direction && structureContext.direction !== dir;

    if (opAligned && contextAligned) factors.structure = 25;
    else if (contextAligned && !opOpposite) factors.structure = 20;
    else if (opAligned && !structureContext.direction) factors.structure = 10;
    else if (!opOpposite && !contextOpposite) factors.structure = 5;

    if (contextOpposite) hardVetoes.push('contexto-contra-direção');
    if (opOpposite && contextOpposite) hardVetoes.push('estrutura-operacional-contexto-contra');

    const rejectionDirection = clean(analytics.rejectionDirection).toUpperCase();
    const rejectionStrength = Number(analytics.rejectionStrength || 0);
    if (rejectionDirection === dir && rejectionStrength >= 55) factors.priceAction = 20;
    else if (rejectionDirection === dir && rejectionStrength >= 40) factors.priceAction = 13;
    else if (Number(analytics.currentStrength || 0) >= 65 && !analytics.exhaustionRisk) factors.priceAction = 8;

    const momentumAligned = clean(analytics.momentumDirection).toUpperCase() === dir;
    const momentumScore = Number(analytics.momentumScore || 0);
    const macd = Number(analytics.macdHistogram);
    const macdAligned = Number.isFinite(macd) && (dir === 'BUY' ? macd > 0 : macd < 0);
    if (momentumAligned && momentumScore >= 55 && macdAligned) factors.momentum = 10;
    else if (momentumAligned && momentumScore >= 45) factors.momentum = 7;
    else if (macdAligned) factors.momentum = 3;

    const breakoutAligned = clean(analytics.breakoutDirection).toUpperCase() === dir;
    const strongBreakout = analytics.strongBreakout === true && breakoutAligned;
    const breakoutMargin = Number(analytics.breakoutDistanceRatio || 0);
    if (strongBreakout && breakoutMargin >= A_PLUS_THRESHOLDS.breakoutMarginAtr) factors.breakout = 10;
    else if (breakoutAligned) {
      warnings.push('rompimento-fraco');
      hardVetoes.push('breakout-sem-confirmação');
    }

    if (analytics.exhaustionRisk === true || analytics.overextendedImpulse === true
        || Number(analytics.currentRangeMultiple || 0) > A_PLUS_THRESHOLDS.maxImpulseRangeMultiple) {
      hardVetoes.push('vela-estendida-exaustão');
    }

    if (levels) {
      const nearSupport = levels.supportDistanceAtr <= A_PLUS_THRESHOLDS.opposingLevelAtr;
      const nearResistance = levels.resistanceDistanceAtr <= A_PLUS_THRESHOLDS.opposingLevelAtr;
      if (dir === 'BUY') {
        if (nearResistance && !strongBreakout) hardVetoes.push('compra-direto-na-resistência');
        if (nearSupport && rejectionDirection === 'BUY') factors.supportResistance = 20;
        else if (!nearResistance) factors.supportResistance = 12;
        else if (strongBreakout) factors.supportResistance = 16;
      } else {
        if (nearSupport && !strongBreakout) hardVetoes.push('venda-direto-no-suporte');
        if (nearResistance && rejectionDirection === 'SELL') factors.supportResistance = 20;
        else if (!nearSupport) factors.supportResistance = 12;
        else if (strongBreakout) factors.supportResistance = 16;
      }
      const atRangeEdge = dir === 'BUY' ? nearSupport : nearResistance;
      if (regime === 'range' && !atRangeEdge && !strongBreakout) hardVetoes.push('range-no-meio-sem-borda');
    }

    if (volatility.dead) hardVetoes.push('volatilidade-morta');
    if (volatility.explosive) hardVetoes.push('volatilidade-explosiva');
    factors.volatility = volatility.quality;

    const stableFor = Math.max(0, now - Number(cycle?.possibleSince || now));
    const recentlyChanged = cycle?.directionTransition?.at
      && now - Number(cycle.directionTransition.at) < profile.preferredStableMs;
    if (recentlyChanged) {
      hardVetoes.push('direção-trocou-recentemente');
      factors.stability = 0;
    } else if (stableFor >= profile.preferredStableMs) factors.stability = 5;
    else if (stableFor >= A_PLUS_THRESHOLDS.minStableMs) factors.stability = 3;

    const historical = historyStats(journal, signal, dir, profile.operatingTimeframe);
    if (historical.samples >= A_PLUS_THRESHOLDS.adaptiveMinSamples
        && historical.winRate != null
        && historical.winRate < A_PLUS_THRESHOLDS.adaptiveMinWinRate) {
      hardVetoes.push('setup-histórico-fraco');
    }

    const score = Object.values(factors).reduce((sum,value)=>sum+Number(value||0),0);
    const uniqueVetoes = [...new Set(hardVetoes)];
    const candidateAllowed = uniqueVetoes.length === 0 && score >= profile.possibleScore;
    const finalAllowed = uniqueVetoes.length === 0 && score >= profile.enterScore;
    return {
      mode: 'A_PLUS',
      operatingTimeframe: profile.operatingTimeframe,
      contextTimeframe: profile.contextTimeframe,
      requiredExpiration: profile.requiredExpiration,
      score: clamp(score),
      candidateAllowed,
      finalAllowed,
      hardVetoes: uniqueVetoes,
      warnings: [...new Set(warnings)],
      factors,
      structure: { operating: structureOperating, context: structureContext },
      levels,
      volatility,
      historical,
      data: { operatingBars: operating.length, contextBars: context.length, atr: atrValue },
      thresholds: { ...A_PLUS_THRESHOLDS, possibleScore: profile.possibleScore, enterScore: profile.enterScore },
      weights: { ...A_PLUS_WEIGHTS }
    };
  }

  return {
    mode: 'A_PLUS',
    operatingTimeframe: profile.operatingTimeframe,
    contextTimeframe: profile.contextTimeframe,
    requiredExpiration: profile.requiredExpiration,
    score: 0,
    candidateAllowed: false,
    finalAllowed: false,
    hardVetoes: [...new Set(hardVetoes)],
    warnings,
    factors,
    structure: { operating: structureOperating, context: structureContext },
    levels,
    volatility,
    historical: { samples: 0, wins: 0, losses: 0, draws: 0, winRate: null },
    data: { operatingBars: operating.length, contextBars: context.length, atr: atrValue },
    thresholds: { ...A_PLUS_THRESHOLDS, possibleScore: profile.possibleScore, enterScore: profile.enterScore },
    weights: { ...A_PLUS_WEIGHTS }
  };
}
