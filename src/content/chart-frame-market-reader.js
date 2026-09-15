(() => {
  if (globalThis.__ATS_CHART_FRAME_MARKET_READER__) return;
  globalThis.__ATS_CHART_FRAME_MARKET_READER__ = true;

  const clean = value => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  const fold = value => clean(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const host = String(location.hostname || '').toLowerCase().replace(/\.$/, '');
  const traderHost = value => value === 'casatraders.online' || value.endsWith('.casatraders.online') || value === 'ivcasatraders.online' || value.endsWith('.ivcasatraders.online');
  const casaHost = value => value === 'casatrade.com' || value.endsWith('.casatrade.com') || value === 'casatrade.io' || value.endsWith('.casatrade.io');
  if (!traderHost(host) && !casaHost(host)) return;

  const num = value => {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    let s = clean(value).replace(/[^\d,.-]/g, '');
    if (!s) return null;
    if (s.includes(',') && s.includes('.')) s = s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
    else s = s.replace(',', '.');
    const n = Number(s);
    return Number.isFinite(n) && n > 0 ? n : null;
  };

  const visible = el => {
    if (!el || !(el instanceof Element)) return false;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0;
  };

  let elementCache = [];
  let elementCacheAt = 0;
  function deepElements(limit = 6000) {
    const now = Date.now();
    if (elementCache.length && now - elementCacheAt < 600) return elementCache.slice(0, limit);
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

  function chartRect() {
    const rows = [];
    for (const el of deepElements(4000)) {
      if (!visible(el)) continue;
      const tag = String(el.tagName || '').toLowerCase();
      const meta = `${el.className || ''} ${el.id || ''} ${el.getAttribute?.('data-testid') || ''}`.toLowerCase();
      if (tag !== 'canvas' && tag !== 'svg' && !/chart|candle|graph|tradingview|plot/.test(meta)) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 180 || rect.height < 120) continue;
      let score = rect.width * rect.height;
      if (tag === 'canvas') score *= 1.8;
      rows.push({ rect, score });
    }
    rows.sort((a, b) => b.score - a.score);
    return rows[0]?.rect || null;
  }

  const nearChart = (rect, chart) => {
    if (!chart) return false;
    const x = Math.max(120, chart.width * .22);
    const y = Math.max(90, chart.height * .18);
    return rect.right >= chart.left - x && rect.left <= chart.right + x && rect.bottom >= chart.top - y && rect.top <= chart.bottom + y;
  };

  function pricesIn(text = '') {
    const out = [];
    for (const match of String(text).matchAll(/\b\d{1,7}[.,]\d{2,10}\b/g)) {
      const value = num(match[0]);
      if (value != null) out.push(value);
    }
    return out;
  }

  function quoteFromDom() {
    const chart = chartRect();
    const buy = [];
    const sell = [];
    const semantic = [];

    for (const el of deepElements()) {
      if (!visible(el)) continue;
      const own = clean(el.getAttribute?.('aria-label') || el.getAttribute?.('aria-valuetext') || el.getAttribute?.('title') || el.innerText || el.textContent || '');
      if (!own || own.length > 100) continue;
      const values = pricesIn(own);
      if (!values.length) continue;
      const rect = el.getBoundingClientRect();
      const context = fold(`${own} ${el.className || ''} ${el.id || ''} ${el.getAttribute?.('data-testid') || ''} ${el.parentElement?.className || ''} ${el.parentElement?.getAttribute?.('data-testid') || ''}`);
      if (/saldo|balance|valor|amount|retorno|return|payout|lucro|profit|expira|expiry|timer|countdown|porcent|percent|%/.test(context)) continue;
      const chartScoped = nearChart(rect, chart);
      const semanticPrice = /price|quote|rate|cotacao|cotação|preco|preço|current|last|bid|ask/.test(context);
      const buyContext = /comprar|\bbuy\b|\bask\b/.test(context);
      const sellContext = /vender|\bsell\b|\bbid\b/.test(context);
      if (!chartScoped && !semanticPrice && !buyContext && !sellContext) continue;

      let score = chartScoped ? 160 : 0;
      if (semanticPrice) score += 260;
      if (rect.left > innerWidth * .45 && rect.top > innerHeight * .08 && rect.top < innerHeight * .92) score += 45;
      if (buyContext) {
        for (const value of values) buy.push({ value, score: score + 150, semanticPrice });
        continue;
      }
      if (sellContext) {
        for (const value of values) sell.push({ value, score: score + 150, semanticPrice });
        continue;
      }
      if (chartScoped && semanticPrice) for (const value of values) semantic.push({ value, score });
    }

    buy.sort((a, b) => b.score - a.score);
    sell.sort((a, b) => b.score - a.score);
    semantic.sort((a, b) => b.score - a.score);
    if (buy[0] && sell[0]) {
      const scale = Math.max(Math.abs(buy[0].value), Math.abs(sell[0].value), 1e-12);
      if (Math.abs(buy[0].value - sell[0].value) / scale < .03) {
        return { price: (buy[0].value + sell[0].value) / 2, source: 'chart-buy-sell', confidence: 98 };
      }
    }
    const directionalSemantic = [...buy, ...sell].filter(row => row.semanticPrice).sort((a, b) => b.score - a.score)[0] || null;
    const best = semantic[0] || directionalSemantic;
    return best ? { price: best.value, source: 'chart-semantic-price', confidence: Math.min(96, Math.max(86, best.score / 4)) } : null;
  }

  let busy = false;
  let lastPrice = null;
  let lastSentAt = 0;

  async function tick() {
    if (busy) return;
    busy = true;
    try {
      const stateResponse = await chrome.runtime.sendMessage({ type: 'ATS_READ_SCANNER_STATE' }).catch(() => null);
      const state = stateResponse?.state || null;
      if (!state?.license || !['active','valid'].includes(String(state.license.status || '').toLowerCase())) return;
      const focus = state.diagnostics?.focusedAsset || null;
      if (!focus?.asset || focus.reliable !== true || focus.chartScoped !== true || focus.trustedChartFrame !== true) return;
      if (String(focus.frameHost || '').toLowerCase() !== host) return;

      const quote = quoteFromDom();
      if (!quote?.price) return;
      const now = Date.now();
      const changed = lastPrice == null || Number(lastPrice) !== Number(quote.price);
      if (!changed && now - lastSentAt < 1400) return;
      lastPrice = quote.price;
      lastSentAt = now;
      await chrome.runtime.sendMessage({
        type: 'ATS_CHART_FRAME_MARKET',
        asset: focus.asset,
        price: quote.price,
        priceSource: quote.source,
        confidence: quote.confidence,
        frameHost: host,
        at: now
      }).catch(() => null);
    } finally {
      busy = false;
    }
  }

  setInterval(tick, 750);
  tick();
})();
