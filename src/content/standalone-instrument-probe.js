(() => {
  if (globalThis.__ATS_STANDALONE_INSTRUMENT_PROBE__) return;
  globalThis.__ATS_STANDALONE_INSTRUMENT_PROBE__ = true;

  const SOURCE = 'ATS_NETWORK_PROBE';
  const SENSITIVE = /token|auth|cookie|session|password|secret|bearer|csrf|api[-_]?key|credential|authorization/i;
  const ALIASES = new Map([
    ['TRON', 'TRX/USD'], ['TRX', 'TRX/USD'],
    ['EURO', 'EUR/USD'], ['EUR', 'EUR/USD'],
    ['BITCOIN', 'BTC/USD'], ['BTC', 'BTC/USD'],
    ['ETHEREUM', 'ETH/USD'], ['ETH', 'ETH/USD'],
    ['RIPPLE', 'XRP/USD'], ['XRP', 'XRP/USD'],
    ['SOLANA', 'SOL/USD'], ['SOL', 'SOL/USD'],
    ['CARDANO', 'ADA/USD'], ['ADA', 'ADA/USD'],
    ['DOGECOIN', 'DOGE/USD'], ['DOGE', 'DOGE/USD'],
    ['SHIBA INU', 'SHIB/USD'], ['SHIB', 'SHIB/USD'],
    ['LITECOIN', 'LTC/USD'], ['LTC', 'LTC/USD'],
    ['CHAINLINK', 'LINK/USD'], ['LINK', 'LINK/USD'],
    ['AVALANCHE', 'AVAX/USD'], ['AVAX', 'AVAX/USD'],
    ['POLKADOT', 'DOT/USD'], ['DOT', 'DOT/USD']
  ]);
  const ASSET_KEYS = ['symbol','symbolName','symbol_name','asset','assetName','asset_name','instrument','instrumentName','instrument_name','ticker','pair','market','underlying','name'];
  const ID_KEYS = ['active_id','activeId','asset_id','assetId','instrument_id','instrumentId','symbol_id','symbolId','id'];
  const PRICE_KEYS = ['price','last','lastPrice','last_price','quote','close','value','rate','current','currentPrice','current_price','mid','markPrice'];
  const BID_KEYS = ['bid','bidPrice','bid_price','bestBid','best_bid'];
  const ASK_KEYS = ['ask','askPrice','ask_price','bestAsk','best_ask'];
  const TIME_KEYS = ['timestamp','time','ts','from','createdAt','created_at','serverTime','server_time','eventTime','event_time'];
  const TF_KEYS = ['timeframe','interval','period','resolution','tf','duration'];
  const SELECTED_KEYS = ['selected','active','isActive','is_active','current','isCurrent','is_current'];

  const clean = value => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  const upper = value => clean(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
  const num = value => {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    const raw = clean(value);
    if (!raw || raw.length > 64) return null;
    let text = raw.replace(/\s/g, '').replace(/[^\d,.-]/g, '');
    if (!text) return null;
    if (text.includes(',') && text.includes('.')) text = text.lastIndexOf(',') > text.lastIndexOf('.') ? text.replace(/\./g, '').replace(',', '.') : text.replace(/,/g, '');
    else text = text.replace(',', '.');
    const value0 = Number(text);
    return Number.isFinite(value0) ? value0 : null;
  };
  const pick = (object, keys) => {
    if (!object || typeof object !== 'object') return null;
    for (const key of keys) if (Object.prototype.hasOwnProperty.call(object, key) && object[key] != null) return object[key];
    const own = Object.keys(object).slice(0, 100);
    const lowered = new Map(own.map(key => [key.toLowerCase(), key]));
    for (const key of keys) {
      const actual = lowered.get(key.toLowerCase());
      if (actual && object[actual] != null) return object[actual];
    }
    return null;
  };
  const truthy = value => value === true || value === 1 || String(value).toLowerCase() === 'true';
  const normalizeTime = value => {
    let time = num(value);
    if (time == null || time <= 0) return null;
    while (time > 1e14) time /= 1000;
    if (time < 1e11) time *= 1000;
    return Number.isFinite(time) && time > 946684800000 ? Math.round(time) : null;
  };
  const normalizeTf = value => {
    const text = upper(value).replace(/\s+/g, '');
    if (!text) return null;
    let match = text.match(/^S(\d{1,5})$/) || text.match(/^(\d{1,5})S$/);
    if (match && Number(match[1]) > 0) return `S${Number(match[1])}`;
    match = text.match(/^M(\d{1,4})$/) || text.match(/^(\d{1,4})(?:M|MIN)$/);
    if (match && Number(match[1]) > 0) return `M${Number(match[1])}`;
    match = text.match(/^H(\d{1,3})$/) || text.match(/^(\d{1,3})H$/);
    return match && Number(match[1]) > 0 ? `H${Number(match[1])}` : null;
  };

  function aliasAsset(value = '') {
    const raw = upper(value);
    if (!raw || raw.length > 120 || SENSITIVE.test(raw)) return '';
    const otc = /(?:\(|\b|[_-])OTC(?:\)|\b)?/.test(raw);
    const stripped = raw.replace(/\(\s*OTC\s*\)|\bOTC\b/g, ' ').replace(/\s+/g, ' ').trim();
    for (const [label, pair] of ALIASES) {
      const pattern = new RegExp(`(^|[^A-Z0-9])${label.replace(/ /g, '\\s+')}([^A-Z0-9]|$)`);
      if (pattern.test(stripped)) return `${pair}${otc ? ' (OTC)' : ''}`;
    }
    return '';
  }

  const idMap = new Map();
  const candidates = new Map();
  const candles = new Map();
  let publishTimer = 0;
  let lastPublish = 0;

  function rememberId(object, asset) {
    if (!asset) return;
    const id = num(pick(object, ID_KEYS));
    if (Number.isInteger(id) && id > 0 && id < 1e9) idMap.set(id, asset);
    while (idMap.size > 200) idMap.delete(idMap.keys().next().value);
  }

  function assetForObject(object, inherited = '') {
    const raw = pick(object, ASSET_KEYS);
    const direct = aliasAsset(raw);
    if (direct) return direct;
    for (const key of ID_KEYS) {
      const id = num(object?.[key]);
      if (Number.isInteger(id) && idMap.has(id)) return idMap.get(id);
    }
    return inherited || '';
  }

  function recordCandidate(object, asset, transport) {
    if (!asset) return;
    const bid = num(pick(object, BID_KEYS));
    const ask = num(pick(object, ASK_KEYS));
    let price = num(pick(object, PRICE_KEYS));
    if (price == null && bid != null && ask != null) price = (bid + ask) / 2;
    if (price == null || price <= 0 || price > 1e12) return;
    const timestamp = normalizeTime(pick(object, TIME_KEYS)) || Date.now();
    const timeframe = normalizeTf(pick(object, TF_KEYS));
    const selectedRaw = pick(object, SELECTED_KEYS);
    const selected = selectedRaw == null ? false : truthy(selectedRaw);
    const current = candidates.get(asset);
    const row = { asset, price, bid, ask, timestamp, timeframe, selected, confidence: selected ? 96 : 82, transport: `standalone-${transport}`, observedAt: Date.now() };
    if (!current || selected || row.observedAt >= Number(current.observedAt || 0)) candidates.set(asset, row);
  }

  function recordCandle(object, asset) {
    if (!asset) return;
    const open = num(object.open ?? object.o);
    const high = num(object.high ?? object.h);
    const low = num(object.low ?? object.l);
    const close = num(object.close ?? object.c);
    const time = normalizeTime(pick(object, TIME_KEYS));
    if (!time || ![open, high, low, close].every(Number.isFinite)) return;
    const timeframe = normalizeTf(pick(object, TF_KEYS));
    const rows = candles.get(asset) || [];
    const key = `${time}|${timeframe || ''}`;
    const item = { time, open, high, low, close, timeframe };
    const existing = rows.findIndex(row => `${row.time}|${row.timeframe || ''}` === key);
    if (existing >= 0) rows[existing] = item; else rows.push(item);
    rows.sort((a, b) => a.time - b.time);
    candles.set(asset, rows.slice(-180));
  }

  function walk(value, inherited = '', transport = 'data', depth = 0, seen = new WeakSet()) {
    if (depth > 7 || value == null) return;
    if (typeof value === 'string') {
      if (value.length > 1_000_000) return;
      const text = value.trim();
      if (!text || !/[\[{]/.test(text)) return;
      const attempts = [text, text.replace(/^\d{1,2}(?=[\[{])/, ''), /^(?:42|45)\[/.test(text) ? text.slice(2) : ''].filter(Boolean);
      for (const attempt of attempts) {
        try { walk(JSON.parse(attempt), inherited, transport, depth + 1, seen); return; } catch {}
      }
      return;
    }
    if (typeof value !== 'object') return;
    if (seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 250)) walk(item, inherited, transport, depth + 1, seen);
      return;
    }

    const asset = assetForObject(value, inherited);
    if (asset) {
      rememberId(value, asset);
      recordCandidate(value, asset, transport);
      recordCandle(value, asset);
    }
    for (const [key, child] of Object.entries(value).slice(0, 160)) {
      if (SENSITIVE.test(key)) continue;
      if (child && typeof child === 'object') walk(child, asset || inherited, transport, depth + 1, seen);
      else if (typeof child === 'string' && child.length <= 10000 && /^[\s\d]*[\[{]/.test(child)) walk(child, asset || inherited, transport, depth + 1, seen);
    }
  }

  function payload() {
    const now = Date.now();
    const rows = [...candidates.values()].filter(row => now - Number(row.observedAt || 0) < 8000);
    const recentCandles = {};
    for (const [asset, values] of candles) if (values.length) recentCandles[asset] = values.slice(-180);
    return { candidates: rows, recentCandles, feedQuality: rows.length ? 92 : 0, primaryTransport: 'standalone-alias', observedAt: now };
  }

  function publishSoon() {
    if (publishTimer) return;
    publishTimer = setTimeout(() => {
      publishTimer = 0;
      const now = Date.now();
      if (now - lastPublish < 120) return;
      const next = payload();
      if (!next.candidates.length && !Object.keys(next.recentCandles).length) return;
      lastPublish = now;
      window.postMessage({ source: SOURCE, type: 'summary', payload: next }, '*');
    }, 30);
  }

  function inspect(value, transport) {
    try { walk(value, '', transport); publishSoon(); } catch {}
  }

  function hookWebSocket() {
    const Native = window.WebSocket;
    if (typeof Native !== 'function' || Native.__atsStandaloneWrapped) return;
    function Wrapped(...args) {
      const socket = Reflect.construct(Native, args, new.target || Wrapped);
      try { socket.addEventListener('message', event => inspect(event.data, 'ws')); } catch {}
      return socket;
    }
    try { Object.setPrototypeOf(Wrapped, Native); Wrapped.prototype = Native.prototype; Object.defineProperty(Wrapped, '__atsStandaloneWrapped', { value: true }); window.WebSocket = Wrapped; } catch {}
  }

  function hookWorker(name) {
    const Native = window[name];
    if (typeof Native !== 'function' || Native.__atsStandaloneWrapped) return;
    function Wrapped(...args) {
      const worker = Reflect.construct(Native, args, new.target || Wrapped);
      try {
        if (name === 'SharedWorker') worker.port?.addEventListener?.('message', event => inspect(event.data, 'sharedworker'));
        else worker.addEventListener?.('message', event => inspect(event.data, 'worker'));
      } catch {}
      return worker;
    }
    try { Object.setPrototypeOf(Wrapped, Native); Wrapped.prototype = Native.prototype; Object.defineProperty(Wrapped, '__atsStandaloneWrapped', { value: true }); window[name] = Wrapped; } catch {}
  }

  function hookFetch() {
    const nativeFetch = window.fetch;
    if (typeof nativeFetch !== 'function' || nativeFetch.__atsStandaloneWrapped) return;
    async function wrapped(...args) {
      const response = await nativeFetch.apply(this, args);
      try {
        const clone = response.clone();
        const length = Number(clone.headers?.get?.('content-length') || 0);
        if (!length || length <= 1_000_000) clone.text().then(text => inspect(text, 'fetch')).catch(() => {});
      } catch {}
      return response;
    }
    try { Object.defineProperty(wrapped, '__atsStandaloneWrapped', { value: true }); window.fetch = wrapped; } catch {}
  }

  function hookXhr() {
    const proto = window.XMLHttpRequest?.prototype;
    if (!proto || proto.__atsStandaloneWrapped) return;
    const nativeSend = proto.send;
    try {
      Object.defineProperty(proto, '__atsStandaloneWrapped', { value: true });
      proto.send = function(...args) {
        try { this.addEventListener('load', () => { if (typeof this.responseText === 'string' && this.responseText.length <= 1_000_000) inspect(this.responseText, 'xhr'); }); } catch {}
        return nativeSend.apply(this, args);
      };
    } catch {}
  }

  window.addEventListener('message', event => {
    if (event.source !== window || !event.data || event.data.source === SOURCE) return;
    inspect(event.data, 'window');
  });

  hookWebSocket();
  hookWorker('Worker');
  hookWorker('SharedWorker');
  hookFetch();
  hookXhr();
})();
