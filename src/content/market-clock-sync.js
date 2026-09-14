(() => {
  if (globalThis.__ATS_MARKET_CLOCK_SYNC__) return;
  globalThis.__ATS_MARKET_CLOCK_SYNC__ = true;

  const clean = value => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  const fold = value => clean(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const host = String(location.hostname || '').toLowerCase().replace(/\.$/, '');
  const casaHost = value => value === 'casatrade.com' || value.endsWith('.casatrade.com') || value === 'casatrade.io' || value.endsWith('.casatrade.io');
  const traderHost = value => value === 'casatraders.online' || value.endsWith('.casatraders.online') || value === 'ivcasatraders.online' || value.endsWith('.ivcasatraders.online');
  const inTraderFrame = traderHost(host);
  if (!casaHost(host) && !inTraderFrame) return;

  const visible = el => {
    if (!el || !(el instanceof Element)) return false;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0;
  };

  function deepElements(limit = 7000) {
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
    for (const el of deepElements(4500)) {
      if (!visible(el)) continue;
      const text = clean(el.getAttribute?.('aria-label') || el.innerText || el.textContent || '');
      if (!text || text.length > 24) continue;
      const tf = normalizeTf(text);
      if (!tf) continue;
      const flags = `${el.className || ''} ${el.getAttribute?.('aria-selected') || ''} ${el.getAttribute?.('aria-current') || ''} ${el.getAttribute?.('data-state') || ''}`;
      const rect = el.getBoundingClientRect();
      let score = /true|active|selected|current|checked/i.test(flags) ? 150 : 0;
      if (rect.left < innerWidth * .45) score += 20;
      if (rect.top > innerHeight * .08 && rect.top < innerHeight * .92) score += 12;
      if (inTraderFrame) score += 25;
      rows.push({ tf, score });
    }
    rows.sort((a, b) => b.score - a.score);
    return rows[0]?.tf || normalizeTf(fallback) || 'M1';
  }

  function countdownFromDom(tf) {
    const limit = timeframeSeconds(tf);
    const rows = [];
    for (const el of deepElements()) {
      if (!visible(el)) continue;
      const ownText = clean(el.getAttribute?.('aria-label') || el.getAttribute?.('aria-valuetext') || el.innerText || el.textContent || '');
      if (!ownText || ownText.length > 100) continue;
      const local = clean(`${ownText} ${el.parentElement?.innerText || ''} ${el.parentElement?.parentElement?.innerText || ''}`).slice(0, 320);
      const localFold = fold(local);
      const timerContext = /hora de compra|buy time|entry time|entrada|countdown|timer|remaining|restante|tempo|candle|vela|chart|grafico|gráfico/.test(localFold);
      const expiryContext = /expira|expiry|expiration|duration|dura[cç][aã]o|valor|amount|retorno|lucro|profit/.test(localFold);

      const candidates = [];
      for (const match of ownText.matchAll(/\b(\d{1,2}):(\d{2})\b/g)) {
        const seconds = Number(match[1]) * 60 + Number(match[2]);
        candidates.push({ seconds, kind: 'clock' });
      }
      const plain = ownText.match(/\b(\d{1,4})\s*(?:s|seg|segundo|segundos)\b/i);
      if (plain) candidates.push({ seconds: Number(plain[1]), kind: 'plain' });

      for (const candidate of candidates) {
        const seconds = candidate.seconds;
        if (!Number.isFinite(seconds) || seconds < 0 || seconds > limit + 2) continue;
        const rect = el.getBoundingClientRect();
        let score = candidate.kind === 'clock' ? 70 : 30;
        if (timerContext) score += 190;
        if (/hora de compra|buy time|entry time/.test(localFold)) score += 170;
        if (expiryContext) score -= 220;
        if (inTraderFrame) score += 90;
        if (rect.top > innerHeight * .05 && rect.top < innerHeight * .95) score += 20;
        if (rect.left > innerWidth * .20) score += 10;
        if (seconds === limit && !timerContext) score -= 100;
        rows.push({ seconds, score, text: ownText });
      }
    }
    rows.sort((a, b) => b.score - a.score);
    return rows[0] && rows[0].score >= 55 ? rows[0] : null;
  }

  function phaseCountdown(tf) {
    const span = timeframeSeconds(tf);
    const phase = (Date.now() / 1000) % span;
    const remaining = Math.ceil(span - phase);
    return Math.max(1, Math.min(span, remaining));
  }

  function expirationFromDom() {
    const rows = [];
    for (const el of deepElements()) {
      if (!visible(el)) continue;
      const text = clean(el.getAttribute?.('aria-label') || el.getAttribute?.('aria-valuetext') || el.innerText || el.textContent || '');
      if (!text || text.length > 90) continue;
      const local = clean(`${text} ${el.parentElement?.innerText || ''} ${el.parentElement?.parentElement?.innerText || ''}`).slice(0, 260);
      if (!/expira|expiry|expiration|dura[cç][aã]o|duration/i.test(local)) continue;
      const duration = local.match(/\b(\d{1,4})\s*(s|seg|segundo|segundos|m|min|minuto|minutos)\b/i);
      const absolute = local.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
      let value = null;
      if (duration) {
        const n = Number(duration[1]);
        value = /^m|min/i.test(duration[2]) ? (n === 1 ? '60s' : `${n}m`) : `${n}s`;
      } else if (absolute) {
        value = `${String(Number(absolute[1])).padStart(2, '0')}:${absolute[2]}`;
      }
      if (!value) continue;
      const flags = `${el.className || ''} ${el.getAttribute?.('aria-selected') || ''} ${el.getAttribute?.('data-state') || ''}`;
      let score = 80;
      if (/true|active|selected|current/i.test(flags)) score += 80;
      if (/expira|expiry|duration/i.test(fold(text))) score += 40;
      if (inTraderFrame) score += 20;
      rows.push({ value, score });
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
      const focus = state.diagnostics?.focusedAsset?.asset || state.asset || '';
      if (!focus) return;
      const tf = selectedTimeframe(state.analysisTimeframe || state.timeframe || 'M1');
      const domClock = countdownFromDom(tf);
      const secondsRemaining = domClock?.seconds ?? phaseCountdown(tf);
      const expiration = expirationFromDom()?.value || state.targetExpiration || state.expiration || null;
      const payload = {
        type: 'ATS_MARKET_CLOCK_V2',
        asset: focus,
        timeframe: tf,
        secondsRemaining,
        expiration,
        clockSource: domClock ? (inTraderFrame ? 'trader-dom-countdown' : 'dom-countdown') : 'timeframe-phase',
        confidence: domClock ? Math.max(inTraderFrame ? 95 : 80, Number(domClock.score || 0)) : 55,
        frameHost: host,
        at: Date.now()
      };
      const key = `${payload.asset}|${payload.timeframe}|${payload.secondsRemaining}|${payload.expiration || ''}|${payload.clockSource}`;
      if (key === lastKey && Date.now() - lastSentAt < 650) return;
      lastKey = key;
      lastSentAt = Date.now();
      await chrome.runtime.sendMessage(payload).catch(() => null);
    } finally {
      busy = false;
    }
  }

  setInterval(tick, 300);
  tick();
})();
