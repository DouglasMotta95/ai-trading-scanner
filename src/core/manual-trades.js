const clean = value => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
const num = value => value == null || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null;

export function marketId(value = '') {
  const raw = clean(value).toUpperCase();
  if (!raw) return '';
  const otc = /(?:\(|\b|[_-])OTC(?:\)|\b)?/i.test(raw);
  const pair = raw.match(/\b([A-Z0-9]{2,20})\s*[\/_-]\s*([A-Z0-9]{2,12})/i);
  return pair ? `${pair[1]}/${pair[2]}${otc ? ' (OTC)' : ''}` : raw;
}

export const sameMarket = (a, b) => !!marketId(a) && marketId(a) === marketId(b);

export function timeframeMs(value = 'M1') {
  const tf = clean(value).toUpperCase();
  let match = tf.match(/^S(\d+)$/); if (match) return Math.max(1, Number(match[1])) * 1000;
  match = tf.match(/^M(\d+)$/); if (match) return Math.max(1, Number(match[1])) * 60_000;
  match = tf.match(/^H(\d+)$/); if (match) return Math.max(1, Number(match[1])) * 3_600_000;
  return 60_000;
}

function normalizeCandleTime(value) {
  let time = num(value);
  if (time != null && time > 0 && time < 1e12) time *= 1000;
  return time;
}

function directionOfSignal(signal = {}) {
  const direct = clean(signal.direction || signal.analysisDirection).toUpperCase();
  if (['BUY','SELL'].includes(direct)) return direct;
  const ui = clean(signal.uiState).toUpperCase();
  if (ui.includes('BUY')) return 'BUY';
  if (ui.includes('SELL')) return 'SELL';
  return null;
}

function pickSignalMatch(state = {}, direction, clickedAt) {
  const signal = state.signal || {};
  const currentDirection = directionOfSignal(signal);
  const currentTarget = num(signal.targetStart);
  const currentConfirmed = ['ENTER_BUY','ENTER_SELL'].includes(clean(signal.uiState).toUpperCase()) || clean(signal.state).toUpperCase() === 'CONFIRM';
  if (currentConfirmed && currentDirection === direction && currentTarget != null) {
    return { matched: true, source: 'current_signal', targetStart: currentTarget, score: num(signal.analysisScore ?? signal.score), setup: signal.setup || state.decisionCycle?.setup || null };
  }

  const last = state.lastConfirmed || {};
  const lastDirection = clean(last.direction).toUpperCase();
  const lastTarget = num(last.targetStart ?? last.time);
  if (lastDirection === direction && lastTarget != null && Math.abs(clickedAt - lastTarget) <= 20_000) {
    return { matched: true, source: 'last_confirmed', targetStart: lastTarget, score: num(last.score), setup: last.setup || state.decisionCycle?.setup || null };
  }

  const cycle = state.decisionCycle || {};
  const cycleDirection = clean(cycle.direction).toUpperCase();
  const cycleTarget = num(cycle.targetStart);
  if (clean(cycle.locked).toUpperCase() === 'ENTER' && cycleDirection === direction && cycleTarget != null && Math.abs(clickedAt - cycleTarget) <= 20_000) {
    return { matched: true, source: 'decision_cycle', targetStart: cycleTarget, score: num(cycle.score), setup: cycle.setup || null };
  }
  return { matched: false, source: 'manual_only', targetStart: null, score: null, setup: null };
}

export function createManualTrade(state = {}, click = {}, now = Date.now(), id = '') {
  const direction = clean(click.direction).toUpperCase();
  if (!['BUY','SELL'].includes(direction)) return null;
  const asset = marketId(state.asset || state.diagnostics?.focusedAsset?.asset || '');
  const timeframe = clean(state.analysisTimeframe || state.timeframe || '').toUpperCase();
  const entryPrice = num(state.price);
  if (!asset || !timeframe) return null;

  const clickedAt = num(click.clickedAt) ?? now;
  const tfMs = timeframeMs(timeframe);
  const match = pickSignalMatch(state, direction, clickedAt);
  const derivedBucket = Math.floor(clickedAt / tfMs) * tfMs;
  const targetStart = Math.round((match.targetStart ?? derivedBucket) / tfMs) * tfMs;
  const timingDeltaMs = clickedAt - targetStart;
  const timingAligned = match.matched && timingDeltaMs >= -2500 && timingDeltaMs <= 10_000;
  const matchedSignal = match.matched && timingAligned;

  return {
    id: id || `${Math.round(clickedAt)}-${direction}-${asset.replace(/[^A-Z0-9]/g,'')}`,
    asset, timeframe, direction, clickedAt,
    entryPrice, entrySource: entryPrice == null ? 'unavailable' : 'canonical_quote_at_click',
    targetStart, targetEnd: targetStart + tfMs,
    expiration: state.targetExpiration || state.expiration || timeframe,
    matchedSignal, matchSource: match.source, timingAligned, timingDeltaMs,
    signalScore: match.score, setup: match.setup,
    signalUiState: state.signal?.uiState || null,
    buttonLabel: clean(click.label).slice(0, 100),
    frameHost: clean(click.frameHost).slice(0, 120),
    status: entryPrice == null ? 'UNVERIFIED_ENTRY' : 'PENDING',
    result: null, exitPrice: null, exitAt: null, resultSource: null,
    createdAt: now, resolvedAt: null
  };
}

