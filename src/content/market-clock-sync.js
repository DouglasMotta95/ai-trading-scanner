(() => {
  if (globalThis.__ATS_MARKET_CLOCK_SYNC__) return;
  globalThis.__ATS_MARKET_CLOCK_SYNC__ = true;

  const clean = value => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  const fold = value => clean(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const host = String(location.hostname || '').toLowerCase().replace(/\.$/, '');
  const traderHost = value => value === 'casatraders.online' || value.endsWith('.casatraders.online') || value === 'ivcasatraders.online' || value.endsWith('.ivcasatraders.online');
  if (!traderHost(host)) return;

  const visible = el => {
    if (!el || !(el instanceof Element)) return false;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0;
  };

  function deepElements(limit = 6500) {
    const out = [];
    const roots = [document];
    const seen = new Set();
    while (roots.length && out.length < limit) {
      const root = roots.shift();
      if (!root || seen.has(root)) continue;
      seen.add(root);
      let nodes = [];
      try { nodes = [...root.querySelectorAll('*')]; } catch {}
      for (const node of nodes) {
        out.push(node);
        if (out.length >= limit) break;
        if (node.shadowRoot) roots.push(node.shadowRoot);
      }
    }
    return out;
  }

  const normalizeTf = value => {
    const s = fold(value).replace(/\s+/g, '');
    let m = s.match(/^m(1|2|5|15|30)$/); if (m) return `M${m[1]}`;
    m = s.match(/^(1|2|5|15|30)(?:m|min|minuto|minutos)$/); if (m) return `M${m[1]}`;
    m = s.match(/^s(5|15|30)$/); if (m) return `S${m[1]}`;
    m = s.match(/^(5|15|30)(?:s|seg|segundo|segundos)$/); if (m) return `S${m[1]}`;
    if (/^(h1|1h|60m|60min)$/.test(s)) return 'H1';
    return null;
  };

  const timeframeSeconds = value => {
    const tf = normalizeTf(value) || 'M1';
    if (tf.startsWith('S')) return Math.max(1, Number(tf.slice(1)) || 60);
    if (tf.startsWith('M')) return Math.max(1, Number(tf.slice(1)) * 60 || 60);
    if (tf.startsWith('H')) return Math.max(1, Number(tf.slice(1)) * 3600 || 3600);
    return 60;
  };

  function selectedTimeframe(fallback = 'M1') {
    const rows = [];
    for (const el of deepElements(4000)) {
      if (!visible(el)) continue;
      const text = clean(el.getAttribute?.('aria-label') || el.getAttribute?.('title') || el.innerText || el.textContent || '');
      if (!text || text.length > 28) continue;
      const tf = normalizeTf(text);
      if (!tf) continue;
      const flags = `${el.className || ''} ${el.getAttribute?.('aria-selected') || ''} ${el.getAttribute?.('aria-current') || ''} ${el.getAttribute?.('data-state') || ''}`;
      const context = fold(`${flags} ${el.parentElement?.innerText || ''}`);
      let score = /true|active|selected|current|checked/i.test(flags) ? 180 : 0;
      if (/vela|candle|timeframe|periodo|period/.test(context)) score += 90;
      if (/expira|expiry|duration|hora de compra/.test(context)) score -= 120;
      rows.push({ tf, score });
    }
    rows.sort((a, b) => b.score - a.score);
    return rows[0]?.score > 0 ? rows[0].tf : (normalizeTf(fallback) || 'M1');
  }

  function countdownFromDom(tf) {
    const limit = timeframeSeconds(tf);
    const rows = [];
    for (const el of deepElements()) {
      if (!visible(el)) continue;
      const own = clean(el.getAttribute?.('aria-label') || el.getAttribute?.('aria-valuetext') || el.getAttribute?.('title') || el.innerText || el.textContent || '');
      if (!own || own.length > 120) continue;
      const local = clean(`${own} ${el.parentElement?.innerText || ''} ${el.parentElement?.parentElement?.innerText || ''}`).slice(0, 360);
      const ctx = fold(local);
      const exactContext = /hora de compra|buy time|entry time|tempo da vela|candle time|tempo restante|remaining|restante|countdown|timer/.test(ctx);
      const expiryContext = /expira|expiry|expiration|duration|duracao|duração|valor|amount|retorno|lucro|profit/.test(ctx);
      if (!exactContext || expiryContext) continue;

      const candidates = [];
      for (const match of local.matchAll(/\b(\d{1,2}):(\d{2})\b/g)) {
        candidates.push({ seconds: Number(match[1]) * 60 + Number(match[2]), token: match[0] });
      }
      for (const match of local.matchAll(/\b(\d{1,4})\s*(?:s|seg|segundo|segundos)\b/gi)) {
        candidates.push({ seconds: Number(match[1]), token: match[0] });
      }

      for (const candidate of candidates) {
        if (!Number.isFinite(candidate.seconds) || candidate.seconds < 0 || candidate.seconds > limit + 2) continue;
        let score = 220;
        if (/hora de compra|buy time|entry time/.test(ctx)) score += 260;
        if (/tempo da vela|candle time|countdown|remaining|restante/.test(ctx)) score += 150;
        const rect = el.getBoundingClientRect();
        if (rect.width < innerWidth * .8) score += 30;
        rows.push({ seconds: candidate.seconds, score, token: candidate.token, text: own });
      }
    }
    rows.sort((a, b) => b.score - a.score);
    return rows[0] || null;
  }

  function expirationFromDom() {
    const rows = [];
    for (const el of deepElements()) {
      if (!visible(el)) continue;
      const own = clean(el.getAttribute?.('aria-label') || el.getAttribute?.('aria-valuetext') || el.getAttribute?.('title') || el.innerText || el.textContent || '');
      if (!own || own.length > 120) continue;
      const local = clean(`${own} ${el.parentElement?.innerText || ''} ${el.parentElement?.parentElement?.innerText || ''}`).slice(0, 360);
      const ctx = fold(local);
      if (!/expira|expiry|expiration|duracao|duração|duration/.test(ctx)) continue;
      const duration = local.match(/\b(\d{1,4})\s*(s|seg|segundo|segundos|m|min|minuto|minutos)\b/i);
      const absolute = local.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
      let value = null;
      if (duration) {
        const n = Number(duration[1]);
        value = /^m|min/i.test(duration[2]) ? (n === 1 ? '60s' : `${n}m`) : `${n}s`;
      } else if (absolute) {
        value = `${String(Number(absolute[1])).padStart(2, '0')}:${absolute[2]}`;
      }
      if (value) rows.push({ value, score: /expira|expiry|duration/.test(fold(own)) ? 180 : 110 });
    }
    rows.sort((a, b) => b.score - a.score);
    return rows[0] || null;
  }

  let busy = false;
  let lastKey = '';
  let lastSentAt = 0;

  async function tick() {
    if (busy) return;
    busy = true;
    try {
      const response = await chrome.runtime.sendMessage({ type: 'ATS_READ_SCANNER_STATE' }).catch(() => null);
      const state = response?.state || null;
      if (!state?.license || !['active','valid'].includes(String(state.license.status || '').toLowerCase())) return;
      const focusMeta = state.diagnostics?.focusedAsset || null;
      const focus = focusMeta?.asset || '';
      if (!focus || String(focusMeta?.frameHost || '').toLowerCase() !== host || focusMeta?.embeddedTrader !== true) return;

      const tf = selectedTimeframe(state.analysisTimeframe || state.timeframe || 'M1');
      const domClock = countdownFromDom(tf);
      const expiration = expirationFromDom()?.value || null;
      const payload = domClock ? {
        type: 'ATS_MARKET_CLOCK_V2',
        asset: focus,
        timeframe: tf,
        secondsRemaining: domClock.seconds,
        expiration,
        available: true,
        verified: true,
        clockSource: 'trader-dom-countdown',
        clockText: domClock.text,
        clockToken: domClock.token,
        confidence: Math.max(98, Number(domClock.score || 0)),
        frameHost: host,
        at: Date.now()
      } : {
        type: 'ATS_MARKET_CLOCK_V2',
        asset: focus,
        timeframe: tf,
        secondsRemaining: null,
        expiration,
        available: false,
        verified: false,
        clockSource: 'trader-dom-unavailable',
        confidence: 0,
        frameHost: host,
        at: Date.now()
      };

      const key = `${payload.asset}|${payload.timeframe}|${payload.secondsRemaining ?? 'x'}|${payload.expiration || ''}|${payload.clockSource}`;
      if (key === lastKey && Date.now() - lastSentAt < 700) return;
      lastKey = key;
      lastSentAt = Date.now();
      await chrome.runtime.sendMessage(payload).catch(() => null);
    } finally {
      busy = false;
    }
  }

  setInterval(tick, 250);
  tick();
})();
