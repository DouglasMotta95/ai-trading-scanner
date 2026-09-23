(() => {
  // V5 intentionally uses a new guard. MAIN-world code from an older unpacked
  // extension can survive while the CasaTrade tab stays open; the new probe
  // must start alongside it so fixes take effect without requiring a page reload.
  if (window.__ATS_RENDERED_MARKET_PROBE_V5__) return;
  window.__ATS_RENDERED_MARKET_PROBE_V5__ = true;

  const isCasaTradeHost = host => {
    const h = String(host || '').toLowerCase().replace(/\.$/, '');
    return h === 'casatrade.com' || h.endsWith('.casatrade.com') || h === 'casatrade.io' || h.endsWith('.casatrade.io') || h === 'casatraders.online' || h.endsWith('.casatraders.online') || h === 'ivcasatraders.online' || h.endsWith('.ivcasatraders.online');
  };
  const refHost = (() => {
    try { return new URL(document.referrer || '').hostname.toLowerCase().replace(/\.$/, ''); }
    catch { return ''; }
  })();
  const fallbackFrame = ['blob:', 'about:', 'data:'].includes(String(location.protocol || '').toLowerCase());

  // content_scripts use match_origin_as_fallback. A blob/about/data frame can
  // therefore legitimately belong to the CasaTrade page while having no
  // CasaTrade hostname or referrer of its own.
  if (!isCasaTradeHost(location.hostname) && !isCasaTradeHost(refHost) && !fallbackFrame) return;

  const FRAME_SOURCE = 'ATS_CT_RENDER_OBSERVATION_V5';
  const frameId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const isTop = window === window.top;
  const frameRows = new Map();

  const SENSITIVE = /token|auth|cookie|session|password|secret|bearer|csrf|api[-_]?key|credential|authorization/i;
  const QUOTES = ['USDT','USDC','USD','EUR','GBP','JPY','AUD','CAD','CHF','NZD','BRL','BTC','ETH'];
  const ASSET_KEYS = ['symbol','symbolName','symbol_name','asset','assetName','asset_name','instrument','instrumentName','instrument_name','ticker','pair','market'];
  const PRICE_KEYS = ['price','last','lastPrice','last_price','quote','close','value','rate','current','currentPrice','current_price'];
  const BID_KEYS = ['bid','bidPrice','bid_price','bestBid','best_bid'];
  const ASK_KEYS = ['ask','askPrice','ask_price','bestAsk','best_ask'];
  const TF_KEYS = ['timeframe','interval','period','resolution','tf'];
  const EXP_KEYS = ['expiration','expiry','duration','expiresIn','expires_in'];

  const recentCanvasText = [];
  const localCandles = new Map();
  let lastAppScanAt = 0;
  let appCandidates = [];

  // Diagnostic-only counters. They do not participate in market detection,
  // publishing decisions, throttles, or any reader behavior.
  const canvasDiagnostic = {
    startedAt: Date.now(),
    hookInstalled: false,
    hookedContexts: [],
    interceptedTotal: 0,
    fillTextTotal: 0,
    strokeTextTotal: 0,
    recentCallTimes: [],
    expirationPublishes: 0,
    lastExpirationPayload: null,
    lastExpirationPublishedAt: 0
  };

  const clean = v => String(v ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  const num = v => {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    let s = clean(v).replace(/[^\d,.-]/g, '');
    if (!s) return null;
    if (s.includes(',') && s.includes('.')) s = s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
    else s = s.replace(',', '.');
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  };
  const isVisibleElement = el => {
    if (!el || !(el instanceof Element)) return false;
    if (el.id === '__ats_rendered_market__' || el.closest?.('#__ats_rendered_market__')) return false;
    try {
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && st.display !== 'none' && st.visibility !== 'hidden' && Number(st.opacity || 1) > 0.01;
    } catch { return false; }
  };

  const pick = (o, keys) => {
    if (!o || typeof o !== 'object') return null;
    for (const k of keys) if (Object.prototype.hasOwnProperty.call(o, k) && o[k] != null) return o[k];
    let keys0 = [];
    try { keys0 = Object.keys(o).slice(0, 100); } catch {}
    const lower = new Map(keys0.map(k => [k.toLowerCase(), k]));
    for (const k of keys) {
      const real = lower.get(k.toLowerCase());
      if (real && o[real] != null) return o[real];
    }
    return null;
  };

  const canonicalAsset = value => {
    let raw = clean(value).toUpperCase();
    if (!raw || raw.length > 90 || SENSITIVE.test(raw)) return '';
    const otc = /(?:\(|\b|[_-])OTC(?:\)|\b)?/.test(raw);
    raw = raw.replace(/^FRX[:_-]?/, '').replace(/^OTC[:_-]?/, '');
    let s = raw.replace(/\(\s*OTC\s*\)|\bOTC\b/g, '')
      .replace(/\s+/g, '')
      .replace(/_/g, '/')
      .replace(/-/g, '/')
      .replace(/:+/g, '/')
      .replace(/^\/+|\/+$/g, '')
      .replace(/\/{2,}/g, '/');

    if (!s.includes('/')) {
      const q = QUOTES.find(x => s.length > x.length && s.endsWith(x));
      if (q) s = `${s.slice(0, -q.length)}/${q}`;
      else if (/^[A-Z]{6}$/.test(s)) s = `${s.slice(0, 3)}/${s.slice(3)}`;
    }
    const m = s.match(/^([A-Z0-9]{2,16})\/([A-Z0-9]{2,12})$/);
    if (m && QUOTES.includes(m[2])) return `${m[1]}/${m[2]}${otc ? ' (OTC)' : ''}`;
    let named = raw.replace(/\(\s*OTC\s*\)/gi, ' ').replace(/\bOTC\b/gi, ' ').trim();
    named = named.replace(/(?:^|[\s|•·_-])(BLITZ|OPTION|OPTIONS|BINARY|BINARIA|BINARIO|DIGITAL|TURBO|CALL|PUT)\s*$/i, '').trim();
    if (named.length >= 2 && named.length <= 64 && /[A-Z]/.test(named) && !/^[\d\s.,:+_/-]+$/.test(named)) {
      const blocked = new Set(['BLITZ','OPTION','OPTIONS','BINARY','BINARIA','BINARIO','DIGITAL','TURBO','CALL','PUT','BUY','SELL','COMPRA','VENDA','TRADE','TRADING','INFO','ATIVO','ASSET','INSTRUMENT','MARKET','PRICE','PRECO','EXPIRACAO','EXPIRATION','VALOR','SALDO','PAYOUT','LUCRO','LIVE']);
      if (!blocked.has(named)) return `${named}${otc ? ' (OTC)' : ''}`;
    }
    return '';
    return `${m[1]}/${m[2]}${otc ? ' (OTC)' : ''}`;
  };

  const assetRegex = /\b(?:[A-Z0-9]{2,16}\s*[\/_-]\s*(?:USDT|USDC|USD|EUR|GBP|JPY|AUD|CAD|CHF|NZD|BRL|HKD|SGD|NOK|SEK|DKK|PLN|CZK|HUF|TRY|MXN|ZAR|INR|CNY|CNH|KRW|THB|MYR|PHP|IDR|VND|TWD|ILS|AED|SAR|QAR|KWD|BHD|OMR|ARS|CLP|COP|PEN|UYU|BOB|PYG|BTC|ETH)|[A-Z]{6})(?:\s*\(\s*OTC\s*\)|\s+OTC)?/gi;
  const assetsIn = text => {
    const out = [];
    for (const m of String(text || '').matchAll(assetRegex)) {
      const asset = canonicalAsset(m[0]);
      if (asset) out.push(asset);
    }
    return out;
  };

  const normalizeTf = value => {
    const s = clean(value).toUpperCase().replace(/\s+/g, '');
    let m = s.match(/^M(1|2|5|15|30)$/); if (m) return `M${m[1]}`;
    m = s.match(/^(1|2|5|15|30)(?:M|MIN)$/); if (m) return `M${m[1]}`;
    m = s.match(/^S(5|15|30)$/); if (m) return `S${m[1]}`;
    if (/^(H1|1H|60M|60MIN)$/.test(s)) return 'H1';
    return null;
  };

  const normalizeExp = value => {
    const s = clean(value).toLowerCase().replace(/\s+/g, '');
    let m = s.match(/^(\d{1,4})(?:s|seg|segundo|segundos)$/); if (m) return `${Number(m[1])}s`;
    m = s.match(/^(\d{1,3})(?:m|min|minuto|minutos)$/); if (m) return `${Number(m[1]) * 60}s`;
    return null;
  };

  function rememberCanvasText(value) {
    const text = clean(value);
    if (!text || text.length > 180 || SENSITIVE.test(text)) return;
    recentCanvasText.push({ text, at: Date.now() });
    while (recentCanvasText.length > 800) recentCanvasText.shift();
  }

  function hookCanvas(proto, label = 'unknown') {
    if (!proto || proto.__atsMarketTextHookedV5) return;
    try { Object.defineProperty(proto, '__atsMarketTextHookedV5', { value: true }); } catch { return; }
    canvasDiagnostic.hookInstalled = true;
    if (!canvasDiagnostic.hookedContexts.includes(label)) canvasDiagnostic.hookedContexts.push(label);
    for (const name of ['fillText', 'strokeText']) {
      const native = proto[name];
      if (typeof native !== 'function') continue;
      proto[name] = function(text, ...args) {
        try {
          const at = Date.now();
          canvasDiagnostic.interceptedTotal += 1;
          if (name === 'fillText') canvasDiagnostic.fillTextTotal += 1;
          if (name === 'strokeText') canvasDiagnostic.strokeTextTotal += 1;
          canvasDiagnostic.recentCallTimes.push(at);
          while (canvasDiagnostic.recentCallTimes.length && canvasDiagnostic.recentCallTimes[0] < at - 6000) {
            canvasDiagnostic.recentCallTimes.shift();
          }
        } catch {}
        try { rememberCanvasText(text); } catch {}
        return native.call(this, text, ...args);
      };
    }
  }

  try { hookCanvas(window.CanvasRenderingContext2D?.prototype, 'CanvasRenderingContext2D'); } catch {}
  try { hookCanvas(window.OffscreenCanvasRenderingContext2D?.prototype, 'OffscreenCanvasRenderingContext2D'); } catch {}

  function domParts() {
    const parts = [];
    const body = clean(document.body?.innerText || document.body?.textContent || '');
    if (body) parts.push(body.slice(0, 220000));

    let nodes = [];
    try {
      nodes = document.querySelectorAll(
        '[aria-label],[title],[data-symbol],[data-asset],[data-pair],[data-testid],[data-state],button,[role="button"],[role="tab"],input,select'
      );
    } catch {}

    for (let i = 0; i < nodes.length && i < 4500; i++) {
      const el = nodes[i];
      if (el.id === '__ats_rendered_market__' || el.closest?.('#__ats_rendered_market__')) continue;
      for (const v of [
        el.innerText,
        el.textContent,
        el.getAttribute?.('aria-label'),
        el.getAttribute?.('title'),
        el.getAttribute?.('data-symbol'),
        el.getAttribute?.('data-asset'),
        el.getAttribute?.('data-pair'),
        el.value
      ]) {
        const t = clean(v);
        if (t && t.length <= 240 && !SENSITIVE.test(t)) parts.push(t);
      }
    }
    return parts;
  }

  function bestAsset(text) {
    const counts = new Map();
    const selected = new Map();
    for (const asset of assetsIn(text)) counts.set(asset, (counts.get(asset) || 0) + 1);

    let nodes = [];
    try { nodes = document.querySelectorAll('*'); } catch {}
    for (let i = 0; i < nodes.length && i < 7000; i++) {
      const el = nodes[i];
      if (!isVisibleElement(el)) continue;
      const t = clean(el.innerText || el.textContent || '');
      if (!t || t.length > 100) continue;
      let found = [...new Set(assetsIn(t))];
      const cls = `${el.className || ''} ${el.getAttribute?.('aria-selected') || ''} ${el.getAttribute?.('aria-current') || ''} ${el.getAttribute?.('data-state') || ''}`;
      const isSelected = /true|active|selected|current|checked/i.test(cls);
      if (found.length === 0 && (isSelected || /chart|header|instrument|symbol|asset|market|watchlist|option|digital|blitz|binary/i.test(cls) || /tab|button|option/i.test(String(el.getAttribute?.('role') || '')))) {
        const named = canonicalAsset(t);
        if (named) found = [named];
      }
      if (found.length !== 1) continue;
      let extra = 0;
      if (isSelected) extra += 12;
      try {
        const r = el.getBoundingClientRect();
        if (r.top >= 0 && r.top < innerHeight * .5) extra += 3;
      } catch {}
      for (const asset of found) {
        counts.set(asset, (counts.get(asset) || 0) + extra + 1);
        if (isSelected) selected.set(asset, (selected.get(asset) || 0) + 1);
      }
    }

    const rows = [...counts.entries()].map(([asset, count]) => ({
      asset,
      selected: (selected.get(asset) || 0) > 0,
      score: count * 10 + (selected.get(asset) || 0) * 120 + (/\(OTC\)$/i.test(asset) ? 14 : 0)
    })).sort((a, b) => Number(b.selected) - Number(a.selected) || b.score - a.score);
    return rows[0] || null;
  }

  function labeledQuote(text) {
    const match = (label) => {
      const re = new RegExp(`(?:${label})[^0-9]{0,32}([0-9]{1,7}[.,][0-9]{3,8})`, 'i');
      return num(String(text || '').match(re)?.[1]);
    };
    const buy = match('COMPRAR|BUY');
    const sell = match('VENDER|SELL');
    if (buy != null && sell != null) return { price: (buy + sell) / 2, buy, sell, score: 120 };
    if (buy != null || sell != null) return { price: buy ?? sell, buy, sell, score: 105 };
    return null;
  }

  function highPrecisionPrice(text) {
    const rows = [];
    for (const m of String(text || '').matchAll(/\b\d{1,7}[.,]\d{3,8}\b/g)) {
      const raw = m[0];
      const value = num(raw);
      if (value == null || value <= 0 || value > 1e9) continue;
      const decimals = (raw.split(/[.,]/)[1] || '').length;
      let score = decimals >= 5 ? 60 : decimals === 4 ? 48 : decimals === 3 ? 30 : 0;
      if (value > 100000) score -= 20;
      rows.push({ price: value, score });
    }
    rows.sort((a, b) => b.score - a.score);
    return rows[0] || null;
  }

  function timeframeFrom(text) {
    const m = String(text || '').match(/(?:^|\s)(M(?:1|2|5|15|30)|(?:1|2|5|15|30)\s*(?:m|min))(?:\s|$)/i);
    return normalizeTf(m?.[1]) || null;
  }

  function expirationFrom(text) {
    const raw = String(text || '');
    const labeled = raw.match(/(?:EXPIRA(?:ÇÃO|CAO)|EXPIRY|EXPIRATION|DURA(?:ÇÃO|CAO)|DURATION|TEMPO DE EXPIRA(?:ÇÃO|CAO)|TEMPO DA OPERA(?:ÇÃO|CAO))[^0-9]{0,80}(\d{1,4})\s*(s|seg|segundo|segundos|m|min|minuto|minutos)/i);
    if (labeled) return normalizeExp(`${labeled[1]}${labeled[2]}`);
    // Canvas/custom controls can be painted value-first even when they look
    // label-first on screen. Accept the reverse order only next to an explicit
    // expiration semantic so unrelated durations cannot become authority.
    const reversed = raw.match(/(\d{1,4})\s*(s|seg|segundo|segundos|m|min|minuto|minutos)[^0-9]{0,80}(?:EXPIRA(?:ÇÃO|CAO)|EXPIRY|EXPIRATION|DURA(?:ÇÃO|CAO)|DURATION|TEMPO DE EXPIRA(?:ÇÃO|CAO)|TEMPO DA OPERA(?:ÇÃO|CAO))/i);
    return reversed ? normalizeExp(`${reversed[1]}${reversed[2]}`) : null;
  }

  function candidateFromObject(o) {
    if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
    const asset = canonicalAsset(pick(o, ASSET_KEYS));
    if (!asset) return null;
    const bid = num(pick(o, BID_KEYS));
    const ask = num(pick(o, ASK_KEYS));
    let price = num(pick(o, PRICE_KEYS));
    if (price == null && bid != null && ask != null) price = (bid + ask) / 2;
    if (price == null || price <= 0) return null;
    return {
      asset,
      price,
      buy: ask ?? price,
      sell: bid ?? price,
      timeframe: normalizeTf(pick(o, TF_KEYS)),
      expiration: normalizeExp(pick(o, EXP_KEYS)),
      selected: ['selected','active','isActive','current','isCurrent'].some(k => o[k] === true || o[k] === 1),
      score: 90
    };
  }

  function scanAppState() {
    const now = Date.now();
    if (now - lastAppScanAt < 900) return appCandidates;
    lastAppScanAt = now;

    const roots = [];
    try {
      if (window.__NEXT_DATA__) roots.push(window.__NEXT_DATA__);
      if (window.__INITIAL_STATE__) roots.push(window.__INITIAL_STATE__);
      if (window.__PRELOADED_STATE__) roots.push(window.__PRELOADED_STATE__);
      if (window.store && typeof window.store.getState === 'function') roots.push(window.store.getState());
    } catch {}

    let els = [];
    try { els = document.querySelectorAll('*'); } catch {}
    for (let i = 0; i < els.length && i < 800; i++) {
      const el = els[i];
      let props = [];
      try { props = Object.getOwnPropertyNames(el); } catch {}
      for (const k of props) {
        if (/^__react(?:Props|Fiber)|^__vueParentComponent/.test(k)) {
          try { if (el[k]) roots.push(el[k]); } catch {}
        }
      }
    }

    const stack = roots.slice(0, 120).map(v => ({ v, d: 0 }));
    const seen = new WeakSet();
    const found = [];
    let visited = 0;

    while (stack.length && visited < 3000) {
      const { v, d } = stack.pop();
      if (!v || typeof v !== 'object' || d > 5) continue;
      if (seen.has(v)) continue;
      seen.add(v);
      visited++;

      const c = candidateFromObject(v);
      if (c) found.push(c);

      let entries = [];
      try { entries = Object.entries(v).slice(0, 80); } catch {}
      for (const [k, child] of entries) {
        if (SENSITIVE.test(k)) continue;
        if (child && typeof child === 'object' && !(child instanceof Node) && child !== window && child !== document) {
          stack.push({ v: child, d: d + 1 });
        }
      }
    }

    appCandidates = found.slice(0, 100);
    return appCandidates;
  }

  function localObservation() {
    const cutoff = Date.now() - 6000;
    while (recentCanvasText.length && recentCanvasText[0].at < cutoff) recentCanvasText.shift();

    const canvasText = recentCanvasText.map(x => x.text).join(' ');
    const domText = domParts().join(' ');
    const text = clean(`${domText} ${canvasText}`).slice(0, 350000);

    const app = scanAppState().sort((a, b) => Number(b.selected) - Number(a.selected) || b.score - a.score)[0] || null;
    const assetRow = bestAsset(text);
    const labeled = labeledQuote(text);
    const precise = labeled ? null : highPrecisionPrice(canvasText || text);

    const asset = app?.asset || assetRow?.asset || null;
    const quote = app?.price != null
      ? { price: app.price, buy: app.buy, sell: app.sell, score: 110 }
      : (labeled || precise);

    return {
      frameId,
      at: Date.now(),
      href: location.href,
      asset,
      assetSelected: app?.selected === true || assetRow?.selected === true,
      assetScore: Number(app?.selected ? 220 : app?.score || assetRow?.score || 0),
      price: num(quote?.price),
      buy: num(quote?.buy),
      sell: num(quote?.sell),
      priceScore: Number(quote?.score || 0),
      timeframe: app?.timeframe || timeframeFrom(text),
      expiration: app?.expiration || expirationFrom(text),
      canvasTexts: recentCanvasText.length
    };
  }

  function postObservation(obs) {
    try { window.top.postMessage({ source: FRAME_SOURCE, payload: obs }, '*'); } catch {}
  }

  function updateCandle(asset, price, timeframe = 'M1') {
    if (!asset || !Number.isFinite(price)) return;
    const tf = normalizeTf(timeframe) || 'M1';
    const size = /^M(\d+)$/.test(tf) ? Number(tf.slice(1)) * 60000 : 60000;
    const time = Math.floor(Date.now() / size) * size;
    const rows = localCandles.get(asset) || [];
    let row = rows.find(x => x.time === time);
    if (!row) {
      row = { time, open: price, high: price, low: price, close: price, timeframe: tf };
      rows.push(row);
    } else {
      row.high = Math.max(row.high, price);
      row.low = Math.min(row.low, price);
      row.close = price;
    }
    rows.sort((a, b) => a.time - b.time);
    localCandles.set(asset, rows.slice(-180));
  }

  function ensureMarker() {
    let marker = document.getElementById('__ats_rendered_market__');
    if (marker) return marker;
    if (!document.documentElement && !document.body) return null;
    marker = document.createElement('span');
    marker.id = '__ats_rendered_market__';
    marker.setAttribute('aria-hidden', 'true');
    marker.style.cssText = 'position:fixed;left:-10000px;top:0;width:2px;height:2px;overflow:hidden;opacity:.001;pointer-events:none;white-space:nowrap;font-size:1px;z-index:-2147483647';
    (document.documentElement || document.body).appendChild(marker);
    return marker;
  }

  let lastControlPublishKey = '';
  let lastControlPublishAt = 0;

  function publishRenderedControls(rows = [], now = Date.now()) {
    const expirationRow = rows.filter(r => r.expiration)
      .sort((a, b) => Number(b.at || 0) - Number(a.at || 0))[0] || null;
    const timeframeRow = rows.filter(r => r.timeframe)
      .sort((a, b) => Number(b.at || 0) - Number(a.at || 0))[0] || null;
    const expiration = expirationRow?.expiration || null;
    const timeframe = timeframeRow?.timeframe || null;
    if (!expiration && !timeframe) return;

    const key = `${expiration || ''}|${timeframe || ''}`;
    if (key === lastControlPublishKey && now - lastControlPublishAt < 500) return;
    lastControlPublishKey = key;
    lastControlPublishAt = now;

    if (expiration) {
      canvasDiagnostic.expirationPublishes += 1;
      canvasDiagnostic.lastExpirationPublishedAt = now;
      canvasDiagnostic.lastExpirationPayload = {
        expiration,
        confidence: 98,
        sourceKey: 'rendered-controls-independent'
      };
    }

    window.postMessage({
      source: 'ATS_NETWORK_PROBE',
      type: 'summary',
      payload: {
        messages: { ws: 0, fetch: 0, xhr: 0 },
        connections: { ws: 0 },
        endpoints: [],
        keys: [],
        candidates: [],
        candidateCount: 0,
        recentCandles: {},
        controls: {
          expiration,
          timeframe,
          confidence: expiration ? 98 : 0,
          timeframeConfidence: timeframe ? 90 : 0,
          observedAt: now,
          sourceKey: 'rendered-controls-independent'
        },
        feedQuality: 0,
        parser: { renderedControls: true, frames: rows.length },
        primaryTransport: 'rendered-controls',
        privacy: 'Leitura local apenas dos controles renderizados de tempo da CasaTrade.'
      }
    }, '*');
  }

  function aggregateAndPublish() {
    if (!isTop) return;
    const now = Date.now();
    for (const [id, row] of frameRows) if (!row || now - Number(row.at || 0) > 5000) frameRows.delete(id);
    const rows = [...frameRows.values()];
    if (!rows.length) return;

    // Controls are independent from market-data acquisition. Never discard a
    // visible "Expiração 5 seg / 1 min" just because asset/price came from a
    // different network/iframe pipeline.
    publishRenderedControls(rows, now);

    const assetRow = rows.filter(r => r.asset).sort((a, b) => b.assetScore - a.assetScore || b.at - a.at)[0] || null;
    const priceRow = rows.filter(r => r.price != null).sort((a, b) => b.priceScore - a.priceScore || b.at - a.at)[0] || null;
    const asset = assetRow?.asset || null;
    const price = num(priceRow?.price);
    if (!asset || price == null) return;

    const buy = num(priceRow?.buy) ?? price;
    const sell = num(priceRow?.sell) ?? price;
    const timeframe = rows.map(r => r.timeframe).find(Boolean) || 'M1';
    const expiration = rows.map(r => r.expiration).find(Boolean) || null;

    updateCandle(asset, price, timeframe);
    const marker = ensureMarker();
    if (marker) {
      marker.dataset.symbol = asset;
      marker.dataset.price = String(price);
      marker.textContent = `${asset} COMPRAR ${Number(buy).toFixed(6)} VENDER ${Number(sell).toFixed(6)} ${timeframe}${expiration ? ` Expiração ${expiration === '60s' ? '1 min' : expiration}` : ''}`;
    }

    const recentCandles = {};
    for (const [key, values] of localCandles) if (values.length) recentCandles[key] = values.slice(-120);

    window.postMessage({
      source: 'ATS_NETWORK_PROBE',
      type: 'summary',
      payload: {
        messages: { ws: 0, fetch: 0, xhr: 0 },
        connections: { ws: 0 },
        endpoints: [],
        keys: [],
        candidates: [{
          asset,
          price,
          bid: sell,
          ask: buy,
          timeframe,
          expiration,
          selected: assetRow?.assetSelected === true,
          confidence: assetRow?.assetSelected === true ? 96 : 82,
          observedAt: Date.now(),
          transport: 'rendered'
        }],
        candidateCount: 1,
        controls: expiration ? {
          expiration,
          confidence: 96,
          observedAt: Date.now(),
          sourceKey: 'rendered-expiration-control'
        } : null,
        recentCandles,
        feedQuality: 80,
        parser: {
          rendered: true,
          frames: rows.length,
          canvasTexts: rows.reduce((sum, r) => sum + Number(r.canvasTexts || 0), 0)
        },
        primaryTransport: 'rendered',
        privacy: 'Leitura local do mercado renderizado. Sem cookies, credenciais, tokens ou saldo.'
      }
    }, '*');
  }

  async function tick() {
    const obs = localObservation();
    if (isTop) {
      frameRows.set(frameId, obs);
      aggregateAndPublish();
    } else {
      postObservation(obs);
    }
  }

  if (isTop) {
    window.addEventListener('message', event => {
      if (event.data?.source !== FRAME_SOURCE) return;
      const obs = event.data?.payload;
      if (!obs?.frameId || !Number(obs.at)) return;
      frameRows.set(obs.frameId, obs);
      aggregateAndPublish();
    });
  }

  function canvasDiagnosticSnapshot() {
    const now = Date.now();
    const cutoff = now - 6000;
    const recentCalls = canvasDiagnostic.recentCallTimes.filter(at => at >= cutoff);

    const distinct = [];
    const seen = new Set();
    for (let i = recentCanvasText.length - 1; i >= 0 && distinct.length < 40; i--) {
      const row = recentCanvasText[i];
      const text = clean(row?.text);
      if (!text || seen.has(text)) continue;
      seen.add(text);
      distinct.push({ text, ageMs: Math.max(0, now - Number(row?.at || now)) });
    }
    distinct.reverse();

    const concatenated = recentCanvasText.map(row => clean(row?.text)).filter(Boolean).join(' ');
    const lastPayload = canvasDiagnostic.lastExpirationPayload
      ? {
          ...canvasDiagnostic.lastExpirationPayload,
          ageMs: Math.max(0, now - Number(canvasDiagnostic.lastExpirationPublishedAt || now))
        }
      : null;

    return {
      hookInstalled: canvasDiagnostic.hookInstalled === true,
      frame: {
        frameId,
        href: String(location.href || ''),
        isTop,
        host: String(location.hostname || '').toLowerCase()
      },
      hookedContexts: canvasDiagnostic.hookedContexts.slice(),
      intercepted: {
        total: Number(canvasDiagnostic.interceptedTotal || 0),
        fillText: Number(canvasDiagnostic.fillTextTotal || 0),
        strokeText: Number(canvasDiagnostic.strokeTextTotal || 0),
        last6s: recentCalls.length
      },
      recentCanvasText: distinct,
      concatenatedTextLength: concatenated.length,
      expirationFrom: expirationFrom(concatenated),
      timeframeFrom: timeframeFrom(concatenated),
      publishRenderedControls: {
        expirationSendCount: Number(canvasDiagnostic.expirationPublishes || 0),
        lastPayload
      },
      startedAt: canvasDiagnostic.startedAt,
      observedAt: now
    };
  }

  const diagnosticMessageHandler = event => {
    const data = event.data;
    if (!data || data.source !== 'ATS_EXPIRATION_DIAGNOSTIC_REQUEST' || !data.requestId) return;
    try {
      window.postMessage({
        source: 'ATS_CANVAS_DIAGNOSTIC_SNAPSHOT',
        requestId: data.requestId,
        payload: canvasDiagnosticSnapshot()
      }, '*');
    } catch {}
  };
  window.addEventListener('message', diagnosticMessageHandler);

  const start = () => {
    ensureMarker();
    try { tick(); } catch {}
    setInterval(() => {
      try { tick(); } catch {}
    }, 250);
  };

  if (document.documentElement) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
})();
