(() => {
  if (globalThis.__ATS_LIVE_CLOCK__) return;
  globalThis.__ATS_LIVE_CLOCK__ = true;

  const send = message => {
    const fn = globalThis.__ATS_SEND_MESSAGE__;
    if (typeof fn === 'function') return fn(message);
    return new Promise(resolve => {
      let tries = 0;
      const retry = () => {
        const current = globalThis.__ATS_SEND_MESSAGE__;
        if (typeof current === 'function') current(message).then(resolve).catch(() => resolve(null));
        else if (++tries < 50) setTimeout(retry, 50);
        else resolve(null);
      };
      retry();
    });
  };

  const clean = value => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  const fold = value => clean(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const tfSeconds = value => {
    const raw = clean(value).toUpperCase().replace(/\s+/g, '');
    let match = raw.match(/^S(\d+)$/);
    if (match) return Number(match[1]);
    match = raw.match(/^M(\d+)$/);
    if (match) return Number(match[1]) * 60;
    match = raw.match(/^H(\d+)$/);
    return match ? Number(match[1]) * 3600 : null;
  };
  const visible = element => {
    if (!(element instanceof Element)) return false;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0;
  };

  let market = null;
  let timer = null;
  let lastClockSecond = -1;
  let lastDomProbe = null;
  let domVerifiedUntil = 0;
  let sourceProbe = null;
  let sourceAnchor = null;
  let lastControlsSignature = '';
  let lastControlsAt = 0;
  let cachedChart = null;
  let cachedChartAt = 0;

  function chartRect() {
    const now = performance.now();
    if (cachedChart && now - cachedChartAt < 1800) return cachedChart;
    const rows = [];
    let inspected = 0;
    for (const element of document.querySelectorAll('canvas,svg,[class*="chart" i],[data-testid*="chart" i],[class*="candle" i]')) {
      if (++inspected > 500 || !visible(element)) continue;
      const rect = element.getBoundingClientRect();
      if (rect.width < 180 || rect.height < 100) continue;
      let score = rect.width * rect.height;
      if (element.tagName?.toLowerCase() === 'canvas') score *= 1.5;
      rows.push({ rect, score });
    }
    rows.sort((a,b) => b.score - a.score);
    cachedChart = rows[0]?.rect || null;
    cachedChartAt = now;
    return cachedChart;
  }

  function nearChart(rect, chart) {
    if (!chart) return false;
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const padX = Math.max(80, chart.width * .14);
    const padY = Math.max(50, chart.height * .12);
    return x >= chart.left - padX && x <= chart.right + padX && y >= chart.top - padY && y <= chart.bottom + padY;
  }

  function parseCountdowns(text, limit) {
    const out = [];
    const value = clean(text);
    for (const match of value.matchAll(/\b(\d{1,2}):([0-5]\d)\b/g)) {
      const seconds = Number(match[1]) * 60 + Number(match[2]);
      if (seconds >= 0 && seconds <= limit + 2) out.push({ seconds, token: match[0], mmss: true });
    }
    for (const match of value.matchAll(/\b(\d{1,5})\s*(?:s|seg|segundo|segundos)\b/gi)) {
      const seconds = Number(match[1]);
      if (seconds >= 0 && seconds <= limit + 2) out.push({ seconds, token: match[0], mmss: false });
    }
    return out;
  }

  function bestDomCountdown() {
    if (!market) return null;
    const limit = tfSeconds(market.timeframe);
    if (!limit) return null;
    const chart = chartRect();
    const rows = [];
    const elements = document.querySelectorAll('time,[role="timer"],[aria-valuetext],[aria-label],span,div,p');
    let inspected = 0;
    for (const element of elements) {
      if (++inspected > 2600 || !visible(element)) continue;
      const own = clean(element.getAttribute?.('aria-valuetext') || element.getAttribute?.('aria-label') || element.getAttribute?.('title') || element.textContent || '');
      if (!own || own.length > 90) continue;
      const values = parseCountdowns(own, limit);
      if (!values.length) continue;
      const rect = element.getBoundingClientRect();
      const context = fold(`${own} ${element.parentElement?.textContent || ''} ${element.id || ''} ${element.className || ''}`).slice(0, 320);
      const scoped = nearChart(rect, chart);
      const candleSemantic = /vela|candle|fechamento|close|remaining|restante|countdown|timer/.test(context);
      const expirySemantic = /expira|expiry|expiration|duracao|duração|tempo da operacao|tempo de operação/.test(context);
      if (!scoped && !candleSemantic) continue;
      for (const value of values) {
        let score = scoped ? 170 : 0;
        if (value.mmss) score += 75;
        if (candleSemantic) score += 80;
        if (/vela|candle|fechamento|close/.test(context)) score += 50;
        if (expirySemantic) score -= 120;
        rows.push({ ...value, score, text: own });
      }
    }
    rows.sort((a,b) => b.score - a.score || a.seconds - b.seconds);
    return rows[0]?.score >= 120 ? rows[0] : null;
  }

  function expirationFromDom() {
    const rows = [];
    let inspected = 0;
    for (const element of document.querySelectorAll('[aria-label],[aria-valuetext],[data-testid],label,button,span,div')) {
      if (++inspected > 2400 || !visible(element)) continue;
      const own = clean(element.getAttribute?.('aria-valuetext') || element.getAttribute?.('aria-label') || element.getAttribute?.('title') || element.textContent || '');
      if (!own || own.length > 120) continue;
      const context = fold(`${own} ${element.parentElement?.textContent || ''}`).slice(0, 240);
      if (!/expira|expiry|expiration|duracao|duração/.test(context)) continue;
      let match = own.match(/\b(\d{1,5})\s*(?:s|seg|segundo|segundos)\b/i);
      if (match) rows.push({ value: `${Number(match[1])}s`, score: 100 });
      match = own.match(/\b(\d{1,3}):(\d{2})\b/);
      if (match) rows.push({ value: `${Number(match[1]) * 60 + Number(match[2])}s`, score: 90 });
      match = own.match(/\b(\d{1,4})\s*(?:m|min|minuto|minutos)\b/i);
      if (match) rows.push({ value: `${Number(match[1]) * 60}s`, score: 80 });
    }
    rows.sort((a,b) => b.score - a.score);
    return rows[0]?.value || market?.expiration || null;
  }

  function publishControls(expiration) {
    if (!market || !expiration) return;
    const signature = `${market.timeframe}|${expiration}`;
    const now = Date.now();
    if (signature === lastControlsSignature && now - lastControlsAt < 2500) return;
    lastControlsSignature = signature;
    lastControlsAt = now;
    send({
      type: 'ATS_PLATFORM_CONTROLS_OBSERVED',
      snapshot: {
        amount: null,
        expiration,
        timeframe: market.timeframe,
        source: 'casatrade-visible-controls',
        confidence: { amount: 0, expiration: 100, timeframe: 96 }
      }
    }).catch(() => {});
  }

  function sendClock(seconds, sourceNow, mode, token, confidence = 100) {
    if (!market) return;
    const closeAt = market.openAt + market.durationMs;
    const bounded = Math.max(0, Math.min(tfSeconds(market.timeframe) || seconds, Number(seconds)));
    if (!Number.isFinite(sourceNow) || sourceNow < market.openAt - 1500 || sourceNow > closeAt + 1500) return;
    const expiration = expirationFromDom();
    publishControls(expiration);
    if (bounded === lastClockSecond && mode !== 'dom-countdown') return;
    lastClockSecond = bounded;
    send({
      type: 'ATS_MARKET_CLOCK_V2',
      asset: market.asset,
      timeframe: market.timeframe,
      secondsRemaining: bounded,
      millisecondsRemaining: Math.max(0, Math.round(closeAt - sourceNow)),
      closeAt,
      expiration: expiration || null,
      available: true,
      verified: true,
      operational: true,
      clockRole: 'candle-close',
      clockSource: 'casatrade-platform-clock',
      clockMode: mode,
      clockText: mode === 'dom-countdown'
        ? 'Countdown visível da vela + timestamp OHLC da CasaTrade'
        : 'Timestamp de mercado da CasaTrade validado em movimento',
      clockToken: token || `${Math.ceil(bounded)}s`,
      confidence,
      sourceNow: Math.round(sourceNow)
    }).catch(() => {});
  }

  function observeDom(candidate) {
    if (!candidate || !market) return false;
    const now = performance.now();
    const previous = lastDomProbe;
    const duration = tfSeconds(market.timeframe) || 60;
    const same = previous && previous.asset === market.asset && previous.timeframe === market.timeframe;
    if (same) {
      const elapsed = now - previous.at;
      const drop = previous.seconds - candidate.seconds;
      const progressed = elapsed >= 250 && elapsed <= 3500 && drop > 0 && drop <= Math.max(4, Math.ceil(elapsed / 1000) + 2);
      const rolled = elapsed >= 250 && elapsed <= 3500 && previous.seconds <= 2 && candidate.seconds >= duration - 2;
      if (progressed || rolled) domVerifiedUntil = now + 3200;
    }
    lastDomProbe = { asset: market.asset, timeframe: market.timeframe, seconds: candidate.seconds, at: now };
    if (now > domVerifiedUntil) return false;
    const closeAt = market.openAt + market.durationMs;
    const sourceNow = closeAt - candidate.seconds * 1000;
    sendClock(candidate.seconds, sourceNow, 'dom-countdown', candidate.token, 100);
    return true;
  }

  function observeSourceNow(sourceNow) {
    if (!market || !Number.isFinite(sourceNow)) return;
    const perf = performance.now();
    const previous = sourceProbe;
    if (previous && previous.asset === market.asset && previous.timeframe === market.timeframe) {
      const marketDelta = sourceNow - previous.sourceNow;
      const perfDelta = perf - previous.perf;
      if (marketDelta >= 120 && marketDelta <= 5000 && perfDelta >= 80 && perfDelta <= 5000 && Math.abs(marketDelta - perfDelta) <= 1600) {
        sourceAnchor = { asset: market.asset, timeframe: market.timeframe, epochAtAnchor: sourceNow, perfAtAnchor: perf };
      }
    }
    sourceProbe = { asset: market.asset, timeframe: market.timeframe, sourceNow, perf };
  }

  function tick() {
    timer = null;
    if (!market) return;
    const dom = bestDomCountdown();
    const domUsed = observeDom(dom);
    if (!domUsed && sourceAnchor && sourceAnchor.asset === market.asset && sourceAnchor.timeframe === market.timeframe) {
      const sourceNow = sourceAnchor.epochAtAnchor + (performance.now() - sourceAnchor.perfAtAnchor);
      const closeAt = market.openAt + market.durationMs;
      const remaining = Math.max(0, closeAt - sourceNow);
      sendClock(Math.ceil(remaining / 1000), sourceNow, 'validated-market-source', `${Math.ceil(remaining / 1000)}s`, 98);
    }
    timer = setTimeout(tick, 180);
  }

  window.addEventListener('ATS_NUMERIC_OHLC_CLOCK', event => {
    const detail = event.detail || {};
    const openAt = Number(detail.openAt);
    const durationMs = Number(detail.durationMs);
    const sourceNow = Number(detail.sourceNow);
    if (!detail.asset || !detail.timeframe || !Number.isFinite(openAt) || !Number.isFinite(durationMs) || durationMs <= 0) return;

    const changed = !market
      || market.asset !== detail.asset
      || market.timeframe !== detail.timeframe
      || market.openAt !== openAt;

    market = {
      asset: detail.asset,
      timeframe: detail.timeframe,
      openAt,
      durationMs,
      expiration: detail.expiration || market?.expiration || null
    };

    if (changed) {
      lastClockSecond = -1;
      lastDomProbe = null;
      domVerifiedUntil = 0;
      sourceProbe = null;
      sourceAnchor = null;
    }
    if (Number.isFinite(sourceNow)) observeSourceNow(sourceNow);
    if (!timer) tick();
  }, true);

  new MutationObserver(() => {
    cachedChartAt = 0;
    if (market && !timer) tick();
  }).observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
})();
