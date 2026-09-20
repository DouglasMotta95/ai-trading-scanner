(() => {
  if (globalThis.__ATS_OPERATION_TIME_SYNC__) return;

  const EXACT_SOURCES = new Set(['trader-dom-countdown', 'network-server-cycle']);
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
    const expirationAt = Number(controls?.observedAt?.expiration || state?.platformControls?.expirationCheckedAt || 0);
    const visibleTimeframe = normTf(controls.timeframe);
    const expiration = normExp(controls.expiration);
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

    const timeframeReady = timeframeAt > 0
      && timeframeAge >= 0
      && timeframeAge < 7000
      && visibleTimeframe === config.timeframe;

    const expirationReady = expirationAt > 0 && expiration === config.expiration;

    const clockReady = focusReady
      && clock.available !== false
      && clock.verified === true
      && clean(clock.role) === 'candle-close'
      && EXACT_SOURCES.has(clean(clock.source))
      && sameMarket(clock.asset, state.asset)
      && clockTimeframe === config.timeframe
      && Number.isFinite(seconds)
      && seconds >= 0
      && seconds <= config.durationSeconds + 2
      && Number(clock.at || 0) > 0
      && clockAge >= 0
      && clockAge < 3200;

    let reason = '';
    if (!focusReady) reason = 'Confirmando o ativo real do gráfico.';
    else if (!visibleTimeframe) reason = `Lendo o período real da vela (${config.timeframe}).`;
    else if (!timeframeReady) reason = `Período da vela fora de sincronia: gráfico ${visibleTimeframe || '—'}, scanner ${config.timeframe}.`;
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
      visibleTimeframe,
      clockTimeframe,
      expiration,
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
    read
  });
})();
