(() => {
  if (window.__ATS_RENDERED_MARKET_PROBE__) return;
  window.__ATS_RENDERED_MARKET_PROBE__ = true;

  const isCasaTradeHost = host => {
    const h = String(host || '').toLowerCase().replace(/\.$/, '');
    return h === 'casatrade.com' || h.endsWith('.casatrade.com') || h === 'casatrade.io' || h.endsWith('.casatrade.io');
  };
  let allowed = isCasaTradeHost(location.hostname);
  if (!allowed && document.referrer) {
    try { allowed = isCasaTradeHost(new URL(document.referrer).hostname); } catch {}
  }
  if (!allowed) return;

  const SENSITIVE = /token|auth|cookie|session|password|secret|bearer|csrf|api[-_]?key|credential|authorization/i;
  const QUOTES = ['USDT','USDC','USD','EUR','GBP','JPY','AUD','CAD','CHF','NZD','BRL','BTC','ETH'];
  const ASSET_KEYS = ['symbol','symbolName','symbol_name','asset','assetName','asset_name','instrument','instrumentName','instrument_name','ticker','pair','market'];
  const PRICE_KEYS = ['price','last','lastPrice','last_price','quote','close','value','rate','current','currentPrice','current_price'];
  const BID_KEYS = ['bid','bidPrice','bid_price','bestBid','best_bid'];
  const ASK_KEYS = ['ask','askPrice','ask_price','bestAsk','best_ask'];
  const TF_KEYS = ['timeframe','interval','period','resolution','tf'];
  const EXP_KEYS = ['expiration','expiry','duration','expiresIn','expires_in'];
  const TIME_KEYS = ['timestamp','time','ts','createdAt','created_at'];

  const recentText = [];
  const localCandles = new Map();
  const objectCandidates = [];
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
    const lower = new Map(Object.keys(o).slice(0, 120).map(k => [k.toLowerCase(), k]));
    for (const k of keys) {
      const real = lower.get(k.toLowerCase());
      if (real && o[real] != null) return o[real];
    }
    return null;
  };
  const canonicalAsset = value => {
    let raw = clean(value).toUpperCase();
    if (!raw || raw.length > 80 || SENSITIVE.test(raw)) return '';
    const otc = /(?:\(|\b|[_-])OTC(?:\)|\b)?/.test(raw);
    raw = raw.replace(/^FRX[:_-]?/, '').replace(/^OTC[:_-]?/, '');
    let s = raw.replace(/\(OTC\)|\bOTC\b/g, '').replace(/\s+/g, '').replace(/_/g, '/').replace(/-/g, '/').replace(/:+/g, '/');
    s = s.replace(/^\/+|\/+$/g, '').replace(/\/{2,}/g, '/');
    if (!s.includes('/')) {
      const q = QUOTES.find(x => s.length > x.length && s.endsWith(x));
      if (q) s = `${s.slice(0, -q.length)}/${q}`;
      else if (/^[A-Z]{6}$/.test(s)) s = `${s.slice(0,3)}/${s.slice(3)}`;
    }
    const m = s.match(/^([A-Z0-9]{2,16})\/([A-Z0-9]{2,12})$/);
    if (!m || !QUOTES.includes(m[2])) return '';
    return `${m[1]}/${m[2]}${otc ? ' (OTC)' : ''}`;
  };
  const assetFromText = value => {
    const t = clean(value).toUpperCase();
    const m = t.match(/\b[A-Z0-9]{2,16}\s*[\/_-]\s*(?:USDT|USDC|USD|EUR|GBP|JPY|AUD|CAD|CHF|NZD|BRL|BTC|ETH)(?:\s*\(?OTC\)?)?/);
    if (m) return canonicalAsset(m[0]);
    const c = t.match(/\b[A-Z]{6}(?:[_-]?OTC)?\b/);
    return c ? canonicalAsset(c[0]) : '';
  };
  const normalizeTf = value => {
    const s = clean(value).toUpperCase().replace(/\s+/g, '');
    let m = s.match(/^M(1|2|5|15|30)$/); if (m) return `M${m[1]}`;
    m = s.match(/^(1|2|5|15|30)(?:M|MIN)$/); if (m) return `M${m[1]}`;
    if (/^(H1|1H|60M|60MIN)$/.test(s)) return 'H1';
    return null;
  };
  const normalizeExp = value => {
    const s = clean(value).toLowerCase().replace(/\s+/g, '');
    let m = s.match(/^(\d{1,4})(?:s|seg|segundo|segundos)$/); if (m) return `${Number(m[1])}s`;
    m = s.match(/^(\d{1,3})(?:m|min|minuto|minutos)$/); if (m) return Number(m[1]) === 1 ? '60s' : `${Number(m[1])}m`;
    return null;
  };
  const normalizeTime = value => {
    let t = num(value);
    if (t == null) return null;
    if (t > 0 && t < 1e11) t *= 1000;
    return t > 946684800000 ? t : null;
  };

  function rememberText(value) {
    const text = clean(value);
    if (!text || text.length > 180 || SENSITIVE.test(text)) return;
    recentText.push({ text, at: Date.now() });
    while (recentText.length > 500) recentText.shift();
  }

  function hookCanvasProto(proto) {
    if (!proto || proto.__atsTextHooked) return;
    try { Object.defineProperty(proto, '__atsTextHooked', { value: true }); } catch { return; }
    for (const name of ['fillText','strokeText']) {
      const native = proto[name];
      if (typeof native !== 'function') continue;
      proto[name] = function(text, ...args) {
        try { rememberText(text); } catch {}
        return native.call(this, text, ...args);
      };
    }
  }
  try { hookCanvasProto(window.CanvasRenderingContext2D?.prototype); } catch {}
  try { hookCanvasProto(window.OffscreenCanvasRenderingContext2D?.prototype); } catch {}

  function collectDomText() {
    const parts = [];
    let nodes = [];
    try { nodes = document.querySelectorAll('[aria-label],[title],[data-symbol],[data-asset],[data-pair],[data-testid],button,[role="button"],[role="tab"],input,select'); } catch {}
    for (let i = 0; i < nodes.length && i < 3000; i++) {
      const el = nodes[i];
      for (const v of [el.innerText, el.textContent, el.getAttribute?.('aria-label'), el.getAttribute?.('title'), el.getAttribute?.('data-symbol'), el.getAttribute?.('data-asset'), el.getAttribute?.('data-pair'), el.value]) {
        const t = clean(v);
        if (t && t.length <= 180 && !SENSITIVE.test(t)) parts.push(t);
      }
    }
    return parts;
  }

  function addCandle(asset, candle) {
    const key = canonicalAsset(asset);
    if (!key) return;
    const rows = localCandles.get(key) || [];
    const idx = rows.findIndex(x => x.time === candle.time);
    const item = { time: candle.time, open: candle.open, high: candle.high, low: candle.low, close: candle.close, timeframe: candle.timeframe || 'M1' };
    if (idx >= 0) rows[idx] = item; else rows.push(item);
    rows.sort((a,b) => a.time - b.time);
    localCandles.set(key, rows.slice(-180));
  }

  function candidateFromObject(o) {
    if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
    const rawAsset = pick(o, ASSET_KEYS);
    const asset = canonicalAsset(rawAsset) || assetFromText(rawAsset);
    if (!asset) return null;
    const bid = num(pick(o, BID_KEYS));
    const ask = num(pick(o, ASK_KEYS));
    let price = num(pick(o, PRICE_KEYS));
    if (price == null && bid != null && ask != null) price = (bid + ask) / 2;
    const timeframe = normalizeTf(pick(o, TF_KEYS));
    const expiration = normalizeExp(pick(o, EXP_KEYS));
    const selected = ['selected','active','isActive','current','isCurrent'].some(k => o[k] === true || o[k] === 1);
    const open = num(o.open ?? o.o), high = num(o.high ?? o.h), low = num(o.low ?? o.l), close = num(o.close ?? o.c);
    const timestamp = normalizeTime(pick(o, TIME_KEYS));
    if (timestamp && [open,high,low,close].every(Number.isFinite)) addCandle(asset, { time: timestamp, open, high, low, close, timeframe: timeframe || 'M1' });
    if (price == null) return null;
    return { asset, price, bid, ask, timeframe, expiration, selected, at: Date.now() };
  }

  function scanAppState() {
    objectCandidates.length = 0;
    const roots = [];
    try {
      if (window.__NEXT_DATA__) roots.push(window.__NEXT_DATA__);
      if (window.__INITIAL_STATE__) roots.push(window.__INITIAL_STATE__);
      if (window.__PRELOADED_STATE__) roots.push(window.__PRELOADED_STATE__);
      if (window.store && typeof window.store.getState === 'function') roots.push(window.store.getState());
    } catch {}
    let els = [];
    try { els = document.querySelectorAll('*'); } catch {}
    for (let i = 0; i < els.length && i < 1200; i++) {
      const el = els[i];
      let props = [];
      try { props = Object.getOwnPropertyNames(el); } catch {}
      for (const k of props) {
        if (/^__react(?:Props|Fiber)|^__vueParentComponent/.test(k)) {
          try { if (el[k]) roots.push(el[k]); } catch {}
        }
      }
    }
    const stack = roots.slice(0, 180).map(v => ({ v, d: 0 }));
    const seen = new WeakSet();
    let visited = 0;
    while (stack.length && visited < 4500) {
      const { v, d } = stack.pop();
      if (!v || typeof v !== 'object' || d > 5) continue;
      if (seen.has(v)) continue;
      seen.add(v); visited++;
      const c = candidateFromObject(v);
      if (c) objectCandidates.push(c);
      let entries = [];
      try { entries = Object.entries(v).slice(0, 100); } catch {}
      for (const [k, child] of entries) {
        if (SENSITIVE.test(k)) continue;
        if (typeof child === 'string') rememberText(child);
        else if (child && typeof child === 'object' && !(child instanceof Node) && child !== window && child !== document) stack.push({ v: child, d: d + 1 });
      }
    }
  }

  function updateLiveCandle(asset, price, tf) {
    if (!asset || !Number.isFinite(price)) return;
    const timeframe = tf || 'M1';
    const size = /^M(\d+)$/.test(timeframe) ? Number(timeframe.slice(1)) * 60000 : 60000;
    const time = Math.floor(Date.now() / size) * size;
    const rows = localCandles.get(asset) || [];
    let row = rows.find(x => x.time === time);
    if (!row) {
      row = { time, open: price, high: price, low: price, close: price, timeframe };
      rows.push(row);
    } else {
      row.high = Math.max(row.high, price);
      row.low = Math.min(row.low, price);
      row.close = price;
    }
    rows.sort((a,b) => a.time - b.time);
    localCandles.set(asset, rows.slice(-180));
  }

  function parseTextState() {
    const cutoff = Date.now() - 5000;
    while (recentText.length && recentText[0].at < cutoff) recentText.shift();
    const text = [...recentText.map(x => x.text), ...collectDomText()].join(' ').replace(/\s+/g, ' ');
    const asset = assetFromText(text);
    const buy = num(text.match(/(?:COMPRAR|BUY)\s*([0-9]{1,6}[.,][0-9]{3,8})/i)?.[1]);
    const sell = num(text.match(/(?:VENDER|SELL)\s*([0-9]{1,6}[.,][0-9]{3,8})/i)?.[1]);
    const price = buy != null && sell != null ? (buy + sell) / 2 : (buy ?? sell ?? null);
    const tfMatch = text.match(/(?:^|\s)(M(?:1|2|5|15|30)|(?:1|2|5|15|30)\s*(?:m|min))(?:\s|$)/i);
    const timeframe = normalizeTf(tfMatch?.[1]);
    const expMatch = text.match(/(?:EXPIRA(?:ÇÃO|CAO)|EXPIRY|DURATION)\s*[:\-]?\s*(\d{1,4})\s*(s|seg|segundo|segundos|m|min|minuto|minutos)/i);
    const expiration = expMatch ? normalizeExp(`${expMatch[1]}${expMatch[2]}`) : null;
    return { asset, price, buy, sell, timeframe, expiration };
  }

  function expLabel(exp) {
    if (!exp) return '';
    if (exp === '60s') return '1 min';
    const m = String(exp).match(/^(\d+)s$/); if (m) return `${m[1]} seg`;
    return exp;
  }

  function ensureMarker() {
    let marker = document.getElementById('__ats_rendered_market__');
    if (marker) return marker;
    marker = document.createElement('span');
    marker.id = '__ats_rendered_market__';
    marker.setAttribute('aria-hidden', 'true');
    marker.style.cssText = 'position:fixed;left:-10000px;top:0;width:2px;height:2px;overflow:hidden;opacity:.001;pointer-events:none;white-space:nowrap;font-size:1px;z-index:-2147483647';
    (document.documentElement || document.body)?.appendChild(marker);
    return marker;
  }

  function publish() {
    try { scanAppState(); } catch {}
    const textState = parseTextState();
    const candidates = objectCandidates.filter(c => c.asset && Number.isFinite(c.price)).sort((a,b) => Number(b.selected) - Number(a.selected) || b.at - a.at);
    const best = candidates[0] || null;
    const asset = best?.asset || textState.asset || null;
    const price = best?.price ?? textState.price ?? null;
    const buy = best?.bid ?? textState.buy ?? price;
    const sell = best?.ask ?? textState.sell ?? price;
    const timeframe = best?.timeframe || textState.timeframe || 'M1';
    const expiration = best?.expiration || textState.expiration || null;
    if (!asset || !Number.isFinite(price)) return;

    updateLiveCandle(asset, price, timeframe);
    const marker = ensureMarker();
    if (marker) marker.textContent = `${asset} COMPRAR ${Number(buy ?? price).toFixed(6)} VENDER ${Number(sell ?? price).toFixed(6)} ${timeframe}${expiration ? ` Expiração ${expLabel(expiration)}` : ''}`;

    const recentCandles = {};
    for (const [k, rows] of localCandles) if (rows.length) recentCandles[k] = rows.slice(-120);
    window.postMessage({ source: 'ATS_NETWORK_PROBE', type: 'summary', payload: {
      messages: { ws: 0, fetch: 0, xhr: 0 }, connections: { ws: 0 }, endpoints: [], keys: [],
      candidates: [{ asset, price, bid: buy, ask: sell, timeframe, expiration, selected: true, confidence: 92, observedAt: Date.now(), transport: 'rendered' }],
      candidateCount: 1, recentCandles, feedQuality: 70,
      parser: { rendered: true, canvasTexts: recentText.length, appCandidates: candidates.length }, primaryTransport: 'rendered',
      privacy: 'Leitura local do mercado renderizado. Sem cookies, credenciais, tokens ou saldo.'
    } }, '*');
  }

  const start = () => { ensureMarker(); setInterval(publish, 300); };
  if (document.documentElement) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
})();
