(() => {
  if (globalThis.__ATS_ANALYSIS_VISUAL_OVERLAY__) return;
  globalThis.__ATS_ANALYSIS_VISUAL_OVERLAY__ = true;

  const PREF_KEY = 'atsScannerUiPreferences';
  const DEFAULT_PREFS = { overlayEnabled: false, possibleSoundEnabled: false, confirmSoundEnabled: false };
  const host = String(location.hostname || '').toLowerCase().replace(/\.$/, '');
  const refHost = (() => { try { return new URL(document.referrer || '').hostname.toLowerCase().replace(/\.$/, ''); } catch { return ''; } })();
  const isCasaTrade = value => value === 'casatrade.com' || value.endsWith('.casatrade.com') || value === 'casatrade.io' || value.endsWith('.casatrade.io');
  if (!isCasaTrade(host) && !isCasaTrade(refHost)) return;

  let prefs = { ...DEFAULT_PREFS };
  let scannerState = null;
  let root = null;
  let busy = false;

  const num = value => value == null || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null;
  const visible = el => {
    if (!el || !(el instanceof Element)) return false;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0;
  };
  const deepElements = (limit = 5500) => {
    const out = [];
    const roots = [document];
    const seen = new Set();
    while (roots.length && out.length < limit) {
      const current = roots.shift();
      if (!current || seen.has(current)) continue;
      seen.add(current);
      let nodes = [];
      try { nodes = [...current.querySelectorAll('*')]; } catch {}
      for (const el of nodes) {
        out.push(el);
        if (out.length >= limit) break;
        if (el.shadowRoot) roots.push(el.shadowRoot);
      }
    }
    return out;
  };
  const priceFromText = text => {
    const raw = String(text || '').trim();
    if (!/^\s*\d{1,7}(?:[.,]\d{2,10})\s*$/.test(raw)) return null;
    const parsed = Number(raw.replace(',', '.'));
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  };
  const formatPrice = value => {
    const n = num(value);
    if (n == null) return '—';
    const digits = Math.abs(n) >= 1000 ? 2 : Math.abs(n) >= 100 ? 3 : Math.abs(n) >= 1 ? 5 : 8;
    return n.toFixed(digits).replace(/0+$/, '').replace(/\.$/, '');
  };

  function chartRect() {
    const rows = [];
    for (const el of deepElements()) {
      if (!visible(el)) continue;
      const tag = String(el.tagName || '').toLowerCase();
      const meta = `${el.className || ''} ${el.id || ''} ${el.getAttribute?.('data-testid') || ''}`.toLowerCase();
      const chartLike = tag === 'canvas' || tag === 'svg' || /chart|candle|graph|trading/.test(meta);
      if (!chartLike) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 280 || r.height < 180) continue;
      let score = r.width * r.height;
      if (tag === 'canvas') score *= 1.7;
      if (tag === 'svg') score *= 1.25;
      if (/chart|candle|trading/.test(meta)) score *= 1.25;
      rows.push({ rect: r, score });
    }
    rows.sort((a, b) => b.score - a.score);
    return rows[0]?.rect || null;
  }

  function axisMapper(rect) {
    const currentPrice = num(scannerState?.price);
    const labels = [];
    for (const el of deepElements(3500)) {
      if (!visible(el)) continue;
      const value = priceFromText(el.textContent || el.innerText || '');
      if (value == null) continue;
      if (currentPrice != null && (value < currentPrice * .2 || value > currentPrice * 5)) continue;
      const r = el.getBoundingClientRect();
      const y = r.top + r.height / 2;
      const nearRightScale = r.left >= rect.right - 150 && r.left <= rect.right + 100;
      if (!nearRightScale || y < rect.top - 8 || y > rect.bottom + 8) continue;
      labels.push({ price: value, y });
    }

    const unique = [];
    for (const row of labels) {
      if (!unique.some(other => Math.abs(other.price - row.price) < 1e-12)) unique.push(row);
    }
    if (unique.length >= 2) {
      const meanP = unique.reduce((sum, row) => sum + row.price, 0) / unique.length;
      const meanY = unique.reduce((sum, row) => sum + row.y, 0) / unique.length;
      const denom = unique.reduce((sum, row) => sum + (row.price - meanP) ** 2, 0);
      if (denom > 0) {
        const slope = unique.reduce((sum, row) => sum + (row.price - meanP) * (row.y - meanY), 0) / denom;
        if (Number.isFinite(slope) && Math.abs(slope) > 1e-9) {
          return price => meanY + slope * (price - meanP) - rect.top;
        }
      }
    }

    const candles = [...(Array.isArray(scannerState?.candles) ? scannerState.candles.slice(-10) : [])];
    if (scannerState?.currentCandle) candles.push(scannerState.currentCandle);
    const lows = candles.map(row => num(row?.low)).filter(value => value != null);
    const highs = candles.map(row => num(row?.high)).filter(value => value != null);
    if (!lows.length || !highs.length) return null;
    let low = Math.min(...lows);
    let high = Math.max(...highs);
    const span = Math.max(1e-12, high - low);
    low -= span * .12;
    high += span * .12;
    return price => ((high - price) / Math.max(1e-12, high - low)) * rect.height;
  }

  function ensureRoot() {
    if (root?.isConnected) return root;
    root = document.createElement('div');
    root.id = 'ats-analysis-visual-overlay';
    root.style.position = 'fixed';
    root.style.zIndex = '2147483000';
    root.style.pointerEvents = 'none';
    root.style.userSelect = 'none';
    root.style.contain = 'layout style paint';
    document.documentElement.appendChild(root);
    return root;
  }

  function render() {
    if (!prefs.overlayEnabled || !scannerState || scannerState.platformId !== 'casatrade' || !scannerState.asset) {
      if (root) root.hidden = true;
      return;
    }
    const rect = chartRect();
    if (!rect) {
      if (root) root.hidden = true;
      return;
    }
    const yFor = axisMapper(rect);
    if (!yFor) {
      if (root) root.hidden = true;
      return;
    }

    const host = ensureRoot();
    host.hidden = false;
    host.style.left = `${Math.round(rect.left)}px`;
    host.style.top = `${Math.round(rect.top)}px`;
    host.style.width = `${Math.round(rect.width)}px`;
    host.style.height = `${Math.round(rect.height)}px`;
    host.replaceChildren();

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '100%');
    svg.setAttribute('height', '100%');
    svg.setAttribute('viewBox', `0 0 ${Math.max(1, rect.width)} ${Math.max(1, rect.height)}`);
    svg.style.overflow = 'visible';
    svg.style.pointerEvents = 'none';
    host.appendChild(svg);

    const analytics = scannerState.signal?.analytics || {};
    const addHorizontal = (price, label, stroke, dash = '') => {
      const value = num(price);
      if (value == null) return;
      const y = yFor(value);
      if (!Number.isFinite(y) || y < -20 || y > rect.height + 20) return;
      const line = document.createElementNS(svg.namespaceURI, 'line');
      line.setAttribute('x1', '0'); line.setAttribute('x2', String(rect.width));
      line.setAttribute('y1', String(y)); line.setAttribute('y2', String(y));
      line.setAttribute('stroke', stroke); line.setAttribute('stroke-width', '1.5');
      line.setAttribute('opacity', '.82');
      if (dash) line.setAttribute('stroke-dasharray', dash);
      svg.appendChild(line);
      const text = document.createElementNS(svg.namespaceURI, 'text');
      text.setAttribute('x', '8'); text.setAttribute('y', String(Math.max(12, y - 5)));
      text.setAttribute('fill', stroke); text.setAttribute('font-size', '11'); text.setAttribute('font-weight', '700');
      text.textContent = `${label} ${formatPrice(value)}`;
      svg.appendChild(text);
    };

    addHorizontal(analytics.breakoutHigh, 'Rompimento ↑', '#58d6ad', '7 5');
    addHorizontal(analytics.breakoutLow, 'Rompimento ↓', '#f07b94', '7 5');

    const direction = scannerState.signal?.analysisDirection || scannerState.signal?.direction || analytics.trendDirection;
    if (direction === 'BUY' || direction === 'SELL') {
      const closes = (Array.isArray(scannerState.candles) ? scannerState.candles.slice(-6) : [])
        .map(row => num(row?.close)).filter(value => value != null);
      const current = num(scannerState.currentCandle?.close) ?? num(scannerState.price);
      if (current != null) closes.push(current);
      if (closes.length >= 2) {
        const xs = closes.map((_, index) => index);
        const meanX = xs.reduce((a, b) => a + b, 0) / xs.length;
        const meanY = closes.reduce((a, b) => a + b, 0) / closes.length;
        const denom = xs.reduce((sum, x) => sum + (x - meanX) ** 2, 0);
        let slope = denom > 0 ? xs.reduce((sum, x, index) => sum + (x - meanX) * (closes[index] - meanY), 0) / denom : 0;
        const visibleRange = Math.max(1e-12, Math.max(...closes) - Math.min(...closes));
        if (direction === 'BUY' && slope <= 0) slope = visibleRange / Math.max(4, closes.length * 2);
        if (direction === 'SELL' && slope >= 0) slope = -visibleRange / Math.max(4, closes.length * 2);
        const startPrice = meanY + slope * (0 - meanX);
        const endPrice = meanY + slope * ((closes.length - 1) - meanX);
        const trend = document.createElementNS(svg.namespaceURI, 'line');
        trend.setAttribute('x1', String(rect.width * .12));
        trend.setAttribute('x2', String(rect.width * .88));
        trend.setAttribute('y1', String(yFor(startPrice)));
        trend.setAttribute('y2', String(yFor(endPrice)));
        trend.setAttribute('stroke', direction === 'BUY' ? '#69cfff' : '#ffb46b');
        trend.setAttribute('stroke-width', '2');
        trend.setAttribute('opacity', '.78');
        svg.appendChild(trend);
      }
    }
  }

  async function refreshState() {
    if (!prefs.overlayEnabled || busy) return render();
    busy = true;
    try {
      const response = await chrome.runtime.sendMessage({ type: 'ATS_READ_SCANNER_STATE' }).catch(() => null);
      scannerState = response?.state || null;
      render();
    } finally {
      busy = false;
    }
  }

  async function loadPrefs() {
    const stored = await chrome.storage.local.get(PREF_KEY).catch(() => ({}));
    prefs = { ...DEFAULT_PREFS, ...(stored[PREF_KEY] || {}) };
    if (!prefs.overlayEnabled && root) root.hidden = true;
    if (prefs.overlayEnabled) refreshState().catch(() => {});
  }

  chrome.storage.onChanged.addListener(changes => {
    if (!changes[PREF_KEY]) return;
    prefs = { ...DEFAULT_PREFS, ...(changes[PREF_KEY].newValue || {}) };
    if (!prefs.overlayEnabled && root) root.hidden = true;
    else refreshState().catch(() => {});
  });
  addEventListener('resize', () => render(), { passive: true });
  addEventListener('scroll', () => render(), { passive: true, capture: true });
  loadPrefs().catch(() => {});
  setInterval(() => refreshState().catch(() => {}), 800);
})();
