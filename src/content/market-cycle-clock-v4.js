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
    const x = tf(value);
    if (!x) return null;
    if (x[0] === 'S') return Number(x.slice(1));
    if (x[0] === 'M') return Number(x.slice(1)) * 60;
    if (x[0] === 'H') return Number(x.slice(1)) * 3600;
    return null;
  }
  function visible(el) {
    if (!el || !(el instanceof Element)) return false;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity || 1) > 0;
  }

  let elementCache = [], elementCacheAt = 0;
  function nodes(limit = 6500) {
    const now = Date.now();
    if (elementCache.length && now - elementCacheAt < 450) return elementCache.slice(0, limit);
    const out = [], roots = [document], seen = new Set();
    while (roots.length && out.length < 7000) {
      const root = roots.shift();
      if (!root || seen.has(root)) continue;
      seen.add(root);
      let rows = [];
      try { rows = [...root.querySelectorAll('*')]; } catch {}
      for (const el of rows) {
        out.push(el);
        if (out.length >= 7000) break;
        if (el.shadowRoot) roots.push(el.shadowRoot);
      }
    }
    elementCache = out;
    elementCacheAt = now;
    return out.slice(0, limit);
  }

  function chartRect() {
    const rows = [];
    for (const el of nodes(4200)) {
      if (!visible(el)) continue;
      const tag = String(el.tagName || '').toLowerCase();
      const meta = `${el.id || ''} ${el.className || ''} ${el.getAttribute?.('data-testid') || ''}`.toLowerCase();
      if (tag !== 'canvas' && tag !== 'svg' && !/chart|candle|graph|tradingview|plot/.test(meta)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 180 || r.height < 120) continue;
      let score = r.width * r.height;
      if (tag === 'canvas') score *= 1.8;
      if (/chart|candle|tradingview/.test(meta)) score *= 1.25;
      rows.push({ rect: r, score });
    }
    rows.sort((a, b) => b.score - a.score);
    return rows[0]?.rect || null;
  }

  function selectedChartTf() {
    const rows = [];
    for (const el of nodes(5000)) {
      if (!visible(el)) continue;
      const label = clean(el.getAttribute?.('aria-label') || el.getAttribute?.('title') || el.innerText || el.textContent || '');
      if (!label || label.length > 28) continue;
      const value = tf(label);
      if (!value) continue;
      const flags = `${el.className || ''} ${el.getAttribute?.('aria-selected') || ''} ${el.getAttribute?.('aria-current') || ''} ${el.getAttribute?.('data-state') || ''}`;
      const context = fold(`${flags} ${el.parentElement?.innerText || ''}`);
      let score = /true|active|selected|current|checked/i.test(flags) ? 190 : 0;
      if (/vela|candle|timeframe|periodo|period|grafico|gráfico/.test(context)) score += 90;
      if (/expira|expiry|expiration|duration|duracao|hora de compra|buy time|entry time/.test(context)) score -= 230;
      rows.push({ value, score });
    }
    rows.sort((a, b) => b.score - a.score);
    return rows[0]?.score > 0 ? rows[0].value : null;
  }

  function inOrNearChart(rect, chart) {
    if (!chart) return false;
    const padX = Math.max(70, chart.width * .12);
    const padY = Math.max(45, chart.height * .10);
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    return cx >= chart.left - padX && cx <= chart.right + padX && cy >= chart.top - padY && cy <= chart.bottom + padY;
  }

  function exactDomCountdown(cycleTf) {
    const limit = secondsFor(cycleTf);
    if (!limit) return null;
    const chart = chartRect(), rows = [];
    for (const el of nodes(7000)) {
      if (!visible(el)) continue;
      const own = clean(el.getAttribute?.('aria-label') || el.getAttribute?.('aria-valuetext') || el.getAttribute?.('title') || el.innerText || el.textContent || '');
      if (!own || own.length > 100) continue;
      const parentText = clean(el.parentElement?.innerText || el.parentElement?.textContent || '');
      const context = fold(`${own} ${parentText} ${el.id || ''} ${el.className || ''}`).slice(0, 360);
      if (/hora de compra|buy time|entry time|duration|duracao|tempo da operacao|tempo de operação/.test(context)) continue;
      const values = [];
      for (const match of own.matchAll(/\b(\d{1,3}):([0-5]\d)\b/g)) values.push({ seconds: Number(match[1]) * 60 + Number(match[2]), token: match[0] });
      for (const match of own.matchAll(/\b(\d{1,5})\s*(?:s|seg|segundo|segundos)\b/gi)) values.push({ seconds: Number(match[1]), token: match[0] });
      if (!values.length) continue;
      const rect = el.getBoundingClientRect();
      const chartScoped = inOrNearChart(rect, chart);
      const candleSemantic = /vela|candle|remaining|restante|countdown|timer|fechamento|close/.test(context);
      const expirySemantic = /expira|expiry|expiration/.test(context);
      const colonOnly = /^\d{1,3}:[0-5]\d$/.test(own);
      // Expiration is a different control. Never let "5 seg" / "1 min"
      // from the expiration selector become the candle countdown.
      if (expirySemantic && !candleSemantic) continue;
      // On compact/tablet CasaTrade layouts the visible candle clock can be a
      // plain DOM token such as "00:51" without useful chart classes. Keep it
      // as a low-confidence candidate; verifiedDomCountdown still requires
      // real second-by-second progression before it becomes authoritative.
      if (!candleSemantic && !chartScoped && !colonOnly) continue;
      for (const value of values) {
        if (value.seconds < 0 || value.seconds > limit + 2) continue;
        let score = chartScoped ? 230 : 0;
        if (candleSemantic) score += 180;
        if (/vela|candle|fechamento|close/.test(context)) score += 100;
        if (/remaining|restante|countdown|timer/.test(context)) score += 55;
        if (expirySemantic) score -= 45;
        if (colonOnly) score += chartScoped || candleSemantic ? 35 : 90;
        rows.push({ ...value, text: own, score, chartScoped, expirySemantic, colonOnly });
      }
    }
    const now = Date.now();
    const previousSeconds = Number(domProbe?.seconds);
    const previousAt = Number(domProbe?.at || 0);
    const rolloverWindow = Number.isFinite(previousSeconds)
      && previousSeconds <= 2
      && previousAt > 0
      && now - previousAt > 180
      && now - previousAt < 4500;
    if (rolloverWindow) {
      const rolled = rows
        .filter(row => row.seconds >= limit - 2 && row.seconds <= limit + 1)
        .sort((a, b) => b.score - a.score)[0];
      if (rolled) return rolled;
    }
    rows.sort((a, b) => b.score - a.score || a.seconds - b.seconds);
    return rows[0] || null;
  }

  let domProbe = null;
  let domVerifiedAt = 0;
  function verifiedDomCountdown(cycleTf) {
    const candidate = exactDomCountdown(cycleTf);
    if (!candidate) {
      // CasaTrade can briefly destroy/recreate the countdown node. Keep the
      // progression reference, but never refresh authority without a new real
      // countdown sample.
      if (!domProbe || Date.now() - Number(domProbe.observedAt || domProbe.at || 0) >= 9000) domProbe = null;
      return null;
    }

    const duration = secondsFor(cycleTf);
    const now = Date.now();
    const previous = domProbe;
    const sameTf = previous?.timeframe === cycleTf;

    if (!previous || !sameTf) {
      domProbe = {
        timeframe: cycleTf,
        seconds: candidate.seconds,
        changedAt: now,
        observedAt: now,
        text: candidate.text
      };
      return null;
    }

    if (Number(previous.seconds) === Number(candidate.seconds)) {
      domProbe = {
        ...previous,
        observedAt: now,
        text: candidate.text
      };
      return now - domVerifiedAt < 3000 ? candidate : null;
    }

    // Measure progression from the last DISTINCT second, not from the last
    // polling tick. This survives CasaTrade render gaps without treating a
    // delayed multi-second drop as a false clock.
    const delta = now - Number(previous.changedAt || previous.observedAt || previous.at || 0);
    const drop = Number(previous.seconds) - Number(candidate.seconds);
    const progressed = delta > 200
      && delta < 6500
      && drop > 0
      && drop <= Math.max(7, Math.ceil(delta / 1000) + 2);
    const rolled = delta > 200
      && delta < 9000
      && Number(previous.seconds) <= 2
      && Number(candidate.seconds) >= duration - 8
      && (candidate.chartScoped === true || candidate.colonOnly === true);

    domProbe = {
      timeframe: cycleTf,
      seconds: candidate.seconds,
      changedAt: now,
      observedAt: now,
      text: candidate.text
    };
    if (progressed || rolled) domVerifiedAt = now;
    return now - domVerifiedAt < 3000 ? candidate : null;
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
    if (Date.now() - Number(clock.at || 0) >= 3000) return null;
    return clock;
  }

  function liveCycleTf(state = {}, controlsFresh = false) {
    const controls = state.platformControls?.observed || {};
    const controlTf = controlsFresh ? tf(controls.timeframe) : null;
    const chartTf = selectedChartTf();
    const exactTf = tf(freshExactClock(state, state.diagnostics?.focusedAsset || null, null)?.timeframe);
    const platformDiag = state.diagnostics?.platformTime || {};
    const platformTf = Number(platformDiag.at || 0) > 0 && Date.now() - Number(platformDiag.at) < 7000 ? tf(platformDiag.timeframe) : null;
    return controlTf || chartTf || exactTf || platformTf || null;
  }

  function structuredFeedTf(state = {}, focus = null) {
    const session = state.diagnostics?.marketSession || {};
    if (session.dataReady !== true || !focus?.asset) return null;
    if (!sameMarket(session.confirmedAsset || session.asset, focus.asset)) return null;
    if (!sameMarket(state.asset, focus.asset)) return null;
    return tf(state.analysisTimeframe || state.timeframe);
  }

  let stateBoundaryProbe = null;
  function currentStateBoundary(state = {}, focus = null, cycleTf = null) {
    const duration = secondsFor(cycleTf);
    if (!duration || !focus?.asset) return null;
    const session = state.diagnostics?.marketSession || {};
    if (session.dataReady !== true) return null;
    if (!sameMarket(session.confirmedAsset || session.asset, focus.asset)) return null;
    if (!sameMarket(state.asset, focus.asset)) return null;
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
    const phase = ((openAt % durationMs) + durationMs) % durationMs;
    const alignedToBoundary = Math.min(phase, durationMs - phase) <= 2500;
    if (!alignedToBoundary || openAt > now + 1500 || now < openAt - 1500 || now >= openAt + durationMs + 1200) {
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
      const expirationAt = Number(state.platformControls?.expirationCheckedAt || state.platformControls?.observed?.observedAt?.expiration || 0);
      const expirationFresh = expirationAt > 0 && !!clean(state.platformControls?.observed?.expiration || state.targetExpiration || state.expiration || '');
      const controlsFresh = Number(state.platformControls?.checkedAt || 0) > 0 && Date.now() - Number(state.platformControls.checkedAt) < 5000;
      const cycleTf = liveCycleTf(state, controlsFresh) || structuredFeedTf(state, focus);
      const duration = secondsFor(cycleTf);
      if (!cycleTf || !duration || seconds > duration + 2) return;
      const previous = lastCanvas;
      const localDelta = previous ? observedAt - previous.at : 0;
      const drop = previous ? previous.seconds - seconds : 0;
      const progressed = !!previous && previous.cycleTf === cycleTf && localDelta > 150 && localDelta < 4500 && drop > 0 && drop <= Math.max(4, Math.ceil(localDelta / 1000) + 2);
      const rolled = !!previous && previous.cycleTf === cycleTf
        && localDelta > 150 && localDelta < 9000
        && previous.seconds <= 2
        && seconds >= duration - 8 && seconds <= duration + 1;
      lastCanvas = { seconds, at: observedAt, cycleTf };
      if (!progressed && !rolled) return;
      const expiration = expirationFresh ? clean(state.platformControls?.observed?.expiration || '') || null : null;
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

      const expirationAt = Number(state.platformControls?.expirationCheckedAt || state.platformControls?.observed?.observedAt?.expiration || 0);
      const expirationFresh = expirationAt > 0 && !!clean(state.platformControls?.observed?.expiration || state.targetExpiration || state.expiration || '');
      const controlsFresh = Number(state.platformControls?.checkedAt || 0) > 0 && Date.now() - Number(state.platformControls.checkedAt) < 5000;
      const cycleTf = liveCycleTf(state, controlsFresh) || structuredFeedTf(state, focus);
      if (!cycleTf) return;
      const expiration = expirationFresh
        ? clean(state.platformControls?.observed?.expiration || state.targetExpiration || state.expiration || '') || null
        : null;
      const domClock = verifiedDomCountdown(cycleTf);
      const boundaryClock = domClock ? null : currentStateBoundary(state, focus, cycleTf);

      if (!domClock && !boundaryClock && freshExactClock(state, focus, cycleTf)) return;
      if (!domClock && !boundaryClock && Date.now() - canvasVerifiedAt < 3000) return;

      // Preferred authority remains CasaTrade's visible progressing countdown.
      // When that token is not exposed on compact/tablet layouts, the timestamp
      // of the CURRENT structured CasaTrade candle is also an exact boundary:
      // current-candle openAt + real M1 duration = candle close. Two consecutive
      // observations of the same live candle are required before publication.
      const payload = domClock ? {
        type: 'ATS_MARKET_CLOCK_V2', asset: focus.asset, timeframe: cycleTf,
        secondsRemaining: domClock.seconds, expiration, available: true, verified: true, operational: true,
        clockRole: 'candle-close', clockSource: 'trader-dom-countdown',
        clockMode: domClock.chartScoped ? 'chart-geometry-exact' : 'dom-exact',
        clockText: domClock.text, clockToken: domClock.token, confidence: 99, frameHost: host, at: Date.now()
      } : boundaryClock ? {
        type: 'ATS_MARKET_CLOCK_V2', asset: focus.asset, timeframe: cycleTf,
        secondsRemaining: boundaryClock.seconds, expiration, available: true, verified: true, operational: true,
        clockRole: 'candle-close', clockSource: 'network-server-cycle',
        clockMode: 'structured-current-candle-boundary',
        clockText: 'Fechamento confirmado pela vela atual do feed CasaTrade',
        clockToken: `${boundaryClock.seconds}s`, confidence: 94, frameHost: host, at: Date.now()
      } : {
        type: 'ATS_MARKET_CLOCK_V2', asset: focus.asset, timeframe: cycleTf,
        secondsRemaining: null, expiration, available: false, verified: false, operational: false,
        clockRole: 'candle-close', clockSource: 'casatrade-clock-pending', clockMode: 'waiting-authoritative-clock',
        clockText: 'Aguardando countdown real da CasaTrade', clockToken: '',
        confidence: 0, frameHost: host, at: Date.now()
      };
      const key = `${payload.asset}|${cycleTf}|${payload.secondsRemaining}|${payload.available}|${payload.verified}|${payload.clockMode}`;
      if (key === lastKey && Date.now() - lastAt < 700) return;
      lastKey = key;
      lastAt = Date.now();
      await sendMessage(payload);
    } finally { busy = false; }
  }

  setInterval(tick, 650);
  tick();
})();
