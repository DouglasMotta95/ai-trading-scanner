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
  const clean = value => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  const QUOTES = new Set(['USDT','USDC','USD','EUR','GBP','JPY','AUD','CAD','CHF','NZD','BRL','BTC','ETH']);
  const pairRe = /\b([A-Z0-9]{2,16})\s*[\/_-]\s*(USDT|USDC|USD|EUR|GBP|JPY|AUD|CAD|CHF|NZD|BRL|BTC|ETH)(?:\s*\(\s*OTC\s*\)|\s+OTC)?/i;
  function canonicalAsset(value = '') {
    let raw = clean(value).toUpperCase();
    if (!raw || raw.length > 100) return '';
    const otc = /(?:\(|\b|[_-])OTC(?:\)|\b)?/.test(raw);
    let normalized = raw.replace(/\(\s*OTC\s*\)|\bOTC\b/g, '').replace(/^FRX[:_-]?/, '')
      .replace(/\s+/g, '').replace(/_/g, '/').replace(/-/g, '/').replace(/:+/g, '/')
      .replace(/^\/+|\/+$/g, '').replace(/\/{2,}/g, '/');
    if (!normalized.includes('/')) {
      const quote = [...QUOTES].find(item => normalized.length > item.length && normalized.endsWith(item));
      if (quote) normalized = `${normalized.slice(0, -quote.length)}/${quote}`;
    }
    const match = normalized.match(/^([A-Z0-9]{2,16})\/([A-Z0-9]{2,12})$/);
    if (!match || !QUOTES.has(match[2])) return '';
    return `${match[1]}/${match[2]}${otc ? ' (OTC)' : ''}`;
  }
  const assetIdentity = value => canonicalAsset(value).replace(/\s*\(OTC\)\s*$/, '');
  const sameAsset = (a, b) => {
    const left = assetIdentity(a), right = assetIdentity(b);
    return !!left && !!right && left === right;
  };
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
  function localVisibleAsset() {
    const rows = [];
    for (const el of deepElements(5000)) {
      if (!visible(el)) continue;
      const text = clean(el.getAttribute?.('aria-label') || el.getAttribute?.('title') || el.innerText || el.textContent || '');
      if (!text || text.length > 120) continue;
      const match = text.match(pairRe);
      if (!match) continue;
      const asset = canonicalAsset(match[0]);
      if (!asset) continue;
      const role = String(el.getAttribute?.('role') || '').toLowerCase();
      const flags = `${el.className || ''} ${el.getAttribute?.('aria-selected') || ''} ${el.getAttribute?.('aria-current') || ''} ${el.getAttribute?.('data-state') || ''}`;
      const selected = /true|active|selected|current|checked/i.test(flags);
      if (role === 'tab' && !selected) continue;
      const rect = el.getBoundingClientRect();
      const context = `${el.id || ''} ${el.className || ''} ${el.parentElement?.className || ''}`.toLowerCase();
      let score = selected ? 500 : 0;
      if (role !== 'tab') score += 100;
      if (rect.top >= 0 && rect.top < innerHeight * .55) score += 45;
      if (text.length < 45) score += 35;
      if (/chart|trade|trading|instrument|asset|symbol|header/.test(context)) score += 120;
      if (/watchlist|listbox|history|portfolio|dropdown|menu|drawer/.test(context) && !selected) score -= 260;
      rows.push({ asset, score });
    }
    rows.sort((a, b) => b.score - a.score);
    return rows[0]?.asset || '';
  }

  function overlayMatchesVisibleAsset() {
    const stateAsset = canonicalAsset(scannerState?.asset || '');
    const lastSeen = Number(scannerState?.lastSeen || 0);
    if (!stateAsset || !Number.isFinite(lastSeen) || lastSeen <= 0 || Date.now() - lastSeen > 8000) return false;
    const visibleAsset = localVisibleAsset();
    if (!visibleAsset) return false;
    return sameAsset(visibleAsset, stateAsset);
  }

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
    if (!prefs.overlayEnabled || !scannerState || scannerState.platformId !== 'casatrade' || !scannerState.asset || !overlayMatchesVisibleAsset()) {
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
    const waiting = scannerState.signal?.waitingFor || null;
    const drawnLevels = [];
    const addHorizontal = (price, label, stroke, dash = '', active = false) => {
      const value = num(price);
      if (value == null) return;
      const tolerance = Math.max(Math.abs(value) * 0.000002, 1e-10);
      if (drawnLevels.some(existing => Math.abs(existing - value) <= tolerance)) return;
      drawnLevels.push(value);
      const y = yFor(value);
      if (!Number.isFinite(y) || y < -20 || y > rect.height + 20) return;
      const line = document.createElementNS(svg.namespaceURI, 'line');
      line.setAttribute('x1', '0'); line.setAttribute('x2', String(rect.width));
      line.setAttribute('y1', String(y)); line.setAttribute('y2', String(y));
      line.setAttribute('stroke', stroke); line.setAttribute('stroke-width', active ? '3' : '1.5');
      line.setAttribute('opacity', active ? '.98' : '.78');
      if (dash) line.setAttribute('stroke-dasharray', dash);
      svg.appendChild(line);
      const text = document.createElementNS(svg.namespaceURI, 'text');
      text.setAttribute('x', '8'); text.setAttribute('y', String(Math.max(12, y - 5)));
      text.setAttribute('fill', stroke); text.setAttribute('font-size', active ? '12' : '11'); text.setAttribute('font-weight', '700');
      text.textContent = `${active ? '▶ ' : ''}${label} ${formatPrice(value)}`;
      svg.appendChild(text);
    };

    addHorizontal(scannerState.price, 'Preço atual', '#f4f4f4', '2 5');
    addHorizontal(analytics.resistance, 'Resistência', '#f0b56d', '4 5');
    addHorizontal(analytics.support, 'Suporte', '#79bfff', '4 5');
    addHorizontal(analytics.breakoutHigh, 'Gatilho compra ↑', '#58d6ad', '7 5', waiting?.type === 'breakout' && waiting?.direction === 'BUY');
    addHorizontal(analytics.breakoutLow, 'Gatilho venda ↓', '#f07b94', '7 5', waiting?.type === 'breakout' && waiting?.direction === 'SELL');
    const waitLevel = num(scannerState.signal?.waitingFor?.level);
    if (waitLevel != null
      && waitLevel !== num(analytics.breakoutHigh)
      && waitLevel !== num(analytics.breakoutLow)
      && waitLevel !== num(analytics.support)
      && waitLevel !== num(analytics.resistance)) {
      addHorizontal(waitLevel, 'Aguardando', '#d8c36a', '3 4');
    }

    const uiState = String(scannerState.signal?.uiState || 'ANALYZING_MARKET');
    const statusMap = {
      POSSIBLE_BUY: 'POSSÍVEL COMPRA',
      POSSIBLE_SELL: 'POSSÍVEL VENDA',
      ENTER_BUY: 'ENTRAR COMPRA',
      ENTER_SELL: 'ENTRAR VENDA',
      WAIT: 'AGUARDAR',
      ANALYZING_MARKET: 'ANALISANDO'
    };
    const badge = document.createElementNS(svg.namespaceURI, 'text');
    badge.setAttribute('x', '10');
    badge.setAttribute('y', '18');
    badge.setAttribute('fill', '#ffffff');
    badge.setAttribute('font-size', '12');
    badge.setAttribute('font-weight', '800');
    const liveScore = Math.round(Number(scannerState.signal?.analysisScore ?? scannerState.signal?.score ?? 0));
    const seconds = num(scannerState.signal?.secondsRemaining);
    badge.textContent = `ATS • ${statusMap[uiState] || uiState} • ${liveScore}/100${seconds != null ? ` • ${Math.round(seconds)}s` : ''}`;
    svg.appendChild(badge);
    const regimeType = String(scannerState.signal?.regime?.type || 'unknown');
    const regimeLabel = regimeType === 'uptrend' ? 'Tendência alta' : regimeType === 'downtrend' ? 'Tendência baixa' : regimeType === 'range' ? 'Mercado lateral' : 'Regime identificando';
    const detail = document.createElementNS(svg.namespaceURI, 'text');
    detail.setAttribute('x', '10');
    detail.setAttribute('y', '34');
    detail.setAttribute('fill', '#d7e1ef');
    detail.setAttribute('font-size', '10.5');
    detail.setAttribute('font-weight', '650');
    detail.textContent = `${regimeLabel} • ${waiting?.label ? `Aguardando: ${waiting.label}` : 'Monitorando confirmação'}`;
    svg.appendChild(detail);

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
