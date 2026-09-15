const num = value => value == null || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null;
const clean = value => String(value ?? '').trim();
const assetId = value => clean(value).toUpperCase().replace(/\s*\(\s*OTC\s*\)\s*$/i, '').replace(/\s+/g, '');
const sameAsset = (a, b) => !!assetId(a) && assetId(a) === assetId(b);

function candleTime(row = {}) {
  let time = num(row.time ?? row.timestamp);
  if (time != null && time > 0 && time < 1e12) time *= 1000;
  return time;
}

export function shadowRecordFromState(state = {}) {
  const cycle = state.decisionCycle || {};
  if (!['ENTER', 'SKIP'].includes(cycle.locked)) return null;
  const asset = clean(state.asset || state.diagnostics?.marketSession?.asset || '');
  const timeframe = clean(state.analysisTimeframe || state.timeframe || '').toUpperCase();
  const targetStart = num(cycle.targetStart);
  if (!asset || !timeframe || targetStart == null) return null;
  const signal = state.signal || {};
  const shadowDirection = ['BUY','SELL'].includes(cycle.direction) ? cycle.direction
    : ['BUY','SELL'].includes(signal.analysisDirection) ? signal.analysisDirection
      : ['BUY','SELL'].includes(cycle.candidateDirection) ? cycle.candidateDirection : null;
  return {
    key: `${assetId(asset)}|${timeframe}|${Math.round(targetStart)}`,
    asset, timeframe, targetStart: Math.round(targetStart),
    decision: cycle.locked, direction: cycle.direction || null, shadowDirection,
    score: Number(cycle.score ?? signal.analysisScore ?? signal.score ?? 0),
    setup: cycle.setup || signal.setup || null,
    reason: clean(cycle.reason || signal.reason || ''),
    createdAt: Number(cycle.decidedAt || Date.now()),
    result: null, resolvedAt: null, open: null, close: null
  };
}

export function mergeShadowRecord(rows = [], record = null, limit = 500) {
  const list = Array.isArray(rows) ? rows.slice() : [];
  if (!record?.key) return list.slice(-limit);
  const index = list.findIndex(row => row?.key === record.key);
  if (index >= 0) list[index] = { ...list[index], ...record, result: list[index].result || record.result || null, resolvedAt: list[index].resolvedAt || record.resolvedAt || null };
  else list.push(record);
  return list.sort((a, b) => Number(a.targetStart || 0) - Number(b.targetStart || 0)).slice(-limit);
}

export function resolveShadowRows(rows = [], state = {}) {
  const candles = Array.isArray(state.candles) ? state.candles : [];
  const asset = clean(state.asset || '');
  const timeframe = clean(state.analysisTimeframe || state.timeframe || '').toUpperCase();
  if (!asset || !timeframe || !candles.length) return { rows: Array.isArray(rows) ? rows : [], resolved: [] };
  const resolved = [];
  const next = (Array.isArray(rows) ? rows : []).map(row => {
    if (row?.result || !sameAsset(row?.asset, asset) || clean(row?.timeframe).toUpperCase() !== timeframe) return row;
    if (!['BUY','SELL'].includes(row?.shadowDirection)) return row;
    const candle = candles.find(item => {
      const time = candleTime(item);
      return time != null && Math.round(time) === Math.round(Number(row.targetStart));
    });
    if (!candle) return row;
    const open = num(candle.open), close = num(candle.close);
    if (open == null || close == null) return row;
    const result = close === open ? 'DRAW'
      : row.shadowDirection === 'BUY' ? (close > open ? 'WIN' : 'LOSS') : (close < open ? 'WIN' : 'LOSS');
    const out = { ...row, open, close, result, resolvedAt: Date.now() };
    resolved.push(out);
    return out;
  });
  return { rows: next, resolved };
}

export function shadowMetrics(rows = []) {
  const list = Array.isArray(rows) ? rows : [];
  const entries = list.filter(row => row.decision === 'ENTER' && ['WIN','LOSS'].includes(row.result));
  const skips = list.filter(row => row.decision === 'SKIP' && ['WIN','LOSS'].includes(row.result));
  const entryWins = entries.filter(row => row.result === 'WIN').length;
  const entryLosses = entries.filter(row => row.result === 'LOSS').length;
  const missedWins = skips.filter(row => row.result === 'WIN').length;
  const avoidedLosses = skips.filter(row => row.result === 'LOSS').length;
  return {
    total: list.length,
    resolved: list.filter(row => row.result).length,
    entries: entries.length,
    entryWins, entryLosses,
    entryWinRate: entries.length ? Math.round((entryWins / entries.length) * 1000) / 10 : null,
    skips: skips.length,
    skippedWouldWin: missedWins,
    skippedWouldLose: avoidedLosses,
    skipMissRate: skips.length ? Math.round((missedWins / skips.length) * 1000) / 10 : null
  };
}
