(() => {
  if (globalThis.__ATS_MARKET_CYCLE_CLOCK_V3__) return;
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
    const normalized = tf(value) || 'M1';
    if (normalized[0] === 'S') return Number(normalized.slice(1));
    if (normalized[0] === 'M') return Number(normalized.slice(1)) * 60;
    if (normalized[0] === 'H') return Number(normalized.slice(1)) * 3600;
    return 60;
  }

  function visible(el) {
    if (!el || !(el instanceof Element)) return false;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0;
  }

  function selectedChartTf() {
    const rows = [];
    let nodes = [];
    try { nodes = [...document.querySelectorAll('*')].slice(0, 5000); } catch {}
    for (const el of nodes) {
      if (!visible(el)) continue;
      const text = clean(el.getAttribute?.('aria-label') || el.getAttribute?.('title') || el.innerText || el.textContent || '');
      if (!text || text.length > 28) continue;
      const value = tf(text);
      if (!value) continue;
      const flags = `${el.className || ''} ${el.getAttribute?.('aria-selected') || ''} ${el.getAttribute?.('aria-current') || ''} ${el.getAttribute?.('data-state') || ''}`;
      const context = fold(`${flags} ${el.parentElement?.innerText || ''}`);
      let score = /true|active|selected|current|checked/i.test(flags) ? 180 : 0;
      if (/vela|candle|timeframe|periodo|period/.test(context)) score += 90;
      if (/expira|expiry|duration|hora de compra/.test(context)) score -= 180;
      rows.push({ value, score });
    }
    rows.sort((a, b) => b.score - a.score);
    return rows[0]?.score > 0 ? rows[0].value : null;
  }

  function exactDomCountdown(cycleTf) {
    const limit = secondsFor(cycleTf);
    const rows = [];
    let nodes = [];
    try { nodes = [...document.querySelectorAll('*')].slice(0, 6500); } catch {}
    for (const el of nodes) {
      if (!visible(el)) continue;
      const own = clean(el.getAttribute?.('aria-label') || el.getAttribute?.('aria-valuetext') || el.getAttribute?.('title') || el.innerText || el.textContent || '');
      if (!own || own.length > 100) continue;
      const parentText = clean(el.parentElement?.innerText || el.parentElement?.textContent || '');
      const context = fold(`${own} ${parentText}`).slice(0, 300);
      if (/hora de compra|buy time|entry time|expira|expiry|expiration|duration|duracao/.test(context)) continue;
      if (!/vela|candle|remaining|restante|countdown|timer|fechamento|close/.test(context)) continue;
      const values = [];
      for (const match of own.matchAll(/\b(\d{1,3}):(\d{2})\b/g)) values.push({ seconds: Number(match[1]) * 60 + Number(match[2]), token: match[0] });
      for (const match of own.matchAll(/\b(\d{1,5})\s*(?:s|seg|segundo|segundos)\b/gi)) values.push({ seconds: Number(match[1]), token: match[0] });
      for (const value of values) {
        if (value.seconds < 0 || value.seconds > limit + 2) continue;
        const rect = el.getBoundingClientRect();
        let score = 100;
        if (/vela|candle|fechamento|close/.test(context)) score += 120;
        if (/remaining|restante|countdown|timer/.test(context)) score += 60;
        if (rect.width < innerWidth * .5) score += 10;
        rows.push({ ...value, text: own, score });
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
      if (!state?.license || !['active', 'valid'].includes(String(state.license.status || '').toLowerCase())) return;
      const focus = state.diagnostics?.focusedAsset || null;
      if (!focus?.asset || focus.reliable !== true || focus.chartScoped !== true || focus.embeddedTrader !== true) return;
      if (String(focus.frameHost || '').toLowerCase() !== host) return;

      const controls = state.platformControls?.observed || {};
      const controlsFresh = Number(state.platformControls?.checkedAt || 0) > 0 && Date.now() - Number(state.platformControls.checkedAt) < 5000;
      const expiration = clean(controls.expiration || state.targetExpiration || state.expiration || '') || null;
      const expirationTf = controlsFresh ? tf(expiration) : null;
      const controlTf = controlsFresh ? tf(controls.timeframe) : null;
      const chartTf = selectedChartTf();
      const stateTf = tf(state.analysisTimeframe || state.timeframe);
      const cycleTf = expirationTf || controlTf || chartTf || stateTf || 'M1';

      // A visual countdown is authoritative only when the chart itself agrees with
      // the selected CasaTrade cycle. A derived value is diagnostic only: it must
      // never be labelled verified or release a trading signal.
      const domClock = chartTf === cycleTf ? exactDomCountdown(cycleTf) : null;
      const derived = derivedCountdown(cycleTf, state);
      const payload = domClock ? {
        type: 'ATS_MARKET_CLOCK_V2', asset: focus.asset, timeframe: cycleTf,
        secondsRemaining: domClock.seconds, expiration, available: true, verified: true,
        clockRole: 'candle-close', clockSource: 'trader-dom-countdown', clockMode: 'dom-exact',
        clockText: domClock.text, clockToken: domClock.token, confidence: 99, frameHost: host, at: Date.now()
      } : {
        type: 'ATS_MARKET_CLOCK_V2', asset: focus.asset, timeframe: cycleTf,
        secondsRemaining: derived, expiration, available: false, verified: false,
        clockRole: 'candle-close', clockSource: 'platform-cycle-derived', clockMode: 'diagnostic-only',
        clockText: `Estimativa ${derived}s — aguardando relógio real da CasaTrade`, clockToken: `${derived}s`,
        confidence: 0, frameHost: host, at: Date.now()
      };

      const key = `${payload.asset}|${cycleTf}|${payload.secondsRemaining}|${payload.available}|${payload.clockSource}`;
      if (key === lastKey && Date.now() - lastAt < 700) return;
      lastKey = key;
      lastAt = Date.now();
      await chrome.runtime.sendMessage(payload).catch(() => null);
    } finally {
      busy = false;
    }
  }

  setInterval(tick, 500);
  tick();
})();
