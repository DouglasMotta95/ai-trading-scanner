export const minute = 60_000;

export function bullishAPlusRows(bucket, count = 40) {
  const rows = [];
  const step = .001;
  let price = 1.0;

  for (let i = count - 1; i >= 1; i -= 1) {
    const open = price;
    const close = open + step * .4;
    const high = close + step * .3;
    const low = open - step * .2;
    rows.push({ time: bucket - i * minute, open, high, low, close, timeframe: 'M1' });
    price = close;
  }

  const previousHigh = rows.at(-1).high;
  const open = price;
  const close = open + step * .05;
  const high = Math.min(previousHigh - step * .05, Math.max(open, close) + step * .05);
  const low = Math.min(open, close) - step * .5;
  rows.push({ time: bucket, open, high, low, close, timeframe: 'M1' });
  return rows;
}

export function weakCurrentFrom(rows, bucket) {
  const base = rows.slice(0, -1);
  const previous = base.at(-1);
  const open = previous.close;
  return [
    ...base,
    {
      time: bucket,
      open,
      high: open + .00008,
      low: open - .00008,
      close: open + .00001,
      timeframe: 'M1'
    }
  ];
}

export function snapshotFor(bucket, elapsed, {
  rows = bullishAPlusRows(bucket),
  asset = 'EUR/USD (OTC)',
  price = rows.at(-1).close,
  secondsRemaining,
  extra = {}
} = {}) {
  return {
    platformId: 'casatrade',
    asset,
    price,
    timeframe: 'M1',
    analysisTimeframe: 'M1',
    connection: 'online',
    serverTime: bucket + elapsed,
    ...(secondsRemaining == null ? {} : { secondsRemaining }),
    candles: rows,
    ...extra
  };
}
