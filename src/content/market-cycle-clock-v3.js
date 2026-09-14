(() => {
  if (globalThis.__ATS_MARKET_CLOCK_SYNC__) return;
  globalThis.__ATS_MARKET_CLOCK_SYNC__ = true;

  const clean = v => String(v ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  const fold = v => clean(v).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const host = String(location.hostname || '').toLowerCase().replace(/\.$/, '');
  const traderHost = h => h === 'casatraders.online' || h.endsWith('.casatraders.online') || h === 'ivcasatraders.online' || h.endsWith('.ivcasatraders.online');
  if (!traderHost(host)) return;

  const tf = value => {
    const s = fold(value).replace(/\s+/g, '');
    let m = s.match(/^s(\d{1,5})$/) || s.match(/^(\d{1,5})(?:s|seg|segundo|segundos)$/);
    if (m && Number(m[1]) > 0) return `S${Number(m[1])}`;
    m = s.match(/^m(\d{1,4})$/) || s.match(/^(\d{1,4})(?:m|min|minuto|minutos)$/);
    if (m && Number(m[1]) > 0) return `M${Number(m[1])}`;
    m = s.match(/^h(\d{1,3})$/) || s.match(/^(\d{1,3})h$/);
    if (m && Number(m[1]) > 0) return `H${Number(m[1])}`;
    m = s.match(/^(\d{1,3}):(\d{2})$/);
    if (m) {
      const sec = Number(m[1]) * 60 + Number(m[2]);
      return sec > 0 && sec % 60 === 0 ? `M${sec / 60}` : sec > 0 ? `S${sec}` : null;
    }
    return null;
  };
  const secondsFor = value => {
    const x = tf(value) || 'M1';
    if (x[0] === 'S') return Number(x.slice(1));
    if (x[0] === 'M') return Number(x.slice(1)) * 60;
    if (x[0] === 'H') return Number(x.slice(1)) * 3600;
    return 60;
  };

  function visible(el) {
    if (!el || !(el instanceof Element)) return false;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity || 1) > 0;
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
      if (/expira|expiry|duration|hora de compra/.test(context)) score -= 160;
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
      if (!own || own.length > 90) continue;
      const ctx = fold(`${own} ${el.parentElement?.innerText || ''}`).slice(0, 260);
      if (/hora de compra|buy time|entry time|expira|expiry|expiration|duration|duracao/.test(ctx)) continue;
      if (!/vela|candle|remaining|restante|countdown|timer|fechamento/.test(ctx)) continue;
      const candidates = [];
      for (const m of own.matchAll(/\b(\d{1,3}):(\d{2})\b/g)) candidates.push({ sec: Number(m[1]) * 60 + Number(m[2]), token: m[0] });
      for (const m of own.matchAll(/\b(\d{1,5})\s*(?:s|seg|segundo|segundos)\b/gi)) candidates.push({ sec: Number(m[1]), token: m[0] });
      for (const c of candidates) if (c.sec >= 0 && c.sec <= limit + 2) rows.push({ ...c, text: own });
    }
    rows.sort((a, b) => a.sec - b.sec);
    return rows[0] || null;
  }

  function derivedCountdown(cycleTf, state) {
    const duration = secondsFor(cycleTf);
    const server = Number(state?.serverTime);
    const now = Number.isFinite(server) && server > 1e12 && Math.abs(Date.now() - server) < 120000 ? server : Date.now();
    const durationMs = duration * 1000;
    const elapsed = ((now % durationMs) + durationMs) % durationMs;
    let sec = Math.ceil((durationMs - elapsed) / 1000);
    if (!Number.isFinite(sec) || sec <= 0 || sec > duration) sec = duration;
    return { sec, token: `${sec}s`, text: `Ciclo ${cycleTf} pela duração selecionada na CasaTrade` };
  }

  let busy = false, lastKey = '', lastAt = 0;
  async function tick() {
    if (busy) return;
    busy = true;
    try {
      const response = await chrome.runtime.sendMessage({ type: 'ATS_READ_SCANNER_STATE' }).catch(() => null);
      const state = response?.state || null;
      if (!state?.license || !['active', 'valid'].includes(String(state.license.status || '').toLowerCase())) return;
      const focus = state.diagnostics?.focusedAsset || null;
      if (!focus?.asset || String(focus.frameHost || '').toLowerCase() !== host || focus.embeddedTrader !== true) return;

      const controls = state.platformControls?.observed || {};
      const checkedAt = Number(state.platformControls?.checkedAt || 0);
      const controlsFresh = checkedAt > 0 && Date.now() - checkedAt < 5000;
      const expiration = clean(controls.expiration || state.targetExpiration || state.expiration || '') || null;
      const expirationTf = controlsFresh ? tf(expiration) : null;
      const controlTf = controlsFresh ? tf(controls.timeframe) : null;
      const chartTf = selectedChartTf();
      const stateTf = tf(state.analysisTimeframe || state.timeframe);
      const platformTf = expirationTf || controlTf;
      const cycleTf = platformTf || chartTf || stateTf || 'M1';

      // A DOM timer is valid only when the visible chart explicitly agrees with the
      // selected CasaTrade cycle. Otherwise use the selected duration itself.
      const dom = chartTf === cycleTf ? exactDomCountdown(cycleTf) : null;
      const clock = dom || derivedCountdown(cycleTf, state);
      const mode = dom ? 'dom-exact' : 'platform-cycle-derived';
      const payload = {
        type: 'ATS_MARKET_CLOCK_V2', asset: focus.asset, timeframe: cycleTf,
        secondsRemaining: clock.sec, expiration, available: true, verified: true,
        clockRole: 'candle-close', clockSource: 'trader-dom-countdown',
        clockMode: mode, clockText: clock.text, clockToken: clock.token,
        confidence: dom ? 99 : 86, frameHost: host, at: Date.now()
      };
      const key = `${payload.asset}|${cycleTf}|${payload.secondsRemaining}|${expiration || ''}|${mode}`;
      if (key === lastKey && Date.now() - lastAt < 650) return;
      lastKey = key; lastAt = Date.now();
      await chrome.runtime.sendMessage(payload).catch(() => null);
    } finally { busy = false; }
  }

  setInterval(tick, 500);
  tick();
})();
