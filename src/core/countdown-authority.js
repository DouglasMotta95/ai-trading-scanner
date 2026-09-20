(() => {
  if (globalThis.__ATS_COUNTDOWN_AUTHORITY__) return;

  const EXACT_SOURCES = new Set(['trader-dom-countdown', 'network-server-cycle']);
  const CLOCK_FRESH_MS = 8000;
  const clean = value => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();

  function normalizeMarket(value = '') {
    const raw = clean(value).toUpperCase();
    if (!raw) return '';
    const otc = /(?:\(|\b|[_-])OTC(?:\)|\b)?/i.test(raw);
    const pair = raw.match(/\b([A-Z0-9]{2,20})\s*[\/_-]\s*([A-Z0-9]{2,12})/i);
    return pair ? `${pair[1]}/${pair[2]}${otc ? ' (OTC)' : ''}` : raw;
  }

  function sameMarket(a, b) {
    const left = normalizeMarket(a);
    return !!left && left === normalizeMarket(b);
  }

  function normalizeTimeframe(value = '') {
    const raw = clean(value).toUpperCase().replace(/\s+/g, '');
    let match = raw.match(/^S(\d{1,5})$/);
    if (match && Number(match[1]) > 0) return `S${Number(match[1])}`;
    match = raw.match(/^M(\d{1,4})$/);
    if (match && Number(match[1]) > 0) return `M${Number(match[1])}`;
    match = raw.match(/^H(\d{1,3})$/);
    if (match && Number(match[1]) > 0) return `H${Number(match[1])}`;
    return null;
  }

  function durationSeconds(value = '') {
    const timeframe = normalizeTimeframe(value);
    if (!timeframe) return null;
    const amount = Number(timeframe.slice(1));
    if (timeframe[0] === 'S') return amount;
    if (timeframe[0] === 'M') return amount * 60;
    if (timeframe[0] === 'H') return amount * 3600;
    return null;
  }

  function readAuthoritativeCountdown(state = {}, now = Date.now()) {
    const clock = state?.diagnostics?.marketClock || null;
    const focus = state?.diagnostics?.focusedAsset || null;
    const stateAsset = normalizeMarket(state?.asset || '');
    const timeframe = normalizeTimeframe(clock?.timeframe || state?.analysisTimeframe || state?.timeframe || '');
    const duration = durationSeconds(timeframe);
    const seconds = Number(clock?.secondsRemaining);
    const at = Number(clock?.at || 0);

    const ready = !!clock
      && !!focus?.asset
      && !!stateAsset
      && focus.reliable === true
      && focus.chartScoped === true
      && focus.trustedChartFrame === true
      && sameMarket(focus.asset, stateAsset)
      && sameMarket(clock.asset, stateAsset)
      && clock.available !== false
      && clock.verified === true
      && clean(clock.role) === 'candle-close'
      && EXACT_SOURCES.has(clean(clock.source))
      && Number.isFinite(seconds)
      && seconds >= 0
      && Number.isFinite(duration)
      && seconds <= duration + 2
      && at > 0
      && Number(now) - at >= 0
      && Number(now) - at < CLOCK_FRESH_MS;

    return ready
      ? { ready: true, secondsRemaining: seconds, timeframe, source: clean(clock.source) }
      : { ready: false, secondsRemaining: null, timeframe, source: null };
  }

  globalThis.__ATS_COUNTDOWN_AUTHORITY__ = Object.freeze({
    exactSources: Object.freeze([...EXACT_SOURCES]),
    readAuthoritativeCountdown
  });
})();
