(() => {
  if (globalThis.__ATS_OHLC_DISPLAY__) return;

  const num = value => value == null || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null;
  const complete = row => !!row && [row.open, row.high, row.low, row.close].every(value => num(value) != null);

  function normalizeTimeframe(value = '') {
    const raw = String(value ?? '').trim().toUpperCase().replace(/\s+/g, '');
    let match = raw.match(/^S(\d{1,5})$/);
    if (match && Number(match[1]) > 0) return `S${Number(match[1])}`;
    match = raw.match(/^M(\d{1,4})$/);
    if (match && Number(match[1]) > 0) return `M${Number(match[1])}`;
    match = raw.match(/^H(\d{1,3})$/);
    if (match && Number(match[1]) > 0) return `H${Number(match[1])}`;
    return null;
  }

  function durationMs(value = '') {
    const tf = normalizeTimeframe(value);
    if (!tf) return 0;
    const amount = Number(tf.slice(1));
    if (tf[0] === 'S') return amount * 1000;
    if (tf[0] === 'M') return amount * 60_000;
    if (tf[0] === 'H') return amount * 3_600_000;
    return 0;
  }

  function normalizeTime(value) {
    let time = num(value);
    if (time != null && time > 0 && time < 1e12) time *= 1000;
    return Number.isFinite(time) ? time : null;
  }

  function trustworthy(row) {
    return complete(row)
      && row.partial !== true
      && row.openReliable !== false
      && row.rangeReliable !== false;
  }

  function rowView(row, source = 'structured-casatrade') {
    return {
      open: num(row.open),
      high: num(row.high),
      low: num(row.low),
      close: num(row.close),
      approximate: false,
      source
    };
  }

  function selectDisplayOhlc(state = {}, now = Date.now()) {
    const direct = state.signal?.currentCandle || state.currentCandle || null;
    if (trustworthy(direct)) return rowView(direct, direct.source || 'casatrade');

    const tf = normalizeTimeframe(state.analysisTimeframe || state.timeframe);
    const span = durationMs(tf);
    const rows = (Array.isArray(state.candles) ? state.candles : [])
      .filter(trustworthy)
      .map(row => ({ row, time: normalizeTime(row.time ?? row.timestamp) }))
      .filter(item => item.time != null && span > 0
        && Number(now) >= item.time - 1500
        && Number(now) < item.time + span + 1500)
      .sort((a, b) => b.time - a.time);

    if (rows.length) return rowView(rows[0].row, 'structured-casatrade');

    const price = num(state.price);
    return {
      open: null,
      high: null,
      low: null,
      close: price,
      approximate: false,
      source: price == null ? 'unavailable' : 'live-price-only'
    };
  }

  globalThis.__ATS_OHLC_DISPLAY__ = Object.freeze({ selectDisplayOhlc });
})();
