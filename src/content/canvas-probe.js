(() => {
  if (window.__ATS_RENDERED_MARKET_PROBE_V4__) return;
  window.__ATS_RENDERED_MARKET_PROBE_V4__ = true;

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

  const FRAME_SOURCE = 'ATS_CT_RENDER_OBSERVATION_V4';
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
    if (!m || !QUOTES.includes(m[2])) return '';
    return `${m[1]}/${m[2]}${otc ? ' (OTC)' : ''}`;
  };

  const assetRegex = /\b(?:[A-Z0-9]{2,16}\s*[\/_-]\s*(?:USDT|USDC|USD|EUR|GBP|JPY|AUD|CAD|CHF|NZD|BRL|BTC|ETH)|[A-Z]{6})(?:\s*\(\s*OTC\s*\)|\s+OTC)?/gi;
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
    m = s.match(/^(\d{1,3})(?:m|min|minuto|minutos)$/); if (m) return Number(m[1]) === 1 ? '60s' : `${Number(m[1])}m`;
    return null;
  };

  function rememberCanvasText(value) {
    const text = clean(value);
    if (!text || text.length > 180 || SENSITIVE.test(text)) return;
    recentCanvasText.push({ text, at: Date.now() });
    while (recentCanvasText.length > 800) recentCanvasText.shift();
  }

  function hookCanvas(proto) {
    if (!proto || proto.__atsMarketTextHooked) return;
    try { Object.defineProperty(proto, '__atsMarketTextHooked', { value: true }); } catch { return; }
    for (const name of ['fillText', 'strokeText']) {
      const native = proto[name];
      if (typeof native !== 'function') continue;
      proto[name] = function(text, ...args) {
        try { rememberCanvasText(text); } catch {}
        return native.call(this, text, ...args);
      };
    }
  }

  try { hookCanvas(window.CanvasRenderingContext2D?.prototype); } catch {}
  try { hookCanvas(window.OffscreenCanvasRenderingContext2D?.prototype); } catch {}

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
    for (const asset of assetsIn(text)) counts.set(asset, (counts.get(asset) || 0) + 1);

    let nodes = [];
    try { nodes = document.querySelectorAll('*'); } catch {}
    for (let i = 0; i < nodes.length && i < 7000; i++) {
      const el = nodes[i];
      const t = clean(el.innerText || el.textContent || '');
      if (!t || t.length > 100) continue;
      const found = assetsIn(t);
      if (!found.length) continue;
      let extra = 0;
      const cls = `${el.className || ''} ${el.getAttribute?.('aria-selected') || ''} ${el.getAttribute?.('data-state') || ''}`;
      if (/true|active|selected|current|checked/i.test(cls)) extra += 8;
      try {
        const r = el.getBoundingClientRect();
        if (r.top >= 0 && r.top < innerHeight * .4) extra += 3;
      } catch {}
      for (const asset of found) counts.set(asset, (counts.get(asset) || 0) + extra + 1);
    }

    const rows = [...counts.entries()].map(([asset, count]) => ({
      asset,
      score: count * 10 + (/\(OTC\)$/i.test(asset) ? 14 : 0)
    })).sort((a, b) => b.score - a.score);
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
    const m = String(text || '').match(/(?:EXPIRA(?:ÇÃO|CAO)|EXPIRY|DURATION)[^0-9]{0,45}(\d{1,4})\s*(s|seg|segundo|segundos|m|min|minuto|minutos)/i);
    return m ? normalizeExp(`${m[1]}${m[2]}`) : null;
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
      assetScore: Number(app?.selected ? 160 : app?.score || assetRow?.score || 0),
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

  function aggregateAndPublish() {
    if (!isTop) return;
    const now = Date.now();
    for (const [id, row] of frameRows) if (!row || now - Number(row.at || 0) > 5000) frameRows.delete(id);
    const rows = [...frameRows.values()];
    if (!rows.length) return;

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
          selected: true,
          confidence: 96,
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
