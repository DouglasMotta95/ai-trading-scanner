const num = value => value == null || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null;

function candleTime(raw = {}) {
  let value = Number(raw?.time ?? raw?.timestamp);
  if (Number.isFinite(value) && value > 0 && value < 1e12) value *= 1000;
  return Number.isFinite(value) ? value : null;
}

function assetId(value = '') {
  const raw = String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toUpperCase();
  if (!raw) return '';
  const otc = /(?:\(|\b|[_-])OTC(?:\)|\b)?/i.test(raw);
  const stripped = raw.replace(/\(\s*OTC\s*\)|\bOTC\b/g, ' ').trim();
  const pair = stripped.match(/\b([A-Z0-9]{2,20})\s*[\/_-]\s*([A-Z0-9]{2,12})/i);
  if (!pair) return '';
  return `${pair[1]}/${pair[2]}${otc ? ' (OTC)' : ''}`;
}

function sameAsset(a, b) {
  const left = assetId(a);
  const right = assetId(b);
  return !!left && left === right;
}

function sameTimeframe(candle = {}, record = {}) {
  const candleTf = String(candle?.timeframe || '').trim().toUpperCase();
  const recordTf = String(record?.timeframe || '').trim().toUpperCase();
  return !candleTf || !recordTf || candleTf === recordTf;
}

function timeframeMs(value = 'M1') {
  const tf = String(value || 'M1').trim().toUpperCase();
  let match = tf.match(/^S(\d+)$/); if (match) return Math.max(1, Number(match[1])) * 1000;
  match = tf.match(/^M(\d+)$/); if (match) return Math.max(1, Number(match[1])) * 60_000;
  match = tf.match(/^H(\d+)$/); if (match) return Math.max(1, Number(match[1])) * 3_600_000;
  return 60_000;
}

function exactTargetCandle(record = {}, candles = []) {
  const targetStart = num(record.targetStart);
  if (targetStart == null) return null;
  return (Array.isArray(candles) ? candles : []).find(candle => {
    const time = candleTime(candle);
    return time === targetStart && sameTimeframe(candle, record);
  }) || null;
}

export function captureSignalEntry(record = {}, candles = []) {
  if (!record || record.result || record.status === 'resolved') return record;
  const target = exactTargetCandle(record, candles);
  const open = num(target?.open);
  if (open == null) return record;
  if (num(record.entryPrice) != null) return record;
  return {
    ...record,
    entryPrice: open,
    entryTime: num(record.targetStart),
    entryCapturedAt: Date.now(),
    entryStatus: 'confirmed'
  };
}

export function resolveSignalOutcome(record = {}, candles = [], options = {}) {
  if (!record || record.result || record.status === 'resolved') return null;
  if (!['BUY', 'SELL'].includes(String(record.direction || '').toUpperCase())) return null;
  const targetStart = num(record.targetStart);
  if (targetStart == null) return null;

  const target = exactTargetCandle(record, candles);
  if (!target) return null;

  const open = num(target.open);
  const close = num(target.close);
  if (open == null || close == null) return null;

  // In live mode, never grade an in-progress target candle. Tests/offline
  // callers can omit now and resolve from a known completed candle.
  const now = num(options.now);
  if (now != null && now < targetStart + timeframeMs(record.timeframe)) return null;

  const direction = String(record.direction).toUpperCase();
  const result = close === open
    ? 'DRAW'
    : direction === 'BUY'
      ? (close > open ? 'WIN' : 'LOSS')
      : (close < open ? 'WIN' : 'LOSS');

  return {
    ...record,
    entryPrice: open,
    entryTime: targetStart,
    entryStatus: 'confirmed',
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
  if (!asset || !candles.length) return { rows: Array.isArray(rows) ? rows : [], resolved: [], captured: [] };

  const resolved = [];
  const captured = [];
  const next = (Array.isArray(rows) ? rows : []).map(record => {
    if (!sameAsset(record?.asset, asset)) return record;
    const withEntry = captureSignalEntry(record, candles);
    if (withEntry !== record) captured.push(withEntry);
    const outcome = resolveSignalOutcome(withEntry, candles, { now: market.serverTime ?? market.now });
    if (!outcome) return withEntry;
    resolved.push(outcome);
    return outcome;
  });
  return { rows: next, resolved, captured };
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
