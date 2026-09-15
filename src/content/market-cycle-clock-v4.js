(() => {
  if (globalThis.__ATS_MARKET_CYCLE_CLOCK_V4__) return;
  globalThis.__ATS_MARKET_CYCLE_CLOCK_V4__ = true;
  globalThis.__ATS_MARKET_CYCLE_CLOCK_V3__ = true;
  globalThis.__ATS_MARKET_CLOCK_SYNC__ = true;

  const clean = value => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  const fold = value => clean(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const host = String(location.hostname || '').toLowerCase().replace(/\.$/, '');
  const traderHost = value => value === 'casatraders.online' || value.endsWith('.casatraders.online') || value === 'ivcasatraders.online' || value.endsWith('.ivcasatraders.online');
  if (!traderHost(host)) return;

  function tf(value) {
    const s = fold(value).replace(/\s+/g, '');
    let m = s.match(/^s(\d{1,5})$/) || s.match(/^(\d{1,5})(?:s|seg|segundo|segundos)$/);
    if (m && Number(m[1]) > 0) return `S${Number(m[1])}`;
    m = s.match(/^m(\d{1,4})$/) || s.match(/^(\d{1,4})(?:m|min|minuto|minutos)$/);
    if (m && Number(m[1]) > 0) return `M${Number(m[1])}`;
    m = s.match(/^h(\d{1,3})$/) || s.match(/^(\d{1,3})h$/);
    if (m && Number(m[1]) > 0) return `H${Number(m[1])}`;
    m = s.match(/^(\d{1,3}):(\d{2})$/);
    if (m) {
      const seconds = Number(m[1]) * 60 + Number(m[2]);
      return seconds > 0 && seconds % 60 === 0 ? `M${seconds / 60}` : seconds > 0 ? `S${seconds}` : null;
    }
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
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity || 1) > 0;
  }

  let elementCache = [];
  let elementCacheAt = 0;
  function nodes(limit = 6500) {
    const now = Date.now();
    if (elementCache.length && now - elementCacheAt < 450) return elementCache.slice(0, limit);
    const out = [];
    const roots = [document];
    const seen = new Set();
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
      const text = clean(el.getAttribute?.('aria-label') || el.getAttribute?.('title') || el.innerText || el.textContent || '');
      if (!text || text.length > 28) continue;
      const value = tf(text);
      if (!value) continue;
      const flags = `${el.className || ''} ${el.getAttribute?.('aria-selected') || ''} ${el.getAttribute?.('aria-current') || ''} ${el.getAttribute?.('data-state') || ''}`;
      const context = fold(`${flags} ${el.parentElement?.innerText || ''}`);
      let score = /true|active|selected|current|checked/i.test(flags) ? 190 : 0;
      if (/vela|candle|timeframe|periodo|period/.test(context)) score += 90;
      if (/expira|expiry|duration|hora de compra|buy time|entry time/.test(context)) score -= 190;
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
    const chart = chartRect();
    const rows = [];
    for (const el of nodes(7000)) {
      if (!visible(el)) continue;
      const own = clean(el.getAttribute?.('aria-label') || el.getAttribute?.('aria-valuetext') || el.getAttribute?.('title') || el.innerText || el.textContent || '');
      if (!own || own.length > 100) continue;
      const parentText = clean(el.parentElement?.innerText || el.parentElement?.textContent || '');
      const context = fold(`${own} ${parentText} ${el.id || ''} ${el.className || ''}`).slice(0, 340);
      if (/hora de compra|buy time|entry time|expira|expiry|expiration|duration|duracao/.test(context)) continue;

      const values = [];
      for (const match of own.matchAll(/\b(\d{1,3}):([0-5]\d)\b/g)) values.push({ seconds: Number(match[1]) * 60 + Number(match[2]), token: match[0] });
      for (const match of own.matchAll(/\b(\d{1,5})\s*(?:s|seg|segundo|segundos)\b/gi)) values.push({ seconds: Number(match[1]), token: match[0] });
      if (!values.length) continue;

      const rect = el.getBoundingClientRect();
      const chartScoped = inOrNearChart(rect, chart);
      const semantic = /vela|candle|remaining|restante|countdown|timer|fechamento|close/.test(context);
      if (!semantic && !chartScoped) continue;

      for (const value of values) {
        if (value.seconds < 0 || value.seconds > limit + 2) continue;
        let score = 0;
        if (chartScoped) score += 230;
        if (semantic) score += 180;
        if (/vela|candle|fechamento|close/.test(context)) score += 90;
        if (/remaining|restante|countdown|timer/.test(context)) score += 55;
        if (/^\d{1,3}:[0-5]\d$/.test(own)) score += 35;
        rows.push({ ...value, text: own, score, chartScoped });
      }
    }
    rows.sort((a, b) => b.score - a.score || a.seconds - b.seconds);
    return rows[0] || null;
  }

  function derivedCountdown(cycleTf, state) {
    const duration = secondsFor(cycleTf);
    const server = Number(state?.serverTime);
    const now = Number.isFinite(server) && server > 1e12 && Math.abs(Date.now() - server) < 120000 ? server : Date.now();
    const durationMs = duration * 1000;
    const elapsed = ((now % durationMs) + durationMs) % durationMs;
    let seconds = Math.ceil((durationMs - elapsed) / 1000);
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds > duration) seconds = duration;
    return seconds;
  }

  let busy = false;
  let lastKey = '';
  let lastAt = 0;
  async function tick() {
    if (busy) return;
    busy = true;
    try {
      const response = await chrome.runtime.sendMessage({ type: 'ATS_READ_SCANNER_STATE' }).catch(() => null);
      const state = response?.state || null;
      if (!state?.license || !['active','valid'].includes(String(state.license.status || '').toLowerCase())) return;
      const focus = state.diagnostics?.focusedAsset || null;
      if (!focus?.asset || focus.reliable !== true || focus.chartScoped !== true || focus.embeddedTrader !== true) return;
      if (String(focus.frameHost || '').toLowerCase() !== host) return;

      const controls = state.platformControls?.observed || {};
      const controlsFresh = Number(state.platformControls?.checkedAt || 0) > 0 && Date.now() - Number(state.platformControls.checkedAt) < 5000;
      const expiration = clean(controls.expiration || state.targetExpiration || state.expiration || '') || null;
      const chartTf = selectedChartTf();
      const cycleTf = (controlsFresh ? tf(expiration) || tf(controls.timeframe) : null)
        || chartTf || tf(state.analysisTimeframe || state.timeframe) || 'M1';
      const domClock = (!chartTf || chartTf === cycleTf) ? exactDomCountdown(cycleTf) : null;
      const diagnostic = derivedCountdown(cycleTf, state);
      const payload = domClock ? {
        type: 'ATS_MARKET_CLOCK_V2', asset: focus.asset, timeframe: cycleTf,
        secondsRemaining: domClock.seconds, expiration, available: true, verified: true,
        clockRole: 'candle-close', clockSource: 'trader-dom-countdown', clockMode: domClock.chartScoped ? 'chart-geometry-exact' : 'dom-exact',
        clockText: domClock.text, clockToken: domClock.token, confidence: 99, frameHost: host, at: Date.now()
      } : {
        type: 'ATS_MARKET_CLOCK_V2', asset: focus.asset, timeframe: cycleTf,
        secondsRemaining: diagnostic, expiration, available: false, verified: false,
        clockRole: 'candle-close', clockSource: 'platform-cycle-derived', clockMode: 'diagnostic-only',
        clockText: `Estimativa ${diagnostic}s — aguardando relógio real da CasaTrade`, clockToken: `${diagnostic}s`,
        confidence: 0, frameHost: host, at: Date.now()
      };
      const key = `${payload.asset}|${cycleTf}|${payload.secondsRemaining}|${payload.available}|${payload.clockMode}`;
      if (key === lastKey && Date.now() - lastAt < 700) return;
      lastKey = key; lastAt = Date.now();
      await chrome.runtime.sendMessage(payload).catch(() => null);
    } finally { busy = false; }
  }

  setInterval(tick, 650);
  tick();
})();
