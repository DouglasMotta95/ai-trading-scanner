(() => {
  if (globalThis.__ATS_ANALYSIS_VISUAL_OVERLAY_V2__) return;
  globalThis.__ATS_ANALYSIS_VISUAL_OVERLAY_V2__ = true;
  globalThis.__ATS_ANALYSIS_VISUAL_OVERLAY__ = true;

  const PREF_KEY = 'atsScannerUiPreferences';
  const DEFAULT_PREFS = { overlayEnabled: false, possibleSoundEnabled: false, confirmSoundEnabled: false };
  const host = String(location.hostname || '').toLowerCase().replace(/\.$/, '');
  const traderHost = value => value === 'casatraders.online' || value.endsWith('.casatraders.online') || value === 'ivcasatraders.online' || value.endsWith('.ivcasatraders.online');
  const allowed = value => value === 'casatrade.com' || value.endsWith('.casatrade.com') || value === 'casatrade.io' || value.endsWith('.casatrade.io') || traderHost(value);
  const inTraderFrame = traderHost(host);
  if (!allowed(host)) return;
  const sendMessage = globalThis.__ATS_SEND_MESSAGE__;
  if (typeof sendMessage !== 'function') return;

  const num = value => value == null || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null;
  const marketId = value => {
    const raw = String(value || '').normalize('NFKC').toUpperCase().replace(/\s+/g, ' ').trim();
    if (!raw) return '';
    const otc = /(?:\(|\b|[_-])OTC(?:\)|\b)?/i.test(raw);
    const pair = raw.match(/\b([A-Z0-9]{2,20})\s*[\/_-]\s*([A-Z0-9]{2,12})/i);
    return pair ? `${pair[1]}/${pair[2]}${otc ? ' (OTC)' : ''}` : raw;
  };
  const sameMarket = (a, b) => !!marketId(a) && marketId(a) === marketId(b);
  const visible = el => {
    if (!el || !(el instanceof Element)) return false;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity || 1) > 0;
  };

  let elementCache = [];
  let elementCacheAt = 0;
  function deepElements(limit = 5000) {
    const now = Date.now();
    if (elementCache.length && now - elementCacheAt < 650) return elementCache.slice(0, limit);
    const out = [];
    const roots = [document];
    const seen = new Set();
    while (roots.length && out.length < 6000) {
      const root = roots.shift();
      if (!root || seen.has(root)) continue;
      seen.add(root);
      let nodes = [];
      try { nodes = [...root.querySelectorAll('*')]; } catch {}
      for (const node of nodes) {
        out.push(node);
        if (out.length >= 6000) break;
        if (node.shadowRoot) roots.push(node.shadowRoot);
      }
    }
    elementCache = out;
    elementCacheAt = now;
    return out.slice(0, limit);
  }

  function fallbackChartRect() {
    if (!allowed(host)) return null;
    const left = Math.max(40, innerWidth * .045);
    const top = Math.max(55, innerHeight * .08);
    const right = Math.max(left + 280, innerWidth * .82);
    const bottom = Math.max(top + 190, innerHeight * .90);
    return { left, top, right, bottom, width: right - left, height: bottom - top };
  }

  function chartRect() {
    const rows = [];
    for (const el of deepElements()) {
      if (!visible(el)) continue;
      const tag = String(el.tagName || '').toLowerCase();
      const meta = `${el.className || ''} ${el.id || ''} ${el.getAttribute?.('data-testid') || ''}`.toLowerCase();
      if (tag !== 'canvas' && tag !== 'svg' && !/chart|candle|graph|trading|plot/.test(meta)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 240 || r.height < 150) continue;
      let score = r.width * r.height;
      if (tag === 'canvas') score *= 2.2;
      if (/chart|candle|trading|plot/.test(meta)) score *= 1.45;
      if (r.left < innerWidth * .15) score *= 1.15;
      rows.push({ rect: r, score });
    }
    rows.sort((a, b) => b.score - a.score);
    return rows[0]?.rect || fallbackChartRect();
  }

  function priceMapper(rect, state) {
    const currentPrice = num(state?.price);
    const labels = [];
    for (const el of deepElements(3000)) {
      if (!visible(el)) continue;
      const raw = String(el.textContent || el.innerText || '').trim();
      if (!/^\d{1,8}(?:[.,]\d{2,10})$/.test(raw)) continue;
      const price = Number(raw.replace(',', '.'));
      if (!Number.isFinite(price) || price <= 0) continue;
      if (currentPrice != null && (price < currentPrice * .15 || price > currentPrice * 6)) continue;
      const r = el.getBoundingClientRect();
      const y = r.top + r.height / 2;
      if (r.left < rect.right - 190 || r.left > rect.right + 140 || y < rect.top - 12 || y > rect.bottom + 12) continue;
      labels.push({ price, y });
    }
    const unique = labels.filter((row, i, arr) => arr.findIndex(other => Math.abs(other.price - row.price) < 1e-12) === i);
    if (unique.length >= 2) {
      const meanP = unique.reduce((s, r) => s + r.price, 0) / unique.length;
      const meanY = unique.reduce((s, r) => s + r.y, 0) / unique.length;
      const denom = unique.reduce((s, r) => s + (r.price - meanP) ** 2, 0);
      if (denom > 0) {
        const slope = unique.reduce((s, r) => s + (r.price - meanP) * (r.y - meanY), 0) / denom;
        if (Number.isFinite(slope) && Math.abs(slope) > 1e-9) return price => meanY + slope * (price - meanP) - rect.top;
      }
    }

    const candles = [...(Array.isArray(state?.candles) ? state.candles.slice(-12) : [])];
    if (state?.currentCandle) candles.push(state.currentCandle);
    const lows = candles.map(c => num(c?.low)).filter(v => v != null);
    const highs = candles.map(c => num(c?.high)).filter(v => v != null);
    if (currentPrice != null) { lows.push(currentPrice); highs.push(currentPrice); }
    if (!lows.length || !highs.length) return null;
    let low = Math.min(...lows), high = Math.max(...highs);
    let span = high - low;
    if (!Number.isFinite(span) || span <= 0) span = Math.max(Math.abs(currentPrice || 1) * .001, 1e-8);
    low -= span * .16;
    high += span * .16;
    return price => ((high - price) / Math.max(1e-12, high - low)) * rect.height;
  }

  let prefs = { ...DEFAULT_PREFS };
  let state = null;
  let root = null;
  let busy = false;

  function ensureRoot() {
    if (root?.isConnected) return root;
    root = document.createElement('div');
    root.id = 'ats-analysis-visual-overlay-v2';
    Object.assign(root.style, {
      position: 'fixed', zIndex: '2147483646', pointerEvents: 'none', userSelect: 'none',
      contain: 'layout style paint', overflow: 'visible'
    });
    document.documentElement.appendChild(root);
    return root;
  }

  function marketIntegrityOk() {
    if (!state || state.connection !== 'online' || !state.asset || num(state.price) == null) return false;
    const focus = state.diagnostics?.focusedAsset;
    const session = state.diagnostics?.marketSession;
    if (focus?.reliable !== true || focus?.chartScoped !== true || focus?.trustedChartFrame !== true) return false;
    if (focus?.embeddedTrader !== true && focus?.casaTradeFrame !== true) return false;
    if (!sameMarket(focus?.asset, state.asset)) return false;
    if (!sameMarket(session?.asset, state.asset)) return false;
    if (Number(session?.frameId) !== Number(focus?.frameId) || String(session?.frameHost || '').toLowerCase() !== String(focus?.frameHost || '').toLowerCase()) return false;
    if (focus.at && Date.now() - Number(focus.at) > 10000) return false;
    if (!state.lastSeen || Date.now() - Number(state.lastSeen) > 10000) return false;
    return true;
  }

  function clockIntegrityOk() {
    if (!marketIntegrityOk()) return false;
    const focus = state.diagnostics?.focusedAsset;
    const clock = state.diagnostics?.marketClock;
    if (clock?.verified !== true || clock?.available === false || clock?.role !== 'candle-close') return false;
    if (!['trader-dom-countdown','network-server-cycle'].includes(String(clock?.source || ''))) return false;
    if (!sameMarket(clock?.asset, state.asset)) return false;
    if (Number(clock?.frameId) !== Number(focus?.frameId) || String(clock?.frameHost || '').toLowerCase() !== String(focus?.frameHost || '').toLowerCase()) return false;
    return Date.now() - Number(clock?.at || 0) <= 2200;
  }

  function fallbackLevels() {
    const rows = [...(Array.isArray(state?.candles) ? state.candles.slice(-10) : [])];
    if (state?.currentCandle) rows.push(state.currentCandle);
    const valid = rows.map(row => ({ low: num(row?.low), high: num(row?.high) })).filter(row => row.low != null && row.high != null);
    if (valid.length < 3) return {};
    return {
      support: Math.min(...valid.map(row => row.low)),
      resistance: Math.max(...valid.map(row => row.high))
    };
  }

  function activeDirection() {
    const ui = String(state?.signal?.uiState || '').toUpperCase();
    const dir = String(state?.signal?.direction || state?.signal?.analysisDirection || state?.signal?.waitingFor?.direction || '').toUpperCase();
    if (ui.includes('BUY') || dir === 'BUY') return 'BUY';
    if (ui.includes('SELL') || dir === 'SELL') return 'SELL';
    return null;
  }

  function activeTrigger(analytics = {}, waiting = {}) {
    if (!clockIntegrityOk()) return null;
    const direction = activeDirection();
    if (!direction) return null;
    const waitingLevel = num(waiting.level);
    if (waitingLevel != null) return { direction, price: waitingLevel };
    const fallback = direction === 'BUY' ? num(analytics.breakoutHigh) : num(analytics.breakoutLow);
    return fallback == null ? null : { direction, price: fallback };
  }

  function render() {
    if (!prefs.overlayEnabled || !marketIntegrityOk()) { if (root) root.hidden = true; return; }
    const rect = chartRect();
    if (!rect) { if (root) root.hidden = true; return; }
    const yFor = priceMapper(rect, state);
    if (!yFor) { if (root) root.hidden = true; return; }
    const hostRoot = ensureRoot();
    hostRoot.hidden = false;
    Object.assign(hostRoot.style, {
      left: `${Math.round(rect.left)}px`, top: `${Math.round(rect.top)}px`,
      width: `${Math.round(rect.width)}px`, height: `${Math.round(rect.height)}px`
    });
    hostRoot.replaceChildren();

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '100%');
    svg.setAttribute('height', '100%');
    svg.setAttribute('viewBox', `0 0 ${Math.max(1, rect.width)} ${Math.max(1, rect.height)}`);
    svg.style.pointerEvents = 'none';
    svg.style.overflow = 'visible';
    hostRoot.appendChild(svg);

    const analytics = { ...fallbackLevels(), ...(state.signal?.analytics || {}) };
    const waiting = state.signal?.waitingFor || {};
    const drawn = [];
    const addLine = (price, label, stroke, dash = '', active = false) => {
      const value = num(price);
      if (value == null) return;
      const tolerance = Math.max(Math.abs(value) * .000002, 1e-10);
      if (drawn.some(v => Math.abs(v - value) <= tolerance)) return;
      drawn.push(value);
      const y = yFor(value);
      if (!Number.isFinite(y) || y < -20 || y > rect.height + 20) return;
      const line = document.createElementNS(svg.namespaceURI, 'line');
      line.setAttribute('x1', '0'); line.setAttribute('x2', String(rect.width));
      line.setAttribute('y1', String(y)); line.setAttribute('y2', String(y));
      line.setAttribute('stroke', stroke); line.setAttribute('stroke-width', active ? '4' : '2.2');
      line.setAttribute('opacity', active ? '1' : '.82');
      if (dash) line.setAttribute('stroke-dasharray', dash);
      svg.appendChild(line);

      const text = document.createElementNS(svg.namespaceURI, 'text');
      text.setAttribute('x', '10'); text.setAttribute('y', String(Math.max(15, y - 6)));
      text.setAttribute('fill', stroke); text.setAttribute('font-size', active ? '13' : '11.5');
      text.setAttribute('font-weight', '900'); text.setAttribute('paint-order', 'stroke');
      text.setAttribute('stroke', '#10151d'); text.setAttribute('stroke-width', '3');
      text.setAttribute('stroke-linejoin', 'round');
      text.textContent = `${active ? '▶ ' : ''}${label} ${String(value)}`;
      svg.appendChild(text);
    };

    addLine(analytics.resistance, 'Resistência relevante', '#f0b56d', '5 5');
    addLine(analytics.support, 'Suporte relevante', '#79bfff', '5 5');
    const trigger = activeTrigger(analytics, waiting);
    if (trigger) {
      addLine(trigger.price, trigger.direction === 'BUY' ? 'Entrada COMPRA' : 'Entrada VENDA', trigger.direction === 'BUY' ? '#58d6ad' : '#f07b94', '8 5', true);
    }

    const status = document.createElementNS(svg.namespaceURI, 'text');
    status.setAttribute('x', '12'); status.setAttribute('y', '20'); status.setAttribute('fill', '#fff');
    status.setAttribute('font-size', '13'); status.setAttribute('font-weight', '900');
    status.setAttribute('paint-order', 'stroke'); status.setAttribute('stroke', '#10151d'); status.setAttribute('stroke-width', '4');
    const score = Math.round(Number(state.signal?.analysisScore ?? state.signal?.score ?? 0));
    const seconds = clockIntegrityOk() ? num(state.diagnostics?.marketClock?.secondsRemaining ?? state.signal?.secondsRemaining) : null;
    const regime = state.signal?.regime?.type || 'identificando';
    status.textContent = clockIntegrityOk()
      ? `${state.signal?.uiState || 'ANALISANDO'} • score ${score} • ${seconds == null ? '—' : Math.ceil(seconds)}s • ${regime}`
      : `SUPORTE / RESISTÊNCIA • SINCRONIZANDO VELA`;
    svg.appendChild(status);
  }

  async function refresh() {
    if (busy) return;
    busy = true;
    try {
      const response = await sendMessage({ type: 'ATS_READ_SCANNER_STATE' });
      state = response?.state || null;
      render();
    } finally { busy = false; }
  }

  chrome.storage.local.get(PREF_KEY, stored => {
    void chrome.runtime?.lastError;
    prefs = { ...DEFAULT_PREFS, ...(stored?.[PREF_KEY] || {}) };
    refresh();
  });
  chrome.storage.onChanged.addListener(changes => {
    if (!changes[PREF_KEY]) return;
    prefs = { ...DEFAULT_PREFS, ...(changes[PREF_KEY].newValue || {}) };
    if (!prefs.overlayEnabled && root) root.hidden = true;
    else refresh();
  });
  setInterval(refresh, 750);
  refresh();
})();