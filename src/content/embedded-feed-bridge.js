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
  let expirationThrottleDropCount = 0;
  const expirationThrottleDiagnosticStartedAt = Date.now();
  const feedDiagnostic = {
    summaryReceived: 0,
    candidatesWithTimestamp: 0,
    lastSummaryCandidates: [],
    maybeClockCalls: 0,
    maybeClockEarlyReturns: 0,
    maybeClockReasons: {
      focusNotReliable: 0,
      frameHostMismatch: 0,
      noCandidate: 0,
      noServerTime: 0,
      serverTimeDriftOver7000: 0,
      confidenceUnder55: 0,
      countUnder2: 0,
      boundaryNull: 0
    },
    marketClockV2Sent: 0,
    stateBoundaryIntervalCycles: 0,
    stateBoundaryPublications: 0,
    stateBoundaryLastRefusalReason: '',
    stateBoundaryLastDelayMs: null,
    networkContext: { contextKey: '', transport: '', endpoint: '', observedAt: 0, changed: false }
  };
  let lastBoundaryDiagnosticReason = null;
  let clockBusy = false;
  let clockProbe = null;
  let candleClockProbe = null;
  let lastClockSentAt = 0;
  let lastBoundaryAsset = '';
  let lastBoundaryTimeframe = '';
  let lastObservedBoundaryOpenAt = null;
  let blockedBoundaryOpenAt = null;

  function candleRowsFor(payload = {}, asset = '') {
    const recent = payload?.recentCandles && typeof payload.recentCandles === 'object' ? payload.recentCandles : {};
    const key = Object.keys(recent).find(value => sameMarket(value, asset));
    const rows = key && Array.isArray(recent[key]) ? recent[key] : [];
    return rows
      .filter(row => validOhlc(row) && normalizeTime(row?.time ?? row?.timestamp))
      .sort((a, b) => Number(normalizeTime(a?.time ?? a?.timestamp)) - Number(normalizeTime(b?.time ?? b?.timestamp)));
  }

  function stateCandleRowsFor(state = {}, asset = '') {
    const stateAsset = state.asset || state.diagnostics?.marketSession?.asset || '';
    if (stateAsset && !sameMarket(stateAsset, asset)) return [];
    const rows = Array.isArray(state.candles) ? state.candles : [];
    return rows
      .filter(row => (!row?.asset || sameMarket(row.asset, asset))
        && validOhlc(row)
        && normalizeTime(row?.time ?? row?.timestamp))
      .sort((a, b) => Number(normalizeTime(a?.time ?? a?.timestamp)) - Number(normalizeTime(b?.time ?? b?.timestamp)));
  }

  function structuredCandleBoundary(payload = {}, state = {}, focus = null, candidate = null) {
    lastBoundaryDiagnosticReason = null;
    if (!focus?.asset) {
      candleClockProbe = null;
      lastBoundaryDiagnosticReason = 'boundary nulo';
      return null;
    }

    let rows = candleRowsFor(payload, focus.asset);
    let clockMode = 'structured-current-candle-boundary';
    if (!rows.length) {
      rows = stateCandleRowsFor(state, focus.asset);
      clockMode = 'state-candle-boundary';
    }

    const latest = rows.at(-1) || null;
    if (!latest) {
      candleClockProbe = null;
      lastBoundaryDiagnosticReason = 'boundary nulo';
      return null;
    }

    const timeframe = normalizeTf(candidate?.timeframe || latest?.timeframe || state.analysisTimeframe || state.timeframe);
    const duration = durationSeconds(timeframe);
    const openAt = normalizeTime(latest?.time ?? latest?.timestamp);
    const now = Date.now();
    if (!timeframe || !duration || !openAt) {
      candleClockProbe = null;
      lastBoundaryDiagnosticReason = 'boundary nulo';
      return null;
    }

    const durationMs = duration * 1000;
    const previousOpenAt = rows.length > 1
      ? normalizeTime(rows.at(-2)?.time ?? rows.at(-2)?.timestamp)
      : null;
    const sourceStepMs = previousOpenAt ? openAt - previousOpenAt : null;
    const isSubTimeframeFeed = timeframe && durationMs > 60_000
      && Number.isFinite(sourceStepMs)
      && sourceStepMs >= 45_000
      && sourceStepMs <= 90_000;
    const currentBucket = Math.floor(now / durationMs) * durationMs;

    // M1 candles are the live feed available in this path. For M5, the latest
    // M1 candle opens inside the 5-minute window (for example, 12:03).
    // Align only to that real containing window; never invent a future candle.
    if (isSubTimeframeFeed) {
      if (openAt < currentBucket || openAt >= currentBucket + durationMs) {
        candleClockProbe = null;
        lastBoundaryDiagnosticReason = 'boundary nulo';
        return null;
      }
      openAt = currentBucket;
    } else if (openAt % durationMs !== 0) {
      candleClockProbe = null;
      lastBoundaryDiagnosticReason = 'openAt fora da grade do timeframe';
      return null;
    }

    const focusMarket = marketId(focus.asset);
    if (lastBoundaryAsset !== focusMarket || lastBoundaryTimeframe !== timeframe) {
      lastBoundaryAsset = focusMarket;
      lastBoundaryTimeframe = timeframe;
      lastObservedBoundaryOpenAt = null;
      blockedBoundaryOpenAt = null;
      candleClockProbe = null;
    }

    // Only the candle that is demonstrably open right now may become a clock anchor.
    // A closed historical candle is rejected instead of being shifted forward by guesswork.
    if (openAt > now + 1500 || now < openAt - 1500 || now >= openAt + durationMs + 1200) {
      candleClockProbe = null;
      lastBoundaryDiagnosticReason = 'boundary nulo';
      return null;
    }

    // Validate each observed candle rollover against the local device clock.
    // The first candle seen after load establishes the baseline; every later
    // open must arrive close to its actual open timestamp.
    if (lastObservedBoundaryOpenAt != null && Number(openAt) !== Number(lastObservedBoundaryOpenAt)) {
      const delayMs = now - openAt;
      feedDiagnostic.stateBoundaryLastDelayMs = delayMs;
      lastObservedBoundaryOpenAt = openAt;
      if (delayMs < -1500 || delayMs > 2500) {
        blockedBoundaryOpenAt = openAt;
        candleClockProbe = null;
        lastBoundaryDiagnosticReason = 'relógio do aparelho ou feed fora de sincronia';
        return null;
      }
      blockedBoundaryOpenAt = null;
    } else if (lastObservedBoundaryOpenAt == null) {
      lastObservedBoundaryOpenAt = openAt;
    }

    if (blockedBoundaryOpenAt != null && Number(blockedBoundaryOpenAt) === Number(openAt)) {
      candleClockProbe = null;
      lastBoundaryDiagnosticReason = 'relógio do aparelho ou feed fora de sincronia';
      return null;
    }

    const previous = candleClockProbe;
    const sameAnchor = !!previous && sameMarket(previous.asset, focus.asset)
      && previous.timeframe === timeframe && Number(previous.openAt) === Number(openAt);
    const localDelta = sameAnchor ? now - Number(previous.observedAt || 0) : 0;
    const count = sameAnchor && localDelta > 80 && localDelta < 5000
      ? Math.min(8, Number(previous.count || 1) + 1)
      : 1;
    candleClockProbe = { asset: focusMarket, timeframe, openAt, observedAt: now, count };
    if (count < 2) {
      lastBoundaryDiagnosticReason = 'count<2';
      return null;
    }

    const remainingMs = openAt + durationMs - now;
    const secondsRemaining = Math.max(0, Math.min(duration, Math.ceil(remainingMs / 1000)));
    if (!Number.isFinite(secondsRemaining) || secondsRemaining < 0 || secondsRemaining > duration) {
      lastBoundaryDiagnosticReason = 'boundary nulo';
      return null;
    }

    return { timeframe, secondsRemaining, openAt, count, clockMode };
  }

  async function publishCandleBoundaryClock(payload = {}, state = {}, focus = null, candidate = null) {
    const boundary = structuredCandleBoundary(payload, state, focus, candidate);
    if (!boundary) return false;
    const now = Date.now();
    if (now - lastClockSentAt < 300) return true;
    lastClockSentAt = now;
    feedDiagnostic.marketClockV2Sent += 1;
    if (boundary.clockMode === 'state-candle-boundary') {
      feedDiagnostic.stateBoundaryPublications += 1;
      feedDiagnostic.stateBoundaryLastRefusalReason = '';
    }
    await sendMessage({
      type: 'ATS_MARKET_CLOCK_V2', asset: focus.asset, timeframe: boundary.timeframe,
      secondsRemaining: boundary.secondsRemaining,
      expiration: state.targetExpiration || state.expiration || candidate?.expiration || null,
      available: true, verified: true, clockRole: 'candle-close',
      clockSource: 'network-server-cycle', clockMode: boundary.clockMode,
      clockText: boundary.clockMode === 'state-candle-boundary'
        ? 'Fechamento confirmado pela vela atual do estado ao vivo'
        : 'Fechamento confirmado pela vela atual do feed estruturado',
      clockToken: `${boundary.secondsRemaining}s`,
      confidence: 94, frameHost: host, at: now
    });
    return true;
  }

  async function maybePublishStructuredClock(payload = {}) {
    feedDiagnostic.maybeClockCalls += 1;
    if (clockBusy) return;
    clockBusy = true;
    try {
      const response = await sendMessage({ type: 'ATS_READ_SCANNER_STATE' });
      const state = response?.state || null;
      const focus = state?.diagnostics?.focusedAsset || null;
      if (!focus?.asset || focus.reliable !== true || focus.chartScoped !== true || focus.trustedChartFrame !== true) {
        feedDiagnostic.maybeClockEarlyReturns += 1;
        feedDiagnostic.maybeClockReasons.focusNotReliable += 1;
        return;
      }
      if (String(focus.frameHost || '').toLowerCase() !== host) {
        feedDiagnostic.maybeClockEarlyReturns += 1;
        feedDiagnostic.maybeClockReasons.frameHostMismatch += 1;
        return;
      }

      const currentClock = state?.diagnostics?.marketClock || null;
      if (currentClock?.verified === true && currentClock?.source === 'trader-dom-countdown'
        && Date.now() - Number(currentClock.at || 0) < 2200) return;

      const rows = (Array.isArray(payload.candidates) ? payload.candidates : [])
        .filter(row => sameMarket(row?.asset, focus.asset))
        .sort((a, b) => Number(b?.selected === true) - Number(a?.selected === true)
          || Number(b?.confidence || 0) - Number(a?.confidence || 0)
          || Number(b?.observedAt || 0) - Number(a?.observedAt || 0));
      const candidate = rows[0] || null;
      if (!candidate) feedDiagnostic.maybeClockReasons.noCandidate += 1;
      const serverTime = normalizeTime(candidate?.timestamp);
      if (candidate && !serverTime) feedDiagnostic.maybeClockReasons.noServerTime += 1;
      const timeframe = normalizeTf(candidate?.timeframe || state.analysisTimeframe || state.timeframe);
      const duration = durationSeconds(timeframe);
      const confidence = Number(candidate?.confidence || 0);
      const now = Date.now();
      if (candidate && serverTime && Math.abs(now - serverTime) > 7000) feedDiagnostic.maybeClockReasons.serverTimeDriftOver7000 += 1;
      if (candidate && confidence < 55) feedDiagnostic.maybeClockReasons.confidenceUnder55 += 1;

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
          feedDiagnostic.marketClockV2Sent += 1;
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
        if (count < 2) feedDiagnostic.maybeClockReasons.countUnder2 += 1;
      } else {
        clockProbe = null;
      }

      // CasaTrade often exposes a candle timestamp (open time), not a continuously advancing
      // server timestamp. When the newest OHLC row is the candle that is provably open now,
      // its start + timeframe is an exact candle-close boundary. Two live observations are
      // required before publishing it; historical rows are never rolled forward by modulo.
      const boundaryPublished = await publishCandleBoundaryClock(payload, state, focus, candidate);
      if (!boundaryPublished) {
        feedDiagnostic.maybeClockEarlyReturns += 1;
        const reason = lastBoundaryDiagnosticReason === 'countUnder2' ? 'countUnder2' : 'boundaryNull';
        feedDiagnostic.maybeClockReasons[reason] += 1;
      }
    } finally {
      clockBusy = false;
    }
  }

  async function stateCandleBoundaryIntervalTick() {
    feedDiagnostic.stateBoundaryIntervalCycles += 1;
    if (clockBusy) {
      feedDiagnostic.stateBoundaryLastRefusalReason = 'clockBusy';
      return;
    }
    clockBusy = true;
    try {
      const response = await sendMessage({ type: 'ATS_READ_SCANNER_STATE' });
      const state = response?.state || null;
      const focus = state?.diagnostics?.focusedAsset || null;
      if (!focus?.asset || focus.reliable !== true || focus.chartScoped !== true || focus.trustedChartFrame !== true) {
        feedDiagnostic.stateBoundaryLastRefusalReason = 'focus não confiável';
        return;
      }
      if (String(focus.frameHost || '').toLowerCase() !== host) {
        feedDiagnostic.stateBoundaryLastRefusalReason = 'frameHost diferente';
        return;
      }

      const published = await publishCandleBoundaryClock({}, state, focus, null);
      if (!published) {
        feedDiagnostic.stateBoundaryLastRefusalReason = lastBoundaryDiagnosticReason || 'boundary nulo';
      }
    } catch (error) {
      feedDiagnostic.stateBoundaryLastRefusalReason = clean(error?.message || error || 'erro no ciclo do relógio');
    } finally {
      clockBusy = false;
    }
  }

  const stateCandleBoundaryInterval = setInterval(() => {
    stateCandleBoundaryIntervalTick().catch(() => {});
  }, 1000);

  const networkMessageHandler = event => {
    const data = event.data;
    if (!data || data.source !== 'ATS_NETWORK_PROBE') return;

    if (data.type === 'context') {
      const context = data.payload && typeof data.payload === 'object' ? data.payload : {};
      const contextKey = clean(context.contextKey || '');
      const transport = clean(context.transport || '');
      const endpoint = clean(context.endpoint || '');
      const observedAt = Number(context.observedAt || Date.now());
      const changed = !!feedDiagnostic.networkContext.contextKey && feedDiagnostic.networkContext.contextKey !== contextKey;
      feedDiagnostic.networkContext = { contextKey, transport, endpoint, observedAt, changed };
      sendMessage({
        type: 'ATS_NETWORK_CONTEXT_CHANGED',
        payload: {
          contextKey,
          transport,
          endpoint,
          observedAt,
          changed,
          source: 'network-probe'
        }
      }).catch(() => {});
      return;
    }

    if (data.type !== 'summary') return;
    feedDiagnostic.summaryReceived += 1;
    const diagnosticCandidates = Array.isArray(data.payload?.candidates) ? data.payload.candidates : [];
    feedDiagnostic.candidatesWithTimestamp += diagnosticCandidates.filter(row => row?.timestamp != null).length;
    feedDiagnostic.lastSummaryCandidates = diagnosticCandidates.slice(0, 5).map(row => ({
      asset: clean(row?.asset || ''),
      timeframe: clean(row?.timeframe || ''),
      timestamp: row?.timestamp ?? null,
      confidence: Number(row?.confidence || 0),
      selected: row?.selected === true,
      observedAt: Number(row?.observedAt || 0),
      assetRaw: clean(row?.assetRaw || ''),
      assetSource: clean(row?.assetSource || '')
    }));
    const now = Date.now();
    if (now - lastSentAt < 80) {
      try {
        if (normalizeExp(data.payload?.controls?.expiration)) expirationThrottleDropCount += 1;
      } catch {}
      return;
    }
    lastSentAt = now;
    const payload = data.payload || {};

    const networkExpiration = normalizeExp(payload.controls?.expiration);
    const networkTimeframe = normalizeTf(payload.controls?.timeframe);
    const networkExpirationConfidence = Number(payload.controls?.confidence || 0);
    const networkTimeframeConfidence = Number(payload.controls?.timeframeConfidence || 0);
    const networkExpirationAt = Number(payload.controls?.observedAt || 0);
    const controlsFresh = networkExpirationAt > 0 && now - networkExpirationAt < 7000;
    if (controlsFresh && (
      (networkExpiration && networkExpirationConfidence >= 84)
      || (networkTimeframe && networkTimeframeConfidence >= 55)
    )) {
      sendMessage({
        type: 'ATS_PLATFORM_CONTROLS_OBSERVED',
        snapshot: {
          amount: null,
          expiration: networkExpiration || null,
          timeframe: networkTimeframe || null,
          confidence: {
            amount: 0,
            expiration: networkExpiration ? networkExpirationConfidence : 0,
            timeframe: networkTimeframe ? networkTimeframeConfidence : 0
          },
          source: clean(payload.controls?.sourceKey || 'casatrade-network-control').slice(0, 64),
          observedAt: networkExpirationAt || now
        }
      }).catch(() => {});
    }

    sendMessage({ type: 'ATS_EMBEDDED_FEED', payload }).catch(() => {});
    maybePublishStructuredClock(payload).catch(() => {});
  };
  window.addEventListener('message', networkMessageHandler);

  const diagnosticMessageHandler = event => {
    const data = event.data;
    if (!data || data.source !== 'ATS_EXPIRATION_DIAGNOSTIC_REQUEST' || !data.requestId) return;
    try {
      window.postMessage({
        source: 'ATS_EMBEDDED_FEED_DIAGNOSTIC_SNAPSHOT',
        requestId: data.requestId,
        payload: {
          frame: {
            href: String(location.href || ''),
            isTop: window === window.top,
            host
          },
          expirationThrottle80msDropCount: Number(expirationThrottleDropCount || 0),
          summaryReceived: Number(feedDiagnostic.summaryReceived || 0),
          candidatesWithTimestamp: Number(feedDiagnostic.candidatesWithTimestamp || 0),
          lastSummaryCandidates: feedDiagnostic.lastSummaryCandidates.slice(0, 5),
          networkContext: { ...feedDiagnostic.networkContext },
          maybePublishStructuredClock: {
            calls: Number(feedDiagnostic.maybeClockCalls || 0),
            earlyReturns: Number(feedDiagnostic.maybeClockEarlyReturns || 0),
            reasons: { ...feedDiagnostic.maybeClockReasons },
            marketClockV2Sent: Number(feedDiagnostic.marketClockV2Sent || 0)
          },
          stateCandleBoundary: {
            intervalCycles: Number(feedDiagnostic.stateBoundaryIntervalCycles || 0),
            publicationsSent: Number(feedDiagnostic.stateBoundaryPublications || 0),
            lastRefusalReason: clean(feedDiagnostic.stateBoundaryLastRefusalReason || ''),
            lastDelayMs: Number.isFinite(Number(feedDiagnostic.stateBoundaryLastDelayMs))
              ? Number(feedDiagnostic.stateBoundaryLastDelayMs)
              : null
          },
          startedAt: expirationThrottleDiagnosticStartedAt,
          observedAt: Date.now()
        }
      }, '*');
    } catch {}
  };
  window.addEventListener('message', diagnosticMessageHandler);

  globalThis.__ATS_EMBEDDED_FEED_BRIDGE_RUNTIME__ = {
    version: 'embedded-feed-bridge-restartable',
    teardown() {
      try { window.removeEventListener('message', networkMessageHandler); } catch {}
      try { window.removeEventListener('message', diagnosticMessageHandler); } catch {}
      try { clearInterval(stateCandleBoundaryInterval); } catch {}
    }
  };
})();