export function mergeManualTrade(rows = [], trade = null, limit = 500) {
  const list = Array.isArray(rows) ? rows.slice() : [];
  if (!trade?.id) return list.slice(-limit);
  const index = list.findIndex(row => row?.id === trade.id);
  if (index >= 0) list[index] = { ...list[index], ...trade };
  else list.push(trade);
  return list.sort((a,b) => Number(a.clickedAt || 0) - Number(b.clickedAt || 0)).slice(-limit);
}

function resolveWithCandles(row, candles = [], now = Date.now()) {
  if (!row || row.status !== 'PENDING' || row.result || num(row.entryPrice) == null || num(row.targetStart) == null) return row;
  const tfMs = timeframeMs(row.timeframe);
  const targetBucket = Math.round(Number(row.targetStart) / tfMs) * tfMs;
  const candle = (Array.isArray(candles) ? candles : []).find(item => {
    const time = normalizeCandleTime(item?.time ?? item?.timestamp);
    return time != null && Math.floor(time / tfMs) * tfMs === targetBucket;
  });
  if (!candle) return row;
  const exitPrice = num(candle.close);
  if (exitPrice == null) return row;
  const entryPrice = Number(row.entryPrice);
  const result = exitPrice === entryPrice ? 'DRAW'
    : row.direction === 'BUY' ? (exitPrice > entryPrice ? 'WIN' : 'LOSS')
      : (exitPrice < entryPrice ? 'WIN' : 'LOSS');
  return {
    ...row, status: 'RESOLVED', result, exitPrice,
    exitAt: targetBucket + tfMs, resolvedAt: now,
    resultSource: 'target_candle_close'
  };
}

export function resolveManualTrades(rows = [], state = {}, now = Date.now()) {
  const candles = Array.isArray(state.candles) ? state.candles : [];
  const stateAsset = marketId(state.asset || '');
  const stateTf = clean(state.analysisTimeframe || state.timeframe || '').toUpperCase();
  const resolved = [];
  const next = (Array.isArray(rows) ? rows : []).map(row => {
    if (!row || !sameMarket(row.asset, stateAsset) || clean(row.timeframe).toUpperCase() !== stateTf) return row;
    const out = resolveWithCandles(row, candles, now);
    if (out !== row && out.result) resolved.push(out);
    return out;
  });
  return { rows: next, resolved };
}

export function resolveManualTradesFromFeed(rows = [], payload = {}, now = Date.now()) {
  const recent = payload?.recentCandles && typeof payload.recentCandles === 'object' ? payload.recentCandles : {};
  const resolved = [];
  const next = (Array.isArray(rows) ? rows : []).map(row => {
    if (!row || row.status !== 'PENDING' || row.result) return row;
    const key = Object.keys(recent).find(asset => sameMarket(asset, row.asset));
    if (!key) return row;
    const out = resolveWithCandles(row, recent[key], now);
    if (out !== row && out.result) resolved.push(out);
    return out;
  });
  return { rows: next, resolved };
}

export function manualTradeMetrics(rows = []) {
  const list = Array.isArray(rows) ? rows : [];
  const resolved = list.filter(row => row?.status === 'RESOLVED' && ['WIN','LOSS','DRAW'].includes(row.result));
  const scanner = resolved.filter(row => row.matchedSignal === true);
  const wins = scanner.filter(row => row.result === 'WIN').length;
  const losses = scanner.filter(row => row.result === 'LOSS').length;
  const draws = scanner.filter(row => row.result === 'DRAW').length;
  const directional = wins + losses;
  return {
    totalClicks: list.length,
    pending: list.filter(row => row?.status === 'PENDING').length,
    resolved: resolved.length,
    matchedSignals: scanner.length,
    wins, losses, draws,
    winRate: directional ? Math.round((wins / directional) * 1000) / 10 : null,
    unmatched: list.filter(row => row && row.matchedSignal !== true).length,
    last: list.at(-1) || null
  };
}
