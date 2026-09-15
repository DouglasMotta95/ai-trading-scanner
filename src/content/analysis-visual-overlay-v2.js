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
    const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity || 1) > 0;
  };

  let cache = [], cacheAt = 0;
  function deepElements(limit = 5000) {
    const now = Date.now();
    if (cache.length && now - cacheAt < 600) return cache.slice(0, limit);
    const out = [], roots = [document], seen = new Set();
    while (roots.length && out.length < 6000) {
      const root = roots.shift(); if (!root || seen.has(root)) continue; seen.add(root);
      let rows = []; try { rows = [...root.querySelectorAll('*')]; } catch {}
      for (const el of rows) { out.push(el); if (el.shadowRoot) roots.push(el.shadowRoot); if (out.length >= 6000) break; }
    }
    cache = out; cacheAt = now; return out.slice(0, limit);
  }
  function lowerChartBoundary(rect) {
    let boundary = rect.bottom;
    for (const el of deepElements(3500)) {
      if (!visible(el)) continue;
      const own = String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!own || own.length > 80 || !/^(portf[oó]lio total|portfolio total|posi[cç][aã]o|positions?)$/i.test(own)) continue;
      const r = el.getBoundingClientRect();
      if (r.top > rect.top + 160 && r.top < boundary) boundary = r.top - 6;
    }
    return Math.max(rect.top + 150, boundary);
  }
  function fallbackChartRect() {
    const left = Math.max(40, innerWidth * .045), top = Math.max(55, innerHeight * .08);
    const right = Math.max(left + 280, innerWidth * .82);
    const provisional = { left, top, right, bottom: Math.max(top + 190, innerHeight * .78) };
    const bottom = lowerChartBoundary({ ...provisional, width: right - left, height: provisional.bottom - top });
    return { left, top, right, bottom, width: right - left, height: bottom - top };
  }
  function chartRect() {
    const rows = [];
    for (const el of deepElements()) {
      if (!visible(el)) continue;
      const tag = String(el.tagName || '').toLowerCase();
      const meta = `${el.className || ''} ${el.id || ''} ${el.getAttribute?.('data-testid') || ''}`.toLowerCase();
      if (tag !== 'canvas' && tag !== 'svg' && !/chart|candle|graph|trading|plot/.test(meta)) continue;
      const r = el.getBoundingClientRect(); if (r.width < 240 || r.height < 150) continue;
      let score = r.width * r.height; if (tag === 'canvas') score *= 2.2; if (/chart|candle|trading|plot/.test(meta)) score *= 1.45;
      rows.push({ rect: r, score });
    }
    rows.sort((a, b) => b.score - a.score);
    const raw = rows[0]?.rect || fallbackChartRect();
    const bottom = lowerChartBoundary(raw);
    return { left: raw.left, top: raw.top, right: raw.right, bottom, width: raw.width, height: bottom - raw.top };
  }
  function priceMapper(rect, state) {
    const candles = [...(Array.isArray(state?.candles) ? state.candles.slice(-14) : [])];
    if (state?.currentCandle) candles.push(state.currentCandle);
    const lows = candles.map(c => num(c?.low)).filter(v => v != null), highs = candles.map(c => num(c?.high)).filter(v => v != null);
    const current = num(state?.price); if (current != null) { lows.push(current); highs.push(current); }
    if (!lows.length || !highs.length) return null;
    let low = Math.min(...lows), high = Math.max(...highs), span = high - low;
    if (!(span > 0)) span = Math.max(Math.abs(current || 1) * .001, 1e-8);
    low -= span * .12; high += span * .12;
    return price => ((high - price) / Math.max(1e-12, high - low)) * rect.height;
  }

  let prefs = { ...DEFAULT_PREFS }, state = null, root = null, busy = false;
  function ensureRoot() {
    if (root?.isConnected) return root;
    root = document.createElement('div'); root.id = 'ats-analysis-visual-overlay-v2';
    Object.assign(root.style, { position: 'fixed', zIndex: '2147483646', pointerEvents: 'none', userSelect: 'none', contain: 'layout style paint', overflow: 'hidden' });
    document.documentElement.appendChild(root); return root;
  }
  function marketIntegrityOk() {
    if (!state || state.connection !== 'online' || !state.asset || num(state.price) == null) return false;
    const focus = state.diagnostics?.focusedAsset, session = state.diagnostics?.marketSession;
    if (focus?.reliable !== true || focus?.chartScoped !== true || focus?.trustedChartFrame !== true) return false;
    if (focus?.embeddedTrader !== true && focus?.casaTradeFrame !== true) return false;
    if (!sameMarket(focus?.asset, state.asset)) return false;
    if (!sameMarket(session?.asset, state.asset)) return false;
    return !focus.at || Date.now() - Number(focus.at) <= 10000;
  }
  function clockIntegrityOk() {
    if (!marketIntegrityOk()) return false;
    const focus = state.diagnostics?.focusedAsset, clock = state.diagnostics?.marketClock;
    if (clock?.verified !== true || clock?.available === false || clock?.role !== 'candle-close') return false;
    if (!['trader-dom-countdown','network-server-cycle'].includes(String(clock?.source || ''))) return false;
    return sameMarket(clock?.asset, state.asset) && Number(clock?.frameId) === Number(focus?.frameId) && Date.now() - Number(clock?.at || 0) <= 2200;
  }
  function fallbackLevels() {
    const rows = Array.isArray(state?.candles) ? state.candles.slice(-10) : [];
    const valid = rows.filter(c => num(c?.low) != null && num(c?.high) != null);
    return valid.length < 3 ? {} : { support: Math.min(...valid.map(c => Number(c.low))), resistance: Math.max(...valid.map(c => Number(c.high))) };
  }
  function activeTrigger(analytics = {}, waiting = {}) {
    if (!clockIntegrityOk()) return null;
    const ui = String(state?.signal?.uiState || '').toUpperCase();
    const dir = ui.includes('BUY') ? 'BUY' : ui.includes('SELL') ? 'SELL' : String(state?.signal?.direction || waiting.direction || '').toUpperCase();
    if (!['BUY','SELL'].includes(dir)) return null;
    const level = num(waiting.level) ?? (dir === 'BUY' ? num(analytics.breakoutHigh) : num(analytics.breakoutLow));
    return level == null ? null : { direction: dir, price: level };
  }
  function render() {
    if (!prefs.overlayEnabled || !marketIntegrityOk()) { if (root) root.hidden = true; return; }
    const rect = chartRect(), yFor = priceMapper(rect, state); if (!rect || !yFor) { if (root) root.hidden = true; return; }
    const box = ensureRoot(); box.hidden = false;
    Object.assign(box.style, { left: `${Math.round(rect.left)}px`, top: `${Math.round(rect.top)}px`, width: `${Math.round(rect.width)}px`, height: `${Math.round(rect.height)}px` });
    box.replaceChildren();
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width','100%'); svg.setAttribute('height','100%'); svg.setAttribute('viewBox',`0 0 ${Math.max(1,rect.width)} ${Math.max(1,rect.height)}`);
    svg.style.pointerEvents = 'none'; svg.style.overflow = 'hidden'; box.appendChild(svg);
    const analytics = { ...fallbackLevels(), ...(state.signal?.analytics || {}) };
    void analytics.breakoutHigh; void analytics.breakoutLow;
    const drawn = [];
    const addLine = (price, label, stroke, active = false) => {
      const value = num(price); if (value == null) return;
      const y = yFor(value); if (!Number.isFinite(y) || y < 4 || y > rect.height - 4) return;
      if (drawn.some(v => Math.abs(v - value) <= Math.max(Math.abs(value) * .000002, 1e-10))) return; drawn.push(value);
      const line = document.createElementNS(svg.namespaceURI,'line');
      line.setAttribute('x1','0'); line.setAttribute('x2',String(rect.width)); line.setAttribute('y1',String(y)); line.setAttribute('y2',String(y));
      line.setAttribute('stroke',stroke); line.setAttribute('stroke-width',active ? '3.5' : '1.8'); line.setAttribute('stroke-dasharray',active ? '8 5' : '5 5'); svg.appendChild(line);
      const txt = document.createElementNS(svg.namespaceURI,'text'); txt.setAttribute('x','8'); txt.setAttribute('y',String(Math.max(14,y-5)));
      txt.setAttribute('fill',stroke); txt.setAttribute('font-size',active ? '12.5' : '10.5'); txt.setAttribute('font-weight','900'); txt.setAttribute('paint-order','stroke'); txt.setAttribute('stroke','#10151d'); txt.setAttribute('stroke-width','3');
      txt.textContent = `${label} ${value}`; svg.appendChild(txt);
    };
    addLine(analytics.resistance, 'Resistência relevante', '#f0b56d');
    addLine(analytics.support, 'Suporte relevante', '#79bfff');
    const waiting = state.signal?.waitingFor || {};
    const trigger = activeTrigger(analytics, waiting);
    if (trigger) addLine(trigger.price, trigger.direction === 'BUY' ? 'Entrada COMPRA' : 'Entrada VENDA', trigger.direction === 'BUY' ? '#58d6ad' : '#f07b94', true);
    // Deliberately no generic syncing banner on the chart: only actionable lines belong here.
  }
  async function refresh() {
    if (busy) return; busy = true;
    try { const reply = await sendMessage({ type: 'ATS_READ_SCANNER_STATE' }); state = reply?.state || null; render(); } finally { busy = false; }
  }
  chrome.storage?.local?.get?.(PREF_KEY, stored => { prefs = { ...DEFAULT_PREFS, ...(stored?.[PREF_KEY] || {}) }; refresh().catch(() => {}); });
  chrome.storage?.onChanged?.addListener?.(changes => {
    if (changes[PREF_KEY]) { prefs = { ...DEFAULT_PREFS, ...(changes[PREF_KEY].newValue || {}) }; render(); }
    if (changes.scannerState) { state = changes.scannerState.newValue || null; render(); }
  });
  setInterval(() => refresh().catch(() => {}), 1000); refresh().catch(() => {});
})();
