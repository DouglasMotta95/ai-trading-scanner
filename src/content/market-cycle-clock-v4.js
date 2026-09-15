(() => {
  if (globalThis.__ATS_MARKET_CYCLE_CLOCK_V4__) return;
  globalThis.__ATS_MARKET_CYCLE_CLOCK_V4__ = true;
  globalThis.__ATS_MARKET_CYCLE_CLOCK_V3__ = true;
  globalThis.__ATS_MARKET_CLOCK_SYNC__ = true;

  const clean = value => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  const fold = value => clean(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const host = String(location.hostname || '').toLowerCase().replace(/\.$/, '');
  const traderHost = value => value === 'casatraders.online' || value.endsWith('.casatraders.online') || value === 'ivcasatraders.online' || value.endsWith('.ivcasatraders.online');
  const casaHost = value => value === 'casatrade.com' || value.endsWith('.casatrade.com') || value === 'casatrade.io' || value.endsWith('.casatrade.io');
  if (!traderHost(host) && !casaHost(host)) return;
  const sendMessage = globalThis.__ATS_SEND_MESSAGE__;
  if (typeof sendMessage !== 'function') return;

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

  function tf(value) {
    const s = fold(value).replace(/\s+/g, '');
    let m = s.match(/^s(\d{1,5})$/) || s.match(/^(\d{1,5})(?:s|seg|segundo|segundos)$/);
    if (m && Number(m[1]) > 0) return `S${Number(m[1])}`;
    m = s.match(/^m(\d{1,4})$/) || s.match(/^(\d{1,4})(?:m|min|minuto|minutos)$/);
    if (m && Number(m[1]) > 0) return `M${Number(m[1])}`;
    m = s.match(/^h(\d{1,3})$/) || s.match(/^(\d{1,3})h$/);
    if (m && Number(m[1]) > 0) return `H${Number(m[1])}`;
    return null;
  }
  function secondsFor(value) {
    const x = tf(value) || 'M1';
    if (x[0] === 'S') return Number(x.slice(1));
    if (x[0] === 'M') return Number(x.slice(1)) * 60;
    if (x[0] === 'H') return Number(x.slice(1)) * 3600;
    return 60;
  }
  function visible(el) {
    if (!el || !(el instanceof Element)) return false;
    const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity || 1) > 0;
  }

  let elementCache = [], elementCacheAt = 0;
  function nodes(limit = 6500) {
    const now = Date.now();
    if (elementCache.length && now - elementCacheAt < 450) return elementCache.slice(0, limit);
    const out = [], roots = [document], seen = new Set();
    while (roots.length && out.length < 7000) {
      const root = roots.shift(); if (!root || seen.has(root)) continue; seen.add(root);
      let rows = []; try { rows = [...root.querySelectorAll('*')]; } catch {}
      for (const el of rows) { out.push(el); if (out.length >= 7000) break; if (el.shadowRoot) roots.push(el.shadowRoot); }
    }
    elementCache = out; elementCacheAt = now; return out.slice(0, limit);
  }
  function chartRect() {
    const rows = [];
    for (const el of nodes(4200)) {
      if (!visible(el)) continue;
      const tag = String(el.tagName || '').toLowerCase();
      const meta = `${el.id || ''} ${el.className || ''} ${el.getAttribute?.('data-testid') || ''}`.toLowerCase();
      if (tag !== 'canvas' && tag !== 'svg' && !/chart|candle|graph|tradingview|plot/.test(meta)) continue;
      const r = el.getBoundingClientRect(); if (r.width < 180 || r.height < 120) continue;
      let score = r.width * r.height; if (tag === 'canvas') score *= 1.8; if (/chart|candle|tradingview/.test(meta)) score *= 1.25;
      rows.push({ rect: r, score });
    }
    rows.sort((a, b) => b.score - a.score); return rows[0]?.rect || null;
  }
  function selectedChartTf() {
    const rows = [];
    for (const el of nodes(5000)) {
      if (!visible(el)) continue;
      const text = clean(el.getAttribute?.('aria-label') || el.getAttribute?.('title') || el.innerText || el.textContent || '');
      if (!text || text.length > 28) continue;
      const value = tf(text); if (!value) continue;
      const flags = `${el.className || ''} ${el.getAttribute?.('aria-selected') || ''} ${el.getAttribute?.('aria-current') || ''} ${el.getAttribute?.('data-state') || ''}`;
      const context = fold(`${flags} ${el.parentElement?.innerText || ''}`);
      let score = /true|active|selected|current|checked/i.test(flags) ? 190 : 0;
      if (/vela|candle|timeframe|periodo|period/.test(context)) score += 90;
      if (/expira|expiry|duration|hora de compra|buy time|entry time/.test(context)) score -= 190;
      rows.push({ value, score });
    }
    rows.sort((a, b) => b.score - a.score); return rows[0]?.score > 0 ? rows[0].value : null;
  }
  function inOrNearChart(rect, chart) {
    if (!chart) return false;
    const padX = Math.max(70, chart.width * .12), padY = Math.max(45, chart.height * .10);
    const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
    return cx >= chart.left - padX && cx <= chart.right + padX && cy >= chart.top - padY && cy <= chart.bottom + padY;
  }
  function exactDomCountdown(cycleTf) {
    const limit = secondsFor(cycleTf), chart = chartRect(), rows = [];
    for (const el of nodes(7000)) {
      if (!visible(el)) continue;
      const own = clean(el.getAttribute?.('aria-label') || el.getAttribute?.('aria-valuetext') || el.getAttribute?.('title') || el.innerText || el.textContent || '');
      if (!own || own.length > 100) continue;
      const parentText = clean(el.parentElement?.innerText || el.parentElement?.textContent || '');
      const context = fold(`${own} ${parentText} ${el.id || ''} ${el.className || ''}`).slice(0, 340);
      if (/hora de compra|buy time|entry time|duration|duracao/.test(context)) continue;
      const values = [];
      for (const match of own.matchAll(/\b(\d{1,3}):([0-5]\d)\b/g)) values.push({ seconds: Number(match[1]) * 60 + Number(match[2]), token: match[0] });
      for (const match of own.matchAll(/\b(\d{1,5})\s*(?:s|seg|segundo|segundos)\b/gi)) values.push({ seconds: Number(match[1]), token: match[0] });
      if (!values.length) continue;
      const rect = el.getBoundingClientRect();
      const chartScoped = inOrNearChart(rect, chart);
      const candleSemantic = /vela|candle|remaining|restante|countdown|timer|fechamento|close/.test(context);
      const expirySemantic = /expira|expiry|expiration/.test(context);
      if (!candleSemantic && !expirySemantic && !chartScoped) continue;
      for (const value of values) {
        if (value.seconds < 0 || value.seconds > limit + 2) continue;
        let score = chartScoped ? 230 : 0; if (candleSemantic || expirySemantic) score += 180;
        if (/vela|candle|fechamento|close/.test(context)) score += 90;
        if (/remaining|restante|countdown|timer/.test(context)) score += 55;
        if (expirySemantic) score += 45;
        if (/^\d{1,3}:[0-5]\d$/.test(own)) score += 35;
        rows.push({ ...value, text: own, score, chartScoped, expirySemantic });
      }
    }
    rows.sort((a, b) => b.score - a.score || a.seconds - b.seconds); return rows[0] || null;
  }
  function derivedCountdown(cycleTf) {
    const duration = secondsFor(cycleTf);
    const now = Date.now();
    const durationMs = duration * 1000, elapsed = ((now % durationMs) + durationMs) % durationMs;
    let seconds = Math.ceil((durationMs - elapsed) / 1000); if (!Number.isFinite(seconds) || seconds <= 0 || seconds > duration) seconds = duration;
    return seconds;
  }

  function freshExactClock(state = {}, focus = null, cycleTf = null) {
    const clock = state?.diagnostics?.marketClock || null;
    if (!clock || !focus?.asset) return null;
    if (clock.verified !== true || clock.available === false || clock.role !== 'candle-close') return null;
    if (!['trader-dom-countdown', 'network-server-cycle'].includes(String(clock.source || ''))) return null;
    if (!sameMarket(clock.asset, focus.asset)) return null;
    if (tf(clock.timeframe) && cycleTf && tf(clock.timeframe) !== tf(cycleTf)) return null;
    if (Number(clock.frameId) !== Number(focus.frameId)) return null;
    if (String(clock.frameHost || '').toLowerCase() !== host) return null;
    if (Date.now() - Number(clock.at || 0) >= 2300) return null;
    return clock;
  }

  let stateBoundaryProbe = null;
  function currentStateBoundary(state = {}, focus = null, cycleTf = 'M1') {
    const duration = secondsFor(cycleTf);
    const durationMs = duration * 1000;
    const source = state.marketHistory || {};
    const key = Object.keys(source).find(value => sameMarket(value, focus?.asset));
    const rows = key && Array.isArray(source[key]) ? source[key] : Array.isArray(state.candles) && sameMarket(state.asset, focus?.asset) ? state.candles : [];
    const latest = rows
      .map(row => ({ row, time: normalizeTime(row?.time ?? row?.timestamp) }))
      .filter(item => item.time && [item.row?.open, item.row?.high, item.row?.low, item.row?.close].every(value => Number.isFinite(Number(value))))
      .sort((a, b) => a.time - b.time)
      .at(-1);
    if (!latest) { stateBoundaryProbe = null; return null; }
    const now = Date.now();
    const openAt = latest.time;
    if (openAt > now + 1500 || now < openAt - 1500 || now >= openAt + durationMs + 1200) {
      stateBoundaryProbe = null;
      return null;
    }
    const same = !!stateBoundaryProbe && sameMarket(stateBoundaryProbe.asset, focus.asset)
      && stateBoundaryProbe.timeframe === tf(cycleTf) && Number(stateBoundaryProbe.openAt) === Number(openAt);
    const delta = same ? now - Number(stateBoundaryProbe.at || 0) : 0;
    const count = same && delta > 80 && delta < 5000 ? Math.min(8, Number(stateBoundaryProbe.count || 1) + 1) : 1;
    stateBoundaryProbe = { asset: marketId(focus.asset), timeframe: tf(cycleTf), openAt, at: now, count };
    if (count < 2) return null;
    const seconds = Math.max(0, Math.min(duration, Math.ceil((openAt + durationMs - now) / 1000)));
    return { seconds, openAt, count };
  }

  let lastCanvas = null;
  let lastCanvasAsset = '';
  let canvasVerifiedAt = 0;
  let canvasBusy = false;
  async function acceptCanvasCountdown(payload = {}) {
    if (canvasBusy) return;
    const seconds = Number(payload.seconds), observedAt = Number(payload.at || Date.now());
    if (!Number.isFinite(seconds) || seconds < 0) return;
    canvasBusy = true;
    try {
      const response = await sendMessage({ type: 'ATS_READ_SCANNER_STATE' });
      const state = response?.state || null;
      const focus = state?.diagnostics?.focusedAsset || null;
      if (!focus?.asset || focus.reliable !== true || focus.chartScoped !== true || focus.trustedChartFrame !== true) return;
      if (String(focus.frameHost || '').toLowerCase() !== host) return;
      if (lastCanvasAsset && lastCanvasAsset !== focus.asset) { lastCanvas = null; canvasVerifiedAt = 0; }
      lastCanvasAsset = focus.asset;
      const controls = state.platformControls?.observed || {};
      const cycleTf = tf(controls.timeframe) || selectedChartTf() || tf(state.analysisTimeframe || state.timeframe) || 'M1';
      const duration = secondsFor(cycleTf);
      if (seconds > duration + 2) return;
      const previous = lastCanvas;
      const localDelta = previous ? observedAt - previous.at : 0;
      const drop = previous ? previous.seconds - seconds : 0;
      const progressed = !!previous && localDelta > 150 && localDelta < 4500 && drop > 0 && drop <= Math.max(4, Math.ceil(localDelta / 1000) + 2);
      const rolled = !!previous && localDelta > 150 && localDelta < 4500 && previous.seconds <= 2 && seconds >= duration - 2 && seconds <= duration + 1;
      lastCanvas = { seconds, at: observedAt, cycleTf };
      if (!progressed && !rolled) return;
      const expiration = clean(controls.expiration || state.targetExpiration || state.expiration || '') || null;
      canvasVerifiedAt = Date.now();
      await sendMessage({
        type: 'ATS_MARKET_CLOCK_V2', asset: focus.asset, timeframe: cycleTf,
        secondsRemaining: seconds, expiration, available: true, verified: true, operational: true,
        clockRole: 'candle-close', clockSource: 'trader-dom-countdown', clockMode: 'canvas-visible-countdown',
        clockText: clean(payload.text || `${seconds}s`), clockToken: clean(payload.text || `${seconds}s`), confidence: 99,
        frameHost: host, at: Date.now()
      });
    } finally { canvasBusy = false; }
  }
  window.addEventListener('message', event => {
    if (event.data?.source !== 'ATS_CANVAS_CANDLE_COUNTDOWN') return;
    acceptCanvasCountdown(event.data.payload || {}).catch(() => {});
  });

  let busy = false, lastKey = '', lastAt = 0;
  async function tick() {
    if (busy) return;
    busy = true;
    try {
      const response = await sendMessage({ type: 'ATS_READ_SCANNER_STATE' });
      const state = response?.state || null;
      if (!state?.license || !['active','valid'].includes(String(state.license.status || '').toLowerCase())) return;
      const focus = state.diagnostics?.focusedAsset || null;
      if (!focus?.asset || focus.reliable !== true || focus.chartScoped !== true || focus.trustedChartFrame !== true) return;
      if (String(focus.frameHost || '').toLowerCase() !== host) return;
      const controls = state.platformControls?.observed || {};
      const controlsFresh = Number(state.platformControls?.checkedAt || 0) > 0 && Date.now() - Number(state.platformControls.checkedAt) < 5000;
      const expiration = clean(controls.expiration || state.targetExpiration || state.expiration || '') || null;
      const chartTf = selectedChartTf();
      const cycleTf = (controlsFresh ? tf(controls.timeframe) : null) || chartTf || tf(state.analysisTimeframe || state.timeframe) || 'M1';
      const domClock = exactDomCountdown(cycleTf);

      // Never let the diagnostic/fallback writer clobber an exact clock that was
      // just published by the network bridge or the visible CasaTrade countdown.
      if (!domClock && freshExactClock(state, focus, cycleTf)) return;
      if (!domClock && Date.now() - canvasVerifiedAt < 2300) return;

      const boundary = !domClock ? currentStateBoundary(state, focus, cycleTf) : null;
      const diagnostic = derivedCountdown(cycleTf);
      const payload = domClock ? {
        type: 'ATS_MARKET_CLOCK_V2', asset: focus.asset, timeframe: cycleTf,
        secondsRemaining: domClock.seconds, expiration, available: true, verified: true, operational: true,
        clockRole: 'candle-close', clockSource: 'trader-dom-countdown',
        clockMode: domClock.expirySemantic ? 'platform-expiry-countdown' : domClock.chartScoped ? 'chart-geometry-exact' : 'dom-exact',
        clockText: domClock.text, clockToken: domClock.token, confidence: domClock.expirySemantic ? 96 : 99, frameHost: host, at: Date.now()
      } : boundary ? {
        type: 'ATS_MARKET_CLOCK_V2', asset: focus.asset, timeframe: cycleTf,
        secondsRemaining: boundary.seconds, expiration, available: true, verified: true, operational: true,
        clockRole: 'candle-close', clockSource: 'network-server-cycle', clockMode: 'state-current-candle-boundary',
        clockText: 'Fechamento confirmado pela vela atual recebida da CasaTrade', clockToken: `${boundary.seconds}s`,
        confidence: 92, frameHost: host, at: Date.now()
      } : {
        type: 'ATS_MARKET_CLOCK_V2', asset: focus.asset, timeframe: cycleTf,
        secondsRemaining: diagnostic, expiration, available: true, verified: false, operational: true,
        clockRole: 'candle-close', clockSource: 'platform-cycle-derived', clockMode: 'bounded-local-fallback',
        clockText: `Estimativa temporária ${diagnostic}s — relógio exato ainda não exposto pela CasaTrade`, clockToken: `~${diagnostic}s`,
        confidence: 55, frameHost: host, at: Date.now()
      };
      const key = `${payload.asset}|${cycleTf}|${payload.secondsRemaining}|${payload.available}|${payload.verified}|${payload.clockMode}`;
      if (key === lastKey && Date.now() - lastAt < 700) return;
      lastKey = key; lastAt = Date.now(); await sendMessage(payload);
    } finally { busy = false; }
  }
  setInterval(tick, 650); tick();
})();
