(() => {
  if (globalThis.__ATS_OPERATION_TIME_SYNC__) return;

  const EXACT_SOURCES = new Set(['trader-dom-countdown', 'network-server-cycle']);
  const CLOCK_FRESH_MS = 8000;
  const clean = value => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();

  function normTf(value = '') {
    const raw = clean(value).toUpperCase().replace(/\s+/g, '');
    let match = raw.match(/^M(\d{1,4})$/) || raw.match(/^(\d{1,4})(?:M|MIN)$/);
    if (match && Number(match[1]) > 0) return `M${Number(match[1])}`;
    match = raw.match(/^S(\d{1,5})$/) || raw.match(/^(\d{1,5})S$/);
    if (match && Number(match[1]) > 0) return `S${Number(match[1])}`;
    match = raw.match(/^H(\d{1,3})$/) || raw.match(/^(\d{1,3})H$/);
    return match && Number(match[1]) > 0 ? `H${Number(match[1])}` : null;
  }

  function normExp(value = '') {
    const raw = clean(value).toLowerCase().replace(/\s+/g, '');
    let match = raw.match(/^(\d{1,5})(?:s|seg|segundo|segundos)$/);
    if (match) return `${Number(match[1])}s`;
    match = raw.match(/^(\d{1,4})(?:m|min|minuto|minutos)$/);
    if (match) return `${Number(match[1]) * 60}s`;
    match = raw.match(/^(\d{1,3}):(\d{2})$/);
    return match ? `${Number(match[1]) * 60 + Number(match[2])}s` : null;
  }

  function operatingTimeframe(value = '') {
    return normTf(value) === 'M5' ? 'M5' : 'M1';
  }

  function configFor(value = '') {
    const timeframe = operatingTimeframe(value);
    return Object.freeze({
      timeframe,
      durationSeconds: timeframe === 'M5' ? 300 : 60,
      durationMs: timeframe === 'M5' ? 300_000 : 60_000,
      expiration: timeframe === 'M5' ? '300s' : '60s',
      contextTimeframe: timeframe === 'M5' ? 'M15' : 'M5',
      finalWindowSeconds: timeframe === 'M5' ? 20 : 10
    });
  }

  function preferencesFromMessage(current = {}, message = {}) {
    const config = configFor(message.operatingTimeframe || current.operatingTimeframe || 'M1');
    return {
      ...current,
      mode: 'A_PLUS',
      operatingTimeframe: config.timeframe,
      holdSeconds: 3,
      geminiEnabled: message.geminiEnabled == null ? current.geminiEnabled !== false : message.geminiEnabled !== false,
      preferredExpiration: normExp(message.preferredExpiration || '') || config.expiration
    };
  }

  function authoritativeExpiration(state = {}) {
    const controls = state?.platformControls || {};
    const observed = controls?.observed || {};
    const observedValue = normExp(observed.expiration);
    const observedAt = Number(observed?.observedAt?.expiration || controls.expirationCheckedAt || 0);
    if (observedValue && observedAt > 0) {
      // platformControls is background-owned state populated only by trusted
      // CasaTrade readers. Older/recovered states may predate liveAuthority,
      // so the real value + real observation timestamp are the authority.
      return { value: observedValue, at: observedAt, source: clean(controls.source || observed.source || 'platform-controls') };
    }

    const guard = state?.diagnostics?.expirationGuard || {};
    const guardValue = normExp(guard.actual);
    const guardAt = Number(guard.at || 0);
    const guardSource = clean(guard.source || '');
    if (guardValue && guardAt > 0 && guardSource === 'background-direct-expiration-probe') {
      return { value: guardValue, at: guardAt, source: guardSource };
    }

    const platformTime = state?.diagnostics?.platformTime || {};
    const platformValue = normExp(platformTime.expiration);
    const platformAt = Number(platformTime.at || 0);
    const platformSource = clean(platformTime.source || '');
    if (platformValue && platformAt > 0 && platformSource === 'background-direct-expiration-probe') {
      return { value: platformValue, at: platformAt, source: platformSource };
    }

    return { value: null, at: 0, source: null };
  }

  function sameMarket(a, b) {
    const normalize = value => {
      const raw = clean(value).toUpperCase();
      if (!raw) return '';
      const otc = /(?:\(|\b|[_-])OTC(?:\)|\b)?/i.test(raw);
      const pair = raw.match(/\b([A-Z0-9]{2,20})\s*[\/_-]\s*([A-Z0-9]{2,12})/i);
      return pair ? `${pair[1]}/${pair[2]}${otc ? ' (OTC)' : ''}` : raw;
    };
    const left = normalize(a);
    return !!left && left === normalize(b);
  }

  function read(state = {}, now = Date.now()) {
    const config = configFor(state?.analystPreferences?.operatingTimeframe || state?.operationPlan?.timeframe || 'M1');
    const controls = state?.platformControls?.observed || {};
    const clock = state?.diagnostics?.marketClock || {};
    const focus = state?.diagnostics?.focusedAsset || {};

    const timeframeAt = Number(controls?.observedAt?.timeframe || state?.platformControls?.timeframeCheckedAt || 0);
    const expirationAuthority = authoritativeExpiration(state);
    const expirationAt = Number(expirationAuthority.at || 0);
    const visibleTimeframe = normTf(controls.timeframe);
    const expiration = normExp(expirationAuthority.value);
    const clockTimeframe = normTf(clock.timeframe);
    const seconds = Number(clock.secondsRemaining);
    const clockAge = Number(now) - Number(clock.at || 0);
    const timeframeAge = Number(now) - timeframeAt;

    const focusReady = !!state?.asset
      && !!focus?.asset
      && focus.reliable === true
      && focus.chartScoped === true
      && focus.trustedChartFrame === true
      && sameMarket(focus.asset, state.asset);

    const clockBaseReady = focusReady
      && clock.available !== false
      && clock.verified === true
      && clean(clock.role) === 'candle-close'
      && EXACT_SOURCES.has(clean(clock.source))
      && sameMarket(clock.asset, state.asset)
      && Number(clock.at || 0) > 0
      && clockAge >= 0
      && clockAge < CLOCK_FRESH_MS;

    const freshVisibleTimeframe = timeframeAt > 0
      && timeframeAge >= 0
      && timeframeAge < 7000
      ? visibleTimeframe
      : null;
    const visibleTimeframeContradiction = !!freshVisibleTimeframe && freshVisibleTimeframe !== config.timeframe;
    // If CasaTrade's compact/mobile layout does not expose a separately
    // readable candle-period control, an exact verified candle clock for M1/M5
    // is also authoritative evidence of that candle period. A fresh visible
    // contradictory control still wins and blocks the scanner.
    const timeframeReady = !visibleTimeframeContradiction
      && (freshVisibleTimeframe === config.timeframe
        || (clockBaseReady && clockTimeframe === config.timeframe));

    const expirationReady = expirationAt > 0 && expiration === config.expiration;

    const clockReady = clockBaseReady
      && clockTimeframe === config.timeframe
      && Number.isFinite(seconds)
      && seconds >= 0
      && seconds <= config.durationSeconds + 2;

    let reason = '';
    if (!focusReady) reason = 'Confirmando o ativo real do gráfico.';
    else if (!timeframeReady && visibleTimeframeContradiction) reason = `Período da vela fora de sincronia: gráfico ${freshVisibleTimeframe || '—'}, scanner ${config.timeframe}.`;
    else if (!timeframeReady) reason = `Confirmando o período real da vela ${config.timeframe} pelo clock da CasaTrade.`;
    else if (!expiration) reason = `Lendo a expiração real da CasaTrade (${config.expiration}).`;
    else if (!expirationReady) reason = `Expiração fora de sincronia: CasaTrade ${expiration}, necessário ${config.expiration}.`;
    else if (!clockReady) reason = `Sincronizando o fechamento real da vela ${config.timeframe}.`;
    else reason = `${config.timeframe} sincronizado: período, expiração e fechamento da vela confirmados.`;

    return {
      ready: focusReady && timeframeReady && expirationReady && clockReady,
      focusReady,
      timeframeReady,
      expirationReady,
      clockReady,
      desiredTimeframe: config.timeframe,
      visibleTimeframe: freshVisibleTimeframe,
      timeframeAuthority: freshVisibleTimeframe === config.timeframe ? 'visible-control'
        : clockBaseReady && clockTimeframe === config.timeframe ? 'exact-candle-clock'
          : null,
      clockTimeframe,
      expiration,
      expirationAuthority: expirationAuthority.source,
      requiredExpiration: config.expiration,
      secondsRemaining: clockReady ? seconds : null,
      contextTimeframe: config.contextTimeframe,
      finalWindowSeconds: config.finalWindowSeconds,
      durationSeconds: config.durationSeconds,
      reason
    };
  }

  globalThis.__ATS_OPERATION_TIME_SYNC__ = Object.freeze({
    normTf,
    normExp,
    operatingTimeframe,
    configFor,
    preferencesFromMessage,
    authoritativeExpiration,
    read
  });
})();
