const num = value => value == null || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null;

function candleTime(raw = {}) {
  let value = Number(raw?.time ?? raw?.timestamp);
  if (Number.isFinite(value) && value > 0 && value < 1e12) value *= 1000;
  return Number.isFinite(value) ? value : null;
}

function sameAsset(a, b) {
  const normalize = value => String(value || '')
    .toUpperCase()
    .replace(/\s*\(\s*OTC\s*\)\s*$/, '')
    .replace(/\s+/g, '')
    .trim();
  const left = normalize(a);
  const right = normalize(b);
  return !!left && !!right && left === right;
}

function sameTimeframe(candle = {}, record = {}) {
  const candleTf = String(candle?.timeframe || '').trim().toUpperCase();
  const recordTf = String(record?.timeframe || '').trim().toUpperCase();
  return !candleTf || !recordTf || candleTf === recordTf;
}

export function resolveSignalOutcome(record = {}, candles = []) {
  if (!record || record.result || record.status === 'resolved') return null;
  if (!['BUY', 'SELL'].includes(String(record.direction || '').toUpperCase())) return null;
  const targetStart = num(record.targetStart);
  if (targetStart == null) return null;

  const target = (Array.isArray(candles) ? candles : []).find(candle => {
    const time = candleTime(candle);
    return time === targetStart && sameTimeframe(candle, record);
  });
  if (!target) return null;

  const open = num(target.open);
  const close = num(target.close);
  if (open == null || close == null) return null;

  const direction = String(record.direction).toUpperCase();
  const result = close === open
    ? 'DRAW'
    : direction === 'BUY'
      ? (close > open ? 'WIN' : 'LOSS')
      : (close < open ? 'WIN' : 'LOSS');

  return {
    ...record,
    entryPrice: open,
    exitPrice: close,
    result,
    status: 'resolved',
    resolvedAt: Date.now(),
    outcomeBasis: 'target_candle_open_close'
  };
}

export function resolveSignalHistory(rows = [], market = {}) {
  const asset = market?.asset || null;
  const candles = Array.isArray(market?.candles) ? market.candles : [];
  if (!asset || !candles.length) return { rows: Array.isArray(rows) ? rows : [], resolved: [] };

  const resolved = [];
  const next = (Array.isArray(rows) ? rows : []).map(record => {
    if (!sameAsset(record?.asset, asset)) return record;
    const outcome = resolveSignalOutcome(record, candles);
    if (!outcome) return record;
    resolved.push(outcome);
    return outcome;
  });
  return { rows: next, resolved };
}

export function signalPerformance(rows = []) {
  const list = Array.isArray(rows) ? rows : [];
  const wins = list.filter(row => row?.result === 'WIN').length;
  const losses = list.filter(row => row?.result === 'LOSS').length;
  const draws = list.filter(row => row?.result === 'DRAW').length;
  const resolved = wins + losses + draws;
  const directionalResolved = wins + losses;
  return {
    signals: list.length,
    resolved,
    pending: Math.max(0, list.length - resolved),
    wins,
    losses,
    draws,
    observedWinRate: directionalResolved ? Math.round((wins / directionalResolved) * 1000) / 10 : null
  };
}
