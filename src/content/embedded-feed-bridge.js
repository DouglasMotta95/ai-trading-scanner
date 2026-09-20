(() => {
  try { globalThis.__ATS_EMBEDDED_FEED_BRIDGE_RUNTIME__?.teardown?.(); } catch {}
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
  const normalizeExp = value => {
    const raw = clean(value).toLowerCase().replace(/\s+/g, '');
    if (!raw) return null;
    let match = raw.match(/^(\d{1,5})(?:s|seg|segundo|segundos)$/);
    if (match) return `${Number(match[1])}s`;
    match = raw.match(/^(\d{1,4})(?:m|min|minuto|minutos)$/);
    if (match) return `${Number(match[1]) * 60}s`;
    match = raw.match(/^(\d{1,2}):(\d{2})$/);
    if (match) return `${Number(match[1]) * 60 + Number(match[2])}s`;
    return null;
  };
  const durationSeconds = timeframe => {
    const tf = normalizeTf(timeframe);
    if (!tf) return null;
    if (tf[0] === 'S') return Number(tf.slice(1));
    if (tf[0] === 'M') return Number(tf.slice(1)) * 60;
    if (tf[0] === 'H') return Number(tf.slice(1)) * 3600;
    return null;
  };
  const validOhlc = row => [row?.open, row?.high, row?.low, row?.close].every(value => Number.isFinite(Number(value)));

  let lastSentAt = 0;
  let clockBusy = false;
  let clockProbe = null;
  let candleClockProbe = null;
  let lastClockSentAt = 0;

  function candleRowsFor(payload = {}, asset = '') {
    const recent = payload?.recentCandles && typeof payload.recentCandles === 'object' ? payload.recentCandles : {};
    const key = Object.keys(recent).find(value => sameMarket(value, asset));
    const rows = key && Array.isArray(recent[key]) ? recent[key] : [];
    return rows
      .filter(row => validOhlc(row) && normalizeTime(row?.time ?? row?.timestamp))
      .sort((a, b) => Number(normalizeTime(a?.time ?? a?.timestamp)) - Number(normalizeTime(b?.time ?? b?.timestamp)));
  }

  function structuredCandleBoundary(payload = {}, state = {}, focus = null, candidate = null) {
    if (!focus?.asset) return null;
    const rows = candleRowsFor(payload, focus.asset);
    const latest = rows.at(-1) || null;
    if (!latest) { candleClockProbe = null; return null; }

    const timeframe = normalizeTf(candidate?.timeframe || latest?.timeframe || state.analysisTimeframe || state.timeframe);
    const duration = durationSeconds(timeframe);
    const openAt = normalizeTime(latest?.time ?? latest?.timestamp);
    const now = Date.now();
    if (!timeframe || !duration || !openAt) { candleClockProbe = null; return null; }

    const durationMs = duration * 1000;
    // Only the candle that is demonstrably open right now may become a clock anchor.
    // A closed historical candle is rejected instead of being shifted forward by guesswork.
    if (openAt > now + 1500 || now < openAt - 1500 || now >= openAt + durationMs + 1200) {
      candleClockProbe = null;
      return null;
    }

    const previous = candleClockProbe;
    const sameAnchor = !!previous && sameMarket(previous.asset, focus.asset)
      && previous.timeframe === timeframe && Number(previous.openAt) === Number(openAt);
    const localDelta = sameAnchor ? now - Number(previous.observedAt || 0) : 0;
    const count = sameAnchor && localDelta > 80 && localDelta < 5000
      ? Math.min(8, Number(previous.count || 1) + 1)
      : 1;
    candleClockProbe = { asset: marketId(focus.asset), timeframe, openAt, observedAt: now, count };
    if (count < 2) return null;

    const remainingMs = openAt + durationMs - now;
    const secondsRemaining = Math.max(0, Math.min(duration, Math.ceil(remainingMs / 1000)));
    if (!Number.isFinite(secondsRemaining) || secondsRemaining < 0 || secondsRemaining > duration) return null;
    return { timeframe, secondsRemaining, openAt, count };
  }

  async function publishCandleBoundaryClock(payload = {}, state = {}, focus = null, candidate = null) {
    const boundary = structuredCandleBoundary(payload, state, focus, candidate);
    if (!boundary) return false;
    const now = Date.now();
    if (now - lastClockSentAt < 300) return true;
    lastClockSentAt = now;
    await sendMessage({
      type: 'ATS_MARKET_CLOCK_V2', asset: focus.asset, timeframe: boundary.timeframe,
      secondsRemaining: boundary.secondsRemaining,
      expiration: state.targetExpiration || state.expiration || candidate?.expiration || null,
      available: true, verified: true, clockRole: 'candle-close',
      clockSource: 'network-server-cycle', clockMode: 'structured-current-candle-boundary',
      clockText: 'Fechamento confirmado pela vela atual do feed estruturado', clockToken: `${boundary.secondsRemaining}s`,
      confidence: 94, frameHost: host, at: now
    });
    return true;
  }

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

      // Preferred path: a genuinely advancing near-real server timestamp.
      if (serverTime && timeframe && duration && confidence >= 55 && Math.abs(now - serverTime) <= 7000) {
        const previous = clockProbe;
        const serverDelta = previous ? serverTime - Number(previous.serverTime || 0) : 0;
        const localDelta = previous ? now - Number(previous.observedAt || 0) : 0;
        const progressed = !!previous && sameMarket(previous.asset, focus.asset) && previous.timeframe === timeframe
          && serverDelta > 0 && serverDelta <= 5000
          && localDelta > 0 && localDelta <= 5000
          && Math.abs(serverDelta - localDelta) <= 1800;
        const count = progressed ? Math.min(8, Number(previous.count || 1) + 1) : 1;
        clockProbe = { asset: marketId(focus.asset), timeframe, serverTime, observedAt: now, count };
        if (count >= 2 && now - lastClockSentAt >= 300) {
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
          return;
        }
      } else {
        clockProbe = null;
      }

      // CasaTrade often exposes a candle timestamp (open time), not a continuously advancing
      // server timestamp. When the newest OHLC row is the candle that is provably open now,
      // its start + timeframe is an exact candle-close boundary. Two live observations are
      // required before publishing it; historical rows are never rolled forward by modulo.
      await publishCandleBoundaryClock(payload, state, focus, candidate);
    } finally {
      clockBusy = false;
    }
  }

  const networkMessageHandler = event => {
    const data = event.data;
    if (!data || data.source !== 'ATS_NETWORK_PROBE' || data.type !== 'summary') return;
    const now = Date.now();
    if (now - lastSentAt < 80) return;
    lastSentAt = now;
    const payload = data.payload || {};

    const networkExpiration = normalizeExp(payload.controls?.expiration);
    const networkExpirationConfidence = Number(payload.controls?.confidence || 0);
    const networkExpirationAt = Number(payload.controls?.observedAt || 0);
    if (networkExpiration && networkExpirationConfidence >= 84 && now - networkExpirationAt < 7000) {
      sendMessage({
        type: 'ATS_PLATFORM_CONTROLS_OBSERVED',
        snapshot: {
          amount: null,
          expiration: networkExpiration,
          timeframe: null,
          confidence: { amount: 0, expiration: networkExpirationConfidence, timeframe: 0 },
          source: 'casatrade-network-control',
          observedAt: networkExpirationAt || now
        }
      }).catch(() => {});
    }

    sendMessage({ type: 'ATS_EMBEDDED_FEED', payload }).catch(() => {});
    maybePublishStructuredClock(payload).catch(() => {});
  };
  window.addEventListener('message', networkMessageHandler);

  globalThis.__ATS_EMBEDDED_FEED_BRIDGE_RUNTIME__ = {
    version: 'embedded-feed-bridge-restartable',
    teardown() {
      try { window.removeEventListener('message', networkMessageHandler); } catch {}
    }
  };
})();
