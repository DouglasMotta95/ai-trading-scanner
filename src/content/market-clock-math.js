(() => {
  if (globalThis.__ATS_MARKET_CLOCK_MATH__) return;

  const clean = value => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();

  function normalizeTimeframe(value = '') {
    const raw = clean(value).toUpperCase().replace(/\s+/g, '');
    let match = raw.match(/^S(\d{1,5})$/) || raw.match(/^(\d{1,5})(?:S|SEG|SEGUNDO|SEGUNDOS)$/);
    if (match && Number(match[1]) > 0) return `S${Number(match[1])}`;
    match = raw.match(/^M(\d{1,4})$/) || raw.match(/^(\d{1,4})(?:M|MIN|MINUTO|MINUTOS)$/);
    if (match && Number(match[1]) > 0) return `M${Number(match[1])}`;
    match = raw.match(/^H(\d{1,3})$/) || raw.match(/^(\d{1,3})H$/);
    if (match && Number(match[1]) > 0) return `H${Number(match[1])}`;
    return null;
  }

  function durationMsForTimeframe(value = '') {
    const timeframe = normalizeTimeframe(value);
    if (!timeframe) return null;
    const amount = Number(timeframe.slice(1));
    if (timeframe[0] === 'S') return amount * 1000;
    if (timeframe[0] === 'M') return amount * 60_000;
    if (timeframe[0] === 'H') return amount * 3_600_000;
    return null;
  }

  function selectCycleTimeframe({
    chartTimeframe = null,
    controlTimeframe = null,
    exactTimeframe = null,
    platformTimeframe = null,
    structuredTimeframe = null
  } = {}) {
    for (const candidate of [
      chartTimeframe,
      controlTimeframe,
      exactTimeframe,
      platformTimeframe,
      structuredTimeframe
    ]) {
      const normalized = normalizeTimeframe(candidate);
      if (normalized) return normalized;
    }
    return null;
  }

  function remainingSecondsFromOpen({ openAt, now, timeframe } = {}) {
    const durationMs = durationMsForTimeframe(timeframe);
    const open = Number(openAt);
    const current = Number(now);
    if (!durationMs || !Number.isFinite(open) || !Number.isFinite(current)) return null;
    const closeAt = open + durationMs;
    if (current < open || current > closeAt) return null;
    return Math.max(0, Math.min(durationMs / 1000, Math.ceil((closeAt - current) / 1000)));
  }

  globalThis.__ATS_MARKET_CLOCK_MATH__ = Object.freeze({
    normalizeTimeframe,
    durationMsForTimeframe,
    selectCycleTimeframe,
    remainingSecondsFromOpen
  });
})();
