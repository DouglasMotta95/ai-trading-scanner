(() => {
  if (globalThis.__ATS_ANALYSIS_VISUAL_OVERLAY_V2__) return;
  globalThis.__ATS_ANALYSIS_VISUAL_OVERLAY_V2__ = true;
  globalThis.__ATS_ANALYSIS_VISUAL_OVERLAY__ = true;

  const PREF_KEY = 'atsScannerUiPreferences';
  const DEFAULT_PREFS = { overlayEnabled: false, possibleSoundEnabled: false, confirmSoundEnabled: false };
  const host = String(location.hostname || '').toLowerCase().replace(/\.$/, '');
  const allowed = value => value === 'casatrade.com' || value.endsWith('.casatrade.com') || value === 'casatrade.io' || value.endsWith('.casatrade.io') || value === 'casatraders.online' || value.endsWith('.casatraders.online') || value === 'ivcasatraders.online' || value.endsWith('.ivcasatraders.online');
  if (!allowed(host)) return;

  const num = value => value == null || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null;
  const identity = value => String(value || '').toUpperCase().replace(/\s*\(\s*OTC\s*\)\s*$/i, '').replace(/\s+/g, '');
  const sameAsset = (a, b) => !!identity(a) && identity(a) === identity(b);
  const visible = el => {
    if (!el || !(el instanceof Element)) return false;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity || 1) > 0;
  };

  function deepElements(limit = 5500) {
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

  function chartRect() {
    const rows = [];
    for (const el of deepElements()) {
      if (!visible(el)) continue;
      const tag = String(el.tagName || '').toLowerCase();
      const meta = `${el.className || ''} ${el.id || ''} ${el.getAttribute?.('data-testid') || ''}`.toLowerCase();
      if (tag !== 'canvas' && tag !== 'svg' && !/chart|candle|graph|trading/.test(meta)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 260 || r.height < 160) continue;
      let score = r.width * r.height;
      if (tag === 'canvas') score *= 1.8;
      if (/chart|candle|trading/.test(meta)) score *= 1.3;
      rows.push({ rect: r, score });
    }
    rows.sort((a, b) => b.score - a.score);
    return rows[0]?.rect || null;
  }

  function priceMapper(rect, state) {
    const currentPrice = num(state?.price);
    const labels = [];
    for (const el of deepElements(3500)) {
      if (!visible(el)) continue;
      const raw = String(el.textContent || el.innerText || '').trim();
      if (!/^\d{1,8}(?:[.,]\d{2,10})$/.test(raw)) continue;
      const price = Number(raw.replace(',', '.'));
      if (!Number.isFinite(price) || price <= 0) continue;
      if (currentPrice != null && (price < currentPrice * .15 || price > currentPrice * 6)) continue;
      const r = el.getBoundingClientRect();
      const y = r.top + r.height / 2;
      if (r.left < rect.right - 180 || r.left > rect.right + 120 || y < rect.top - 10 || y > rect.bottom + 10) continue;
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
    const candles = [...(Array.isArray(state?.candles) ? state.candles.slice(-10) : [])];
    if (state?.currentCandle) candles.push(state.currentCandle);
    const lows = candles.map(c => num(c?.low)).filter(v => v != null);
    const highs = candles.map(c => num(c?.high)).filter(v => v != null);
    if (!lows.length || !highs.length) return null;
    let low = Math.min(...lows), high = Math.max(...highs);
    const span = Math.max(1e-12, high - low);
    low -= span * .12; high += span * .12;
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
    Object.assign(root.style, { position: 'fixed', zIndex: '2147483000', pointerEvents: 'none', userSelect: 'none', contain: 'layout style paint' });
    document.documentElement.appendChild(root);
    return root;
  }

  function integrityOk() {
    if (!state || state.platformId !== 'casatrade' || state.connection !== 'online' || !state.asset || num(state.price) == null) return false;
    const focus = state.diagnostics?.focusedAsset;
    if (!focus?.asset || !sameAsset(focus.asset, state.asset)) return false;
    if (!focus.at || Date.now() - Number(focus.at) > 4000) return false;
    if (!state.lastSeen || Date.now() - Number(state.lastSeen) > 8000) return false;
    return true;
  }

  function render() {
    if (!prefs.overlayEnabled || !integrityOk()) { if (root) root.hidden = true; return; }
    const rect = chartRect();
    if (!rect) { if (root) root.hidden = true; return; }
    const yFor = priceMapper(rect, state);
    if (!yFor) { if (root) root.hidden = true; return; }
    const hostRoot = ensureRoot();
    hostRoot.hidden = false;
    Object.assign(hostRoot.style, { left: `${Math.round(rect.left)}px`, top: `${Math.round(rect.top)}px`, width: `${Math.round(rect.width)}px`, height: `${Math.round(rect.height)}px` });
    hostRoot.replaceChildren();

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '100%'); svg.setAttribute('height', '100%'); svg.setAttribute('viewBox', `0 0 ${Math.max(1, rect.width)} ${Math.max(1, rect.height)}`);
    svg.style.pointerEvents = 'none'; svg.style.overflow = 'visible';
    hostRoot.appendChild(svg);

    const analytics = state.signal?.analytics || {};
    const waiting = state.signal?.waitingFor || {};
    const drawn = [];
    const addLine = (price, label, stroke, dash = '', active = false) => {
      const value = num(price); if (value == null) return;
      const tolerance = Math.max(Math.abs(value) * .000002, 1e-10);
      if (drawn.some(v => Math.abs(v - value) <= tolerance)) return;
      drawn.push(value);
      const y = yFor(value); if (!Number.isFinite(y) || y < -20 || y > rect.height + 20) return;
      const line = document.createElementNS(svg.namespaceURI, 'line');
      line.setAttribute('x1', '0'); line.setAttribute('x2', String(rect.width)); line.setAttribute('y1', String(y)); line.setAttribute('y2', String(y));
      line.setAttribute('stroke', stroke); line.setAttribute('stroke-width', active ? '3' : '1.5'); line.setAttribute('opacity', active ? '.98' : '.8');
      if (dash) line.setAttribute('stroke-dasharray', dash); svg.appendChild(line);
      const text = document.createElementNS(svg.namespaceURI, 'text');
      text.setAttribute('x', '8'); text.setAttribute('y', String(Math.max(13, y - 5))); text.setAttribute('fill', stroke); text.setAttribute('font-size', active ? '12' : '11'); text.setAttribute('font-weight', '800');
      text.textContent = `${active ? '▶ ' : ''}${label} ${String(value)}`; svg.appendChild(text);
    };

    addLine(state.price, 'Preço atual', '#f4f4f4', '2 5');
    addLine(analytics.resistance, 'Resistência', '#f0b56d', '4 5');
    addLine(analytics.support, 'Suporte', '#79bfff', '4 5');
    addLine(analytics.breakoutHigh, 'Gatilho compra ↑', '#58d6ad', '7 5', waiting.type === 'breakout' && waiting.direction === 'BUY');
    addLine(analytics.breakoutLow, 'Gatilho venda ↓', '#f07b94', '7 5', waiting.type === 'breakout' && waiting.direction === 'SELL');
    const waitLevel = num(waiting.level);
    if (waitLevel != null) addLine(waitLevel, 'Aguardando', '#d8c36a', '3 4');

    const status = document.createElementNS(svg.namespaceURI, 'text');
    status.setAttribute('x', '10'); status.setAttribute('y', '19'); status.setAttribute('fill', '#fff'); status.setAttribute('font-size', '12'); status.setAttribute('font-weight', '900');
    const score = Math.round(Number(state.signal?.analysisScore ?? state.signal?.score ?? 0));
    const seconds = num(state.signal?.secondsRemaining);
    const regime = state.signal?.regime?.type || 'identificando';
    status.textContent = `${state.signal?.uiState || 'ANALISANDO'} • score ${score} • ${seconds == null ? '—' : Math.ceil(seconds)}s • ${regime}`;
    svg.appendChild(status);
  }

  async function refresh() {
    if (busy) return;
    busy = true;
    try {
      const response = await chrome.runtime.sendMessage({ type: 'ATS_READ_SCANNER_STATE' }).catch(() => null);
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
  setInterval(refresh, 500);
  refresh();
})();
