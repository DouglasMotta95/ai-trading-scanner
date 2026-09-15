(() => {
  if (globalThis.__ATS_EMBEDDED_FEED_BRIDGE__) return;
  globalThis.__ATS_EMBEDDED_FEED_BRIDGE__ = true;

  const host = String(location.hostname || '').toLowerCase().replace(/\.$/, '');
  const trusted = host === 'casatraders.online' || host.endsWith('.casatraders.online') ||
    host === 'ivcasatraders.online' || host.endsWith('.ivcasatraders.online') ||
    host === 'casatrade.com' || host.endsWith('.casatrade.com') ||
    host === 'casatrade.io' || host.endsWith('.casatrade.io');
  if (!trusted) return;
  const sendMessage = globalThis.__ATS_SEND_MESSAGE__;
  if (typeof sendMessage !== 'function') return;

  const clean = value => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  const marketId = value => {
    const raw = clean(value).toUpperCase();
    if (!raw) return '';
    const otc = /(?:\(|\b|[_-])OTC(?:\)|\b)?/.test(raw);
    const direct = raw.match(/\b([A-Z0-9]{2,20})\s*[\/_-]\s*([A-Z0-9]{2,12})/);
    return direct ? `${direct[1]}/${direct[2]}${otc ? ' (OTC)' : ''}` : '';
  };
  const sameMarket = (a, b) => !!marketId(a) && marketId(a) === marketId(b);
  const normalizeTime = value => {
    let time = Number(value);
    if (!Number.isFinite(time)) return null;
    if (time > 0 && time < 1e11) time *= 1000;
    return time > 946684800000 ? time : null;
  };
  const normalizeTf = value => {
    const raw = clean(value).toUpperCase().replace(/\s+/g, '');
    let match = raw.match(/^S(\d{1,5})$/) || raw.match(/^(\d{1,5})S$/);
    if (match && Number(match[1]) > 0) return `S${Number(match[1])}`;
    match = raw.match(/^M(\d{1,4})$/) || raw.match(/^(\d{1,4})M$/);
    if (match && Number(match[1]) > 0) return `M${Number(match[1])}`;
    match = raw.match(/^H(\d{1,3})$/) || raw.match(/^(\d{1,3})H$/);
    return match && Number(match[1]) > 0 ? `H${Number(match[1])}` : null;
  };
  const durationSeconds = timeframe => {
    const tf = normalizeTf(timeframe);
    if (!tf) return null;
    if (tf[0] === 'S') return Number(tf.slice(1));
    if (tf[0] === 'M') return Number(tf.slice(1)) * 60;
    if (tf[0] === 'H') return Number(tf.slice(1)) * 3600;
    return null;
  };

  let lastSentAt = 0;
  let clockBusy = false;
  let clockProbe = null;
  let lastClockSentAt = 0;

  async function maybePublishStructuredClock(payload = {}) {
    if (clockBusy) return;
    clockBusy = true;
    try {
      const response = await sendMessage({ type: 'ATS_READ_SCANNER_STATE' });
      const state = response?.state || null;
      const focus = state?.diagnostics?.focusedAsset || null;
      if (!focus?.asset || focus.reliable !== true || focus.chartScoped !== true || focus.trustedChartFrame !== true) return;
      if (String(focus.frameHost || '').toLowerCase() !== host) return;

      const currentClock = state?.diagnostics?.marketClock || null;
      if (currentClock?.verified === true && currentClock?.source === 'trader-dom-countdown'
        && Date.now() - Number(currentClock.at || 0) < 2200) return;

      const rows = (Array.isArray(payload.candidates) ? payload.candidates : [])
        .filter(row => sameMarket(row?.asset, focus.asset))
        .sort((a, b) => Number(b?.selected === true) - Number(a?.selected === true)
          || Number(b?.confidence || 0) - Number(a?.confidence || 0)
          || Number(b?.observedAt || 0) - Number(a?.observedAt || 0));
      const candidate = rows[0] || null;
      const serverTime = normalizeTime(candidate?.timestamp);
      const timeframe = normalizeTf(candidate?.timeframe || state.analysisTimeframe || state.timeframe);
      const duration = durationSeconds(timeframe);
      const confidence = Number(candidate?.confidence || 0);
      const now = Date.now();
      if (!serverTime || !timeframe || !duration || confidence < 55 || Math.abs(now - serverTime) > 7000) {
        clockProbe = null;
        return;
      }

      const previous = clockProbe;
      const serverDelta = previous ? serverTime - Number(previous.serverTime || 0) : 0;
      const localDelta = previous ? now - Number(previous.observedAt || 0) : 0;
      const progressed = !!previous && sameMarket(previous.asset, focus.asset) && previous.timeframe === timeframe
        && serverDelta > 0 && serverDelta <= 5000
        && localDelta > 0 && localDelta <= 5000
        && Math.abs(serverDelta - localDelta) <= 1800;
      const count = progressed ? Math.min(8, Number(previous.count || 1) + 1) : 1;
      clockProbe = { asset: marketId(focus.asset), timeframe, serverTime, observedAt: now, count };
      if (count < 2 || now - lastClockSentAt < 300) return;

      const durationMs = duration * 1000;
      const elapsed = ((serverTime % durationMs) + durationMs) % durationMs;
      let secondsRemaining = Math.ceil((durationMs - elapsed) / 1000);
      if (!Number.isFinite(secondsRemaining) || secondsRemaining <= 0 || secondsRemaining > duration) secondsRemaining = duration;
      lastClockSentAt = now;
      await sendMessage({
        type: 'ATS_MARKET_CLOCK_V2', asset: focus.asset, timeframe, secondsRemaining,
        expiration: state.targetExpiration || state.expiration || candidate?.expiration || null,
        available: true, verified: true, clockRole: 'candle-close',
        clockSource: 'network-server-cycle', clockMode: 'structured-server-time',
        clockText: 'Tempo do servidor confirmado pelo feed estruturado', clockToken: `${secondsRemaining}s`,
        confidence: Math.min(99, Math.max(55, confidence)), frameHost: host, at: now
      });
    } finally {
      clockBusy = false;
    }
  }

  window.addEventListener('message', event => {
    const data = event.data;
    if (!data || data.source !== 'ATS_NETWORK_PROBE' || data.type !== 'summary') return;
    const now = Date.now();
    if (now - lastSentAt < 80) return;
    lastSentAt = now;
    const payload = data.payload || {};
    sendMessage({ type: 'ATS_EMBEDDED_FEED', payload }).catch(() => {});
    maybePublishStructuredClock(payload).catch(() => {});
  });
})();
