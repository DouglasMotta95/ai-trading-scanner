(() => {
  if (window.__ATS_NETWORK_PROBE__) return;
  window.__ATS_NETWORK_PROBE__ = true;

  const SENSITIVE = /token|auth|cookie|session|password|secret|bearer|csrf|api[-_]?key|credential/i;
  const ALIASES = {
    asset: ['symbol', 'asset', 'instrument', 'ticker', 'pair'],
    price: ['price', 'last', 'lastPrice', 'last_price', 'quote', 'close'],
    bid: ['bid', 'bidPrice', 'bid_price'],
    ask: ['ask', 'askPrice', 'ask_price'],
    open: ['open'], high: ['high'], low: ['low'], close: ['close'],
    timeframe: ['timeframe', 'interval', 'period'],
    timestamp: ['timestamp', 'time', 'ts'],
    expiration: ['expiration', 'expiry', 'expiresAt', 'expires_at'],
    payout: ['payout', 'profit', 'return']
  };
  const stats = {
    messages: { ws: 0, fetch: 0, xhr: 0 },
    connections: { ws: 0 },
    endpoints: new Set(),
    keys: new Set(),
    assets: new Map(),
    candles: new Map()
  };

  const trimSet = (set, max) => { while (set.size > max) set.delete(set.values().next().value); };
  const safeUrl = u => {
    try { const x = new URL(String(u || ''), location.href); return x.origin + x.pathname; } catch { return ''; }
  };
  const num = v => {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    const s = String(v ?? '').trim().replace(/\s/g, '').replace(/[^\d,.-]/g, '');
    if (!s) return null;
    let n = s;
    if (n.includes(',') && n.includes('.')) n = n.lastIndexOf(',') > n.lastIndexOf('.') ? n.replace(/\./g, '').replace(',', '.') : n.replace(/,/g, '');
    else n = n.replace(',', '.');
    const x = Number(n);
    return Number.isFinite(x) ? x : null;
  };
  const pick = (o, names) => {
    for (const k of names) if (Object.prototype.hasOwnProperty.call(o, k) && o[k] != null) return o[k];
    const lower = new Map(Object.keys(o).map(k => [k.toLowerCase(), k]));
    for (const k of names) { const real = lower.get(k.toLowerCase()); if (real && o[real] != null) return o[real]; }
    return null;
  };
  const normalizeTime = v => {
    let t = num(v);
    if (t == null) return null;
    if (t > 0 && t < 1e12) t *= 1000;
    return Number.isFinite(t) ? t : null;
  };

  const candidate = o => {
    if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
    const asset = pick(o, ALIASES.asset);
    if (asset == null) return null;
    const bid = num(pick(o, ALIASES.bid));
    const ask = num(pick(o, ALIASES.ask));
    let price = num(pick(o, ALIASES.price));
    if (price == null && bid != null && ask != null) price = (bid + ask) / 2;
    const open = num(pick(o, ALIASES.open)), high = num(pick(o, ALIASES.high)), low = num(pick(o, ALIASES.low)), close = num(pick(o, ALIASES.close));
    if (price == null && close != null) price = close;
    if (price == null && bid == null && ask == null && close == null) return null;

    const a = String(asset).trim().slice(0, 48);
    if (!a || SENSITIVE.test(a)) return null;
    const c = { asset: a, observedAt: Date.now() };
    if (price != null) c.price = price;
    if (bid != null) c.bid = bid;
    if (ask != null) c.ask = ask;
    if (open != null) c.open = open;
    if (high != null) c.high = high;
    if (low != null) c.low = low;
    if (close != null) c.close = close;
    for (const [field, names] of Object.entries(ALIASES)) {
      if (['asset', 'price', 'bid', 'ask', 'open', 'high', 'low', 'close'].includes(field)) continue;
      const v = pick(o, names);
      if (v == null) continue;
      if (field === 'payout') { const n = num(v); if (n != null) c[field] = n; }
      else c[field] = String(v).slice(0, 48);
    }
    return c;
  };
  const recordCandle = c => {
    if (![c?.open, c?.high, c?.low, c?.close].every(Number.isFinite)) return;
    const time = normalizeTime(c.timestamp) || null;
    if (!time) return;
    const asset = String(c.asset || '').trim();
    if (!asset) return;
    const rows = stats.candles.get(asset) || [];
    const key = `${time}|${c.timeframe || ''}`;
    const item = { time, open: c.open, high: c.high, low: c.low, close: c.close, timeframe: c.timeframe || null };
    const i = rows.findIndex(x => `${x.time}|${x.timeframe || ''}` === key);
    if (i >= 0) rows[i] = item; else rows.push(item);
    rows.sort((a, b) => a.time - b.time);
    stats.candles.set(asset, rows.slice(-120));
    while (stats.candles.size > 30) stats.candles.delete(stats.candles.keys().next().value);
  };

  const parse = data => {
    if (typeof data === 'string') {
      const s = data.trim();
      if (!s) return null;
      if ((s[0] === '{' && s.at(-1) === '}') || (s[0] === '[' && s.at(-1) === ']')) { try { return JSON.parse(s); } catch { return null; } }
      return null;
    }
    if (data && typeof data === 'object' && !ArrayBuffer.isView(data) && !(data instanceof ArrayBuffer) && !(data instanceof Blob)) return data;
    return null;
  };

  const scan = (data, meta = {}) => {
    const root = parse(data);
    if (root == null) return;
    const stack = [{ v: root, d: 0 }];
    const found = new Map();
    let seen = 0;
    while (stack.length && seen < 900) {
      const { v, d } = stack.pop(); seen++;
      if (!v || typeof v !== 'object' || d > 7) continue;
      if (Array.isArray(v)) {
        for (let i = Math.min(v.length, 180) - 1; i >= 0; i--) stack.push({ v: v[i], d: d + 1 });
        continue;
      }
      const c = candidate(v);
      if (c) { found.set(c.asset, c); recordCandle(c); }
      for (const [k, val] of Object.entries(v)) {
        if (SENSITIVE.test(k)) continue;
        if (k.length <= 64) stats.keys.add(k);
        if (val && typeof val === 'object') stack.push({ v: val, d: d + 1 });
      }
    }
    trimSet(stats.keys, 300);
    for (const [asset, c] of found) {
      const previous = stats.assets.get(asset);
      stats.assets.set(asset, {
        ...previous, ...c,
        transport: meta.transport || previous?.transport || null,
        endpoint: meta.endpoint || previous?.endpoint || null,
        firstObservedAt: previous?.firstObservedAt || c.observedAt,
        seenCount: Math.min(1000000, Number(previous?.seenCount || 0) + 1)
      });
    }
  };

  const flushTimer = () => {
    if (flushTimer.id) return;
    flushTimer.id = setTimeout(() => {
      flushTimer.id = null;
      const ts = Date.now();
      for (const [asset, c] of stats.assets) if (ts - Number(c.observedAt || 0) > 15000) stats.assets.delete(asset);
      trimSet(stats.endpoints, 100);
      const recentCandles = {};
      for (const [asset, rows] of [...stats.candles.entries()].slice(-12)) recentCandles[asset] = rows.slice(-60);
      window.postMessage({
        source: 'ATS_NETWORK_PROBE', type: 'summary',
        payload: {
          messages: { ...stats.messages }, connections: { ...stats.connections }, endpoints: [...stats.endpoints].slice(-20),
          keys: [...stats.keys].slice(0, 120), candidates: [...stats.assets.values()].slice(0, 100), candidateCount: stats.assets.size,
          recentCandles,
          privacy: 'Headers, cookies, request bodies, query strings and auth/session fields are not collected.'
        }
      }, '*');
    }, 500);
  };

  const record = (transport, url, data) => {
    if (stats.messages[transport] != null) stats.messages[transport]++;
    const clean = safeUrl(url); if (clean) stats.endpoints.add(`${transport}:${clean}`);
    trimSet(stats.endpoints, 100); scan(data, { transport, endpoint: clean }); flushTimer();
  };

  if (window.WebSocket) {
    const Native = window.WebSocket;
    const Wrapped = function(url, protocols) {
      const ws = protocols === undefined ? new Native(url) : new Native(url, protocols);
      stats.connections.ws++;
      const clean = safeUrl(url); if (clean) stats.endpoints.add(`ws:${clean}`);
      trimSet(stats.endpoints, 100); flushTimer();
      ws.addEventListener('message', e => {
        if (typeof e.data === 'string') record('ws', url, e.data);
        else if (e.data instanceof Blob && e.data.size <= 262144) e.data.text().then(t => record('ws', url, t)).catch(() => {});
      });
      ws.addEventListener('close', () => { stats.connections.ws = Math.max(0, stats.connections.ws - 1); flushTimer(); }, { once: true });
      return ws;
    };
    Wrapped.prototype = Native.prototype;
    Object.setPrototypeOf(Wrapped, Native);
    for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) { try { Object.defineProperty(Wrapped, k, { value: Native[k] }); } catch {} }
    window.WebSocket = Wrapped;
  }

  if (window.fetch) {
    const nativeFetch = window.fetch;
    window.fetch = async function(...args) {
      const r = await nativeFetch.apply(this, args);
      try {
        const u = args[0] instanceof Request ? args[0].url : args[0];
        const ct = r.headers.get('content-type') || '';
        if (/json|text|javascript/i.test(ct)) {
          const clone = r.clone();
          clone.text().then(t => { if (t.length <= 262144) record('fetch', u, t); }).catch(() => {});
        }
      } catch {}
      return r;
    };
  }

  if (window.XMLHttpRequest) {
    const X = window.XMLHttpRequest, open = X.prototype.open, send = X.prototype.send;
    X.prototype.open = function(method, url, ...rest) { this.__atsUrl = url; return open.call(this, method, url, ...rest); };
    X.prototype.send = function(...args) {
      this.addEventListener('load', () => {
        try {
          const ct = this.getResponseHeader('content-type') || '';
          if (!/json|text|javascript/i.test(ct)) return;
          if (this.responseType === '' || this.responseType === 'text') { const t = String(this.responseText || ''); if (t.length <= 262144) record('xhr', this.__atsUrl, t); }
          else if (this.responseType === 'json') record('xhr', this.__atsUrl, this.response);
        } catch {}
      }, { once: true });
      return send.apply(this, args);
    };
  }

  window.postMessage({ source: 'ATS_NETWORK_PROBE', type: 'ready', payload: { ready: true } }, '*');
})();
