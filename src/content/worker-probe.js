(() => {
  if (window.__ATS_QUADCODE_FEED_PROBE_V2__) return;
  window.__ATS_QUADCODE_FEED_PROBE_V2__ = true;

  const SOURCE = 'ATS_NETWORK_PROBE';
  const QUOTES = ['USDT','USDC','USD','EUR','GBP','JPY','AUD','CAD','CHF','NZD','BRL','BTC','ETH'];
  const SENSITIVE = /ssid|token|auth|cookie|session|password|secret|bearer|csrf|api[-_]?key|credential|authorization/i;
  const ASSET_KEYS = ['symbol','symbolName','symbol_name','asset','assetName','asset_name','instrument','instrumentName','instrument_name','ticker','pair','marketSymbol','underlying'];
  const ACTIVE_ID_KEYS = ['active_id','activeId','asset_id','assetId'];
  const PRICE_KEYS = ['lastPrice','last_price','price','last','close','mid','midPrice','markPrice','quote'];
  const BID_KEYS = ['bid','bidPrice','bid_price','bestBid','best_bid'];
  const ASK_KEYS = ['ask','askPrice','ask_price','bestAsk','best_ask'];
  const TF_KEYS = ['timeframe','interval','period','resolution','tf','size','duration'];
  const TIME_KEYS = ['from','timestamp','time','ts','to','serverTime','server_time','eventTime','event_time'];

  const KNOWN_ACTIVE_IDS = new Map([
    [1,'EUR/USD'], [2,'EUR/GBP'], [3,'GBP/JPY'], [4,'EUR/JPY'], [5,'GBP/USD'], [6,'USD/JPY'],
    [7,'AUD/CAD'], [8,'NZD/USD'], [72,'USD/CHF'], [74,'XAU/USD'], [75,'XAG/USD'],
    [76,'EUR/USD (OTC)'], [77,'EUR/GBP (OTC)'], [78,'USD/CHF (OTC)'], [79,'EUR/JPY (OTC)'],
    [80,'NZD/USD (OTC)'], [81,'GBP/USD (OTC)'], [84,'GBP/JPY (OTC)'], [85,'USD/JPY (OTC)'],
    [86,'AUD/CAD (OTC)'], [99,'AUD/USD'], [100,'USD/CAD'], [101,'AUD/JPY'], [102,'GBP/CAD'],
    [103,'GBP/CHF'], [104,'GBP/AUD'], [105,'EUR/CAD'], [106,'CHF/JPY'], [107,'CAD/CHF'], [108,'EUR/AUD'],
    [816,'BTC/USD'], [817,'XRP/USD'], [818,'ETH/USD']
  ]);

  const state = {
    candidates: new Map(),
    candles: new Map(),
    assetIds: new Map(KNOWN_ACTIVE_IDS),
    requests: new Map(),
    selectedActiveId: null,
    selectedAt: 0,
    messages: { ws: 0, worker: 0, sharedworker: 0, broadcast: 0, serviceworker: 0, window: 0 },
    timer: null
  };

  const clean = v => String(v ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  const num = v => {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    const s0 = clean(v);
    if (!s0 || s0.length > 64) return null;
    let s = s0.replace(/\s/g, '').replace(/[^\d,.-]/g, '');
    if (!s) return null;
    if (s.includes(',') && s.includes('.')) s = s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
    else s = s.replace(',', '.');
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  };
  const pick = (o, keys) => {
    if (!o || typeof o !== 'object') return null;
    for (const k of keys) if (Object.prototype.hasOwnProperty.call(o, k) && o[k] != null) return o[k];
    let own = [];
    try { own = Object.keys(o).slice(0, 140); } catch {}
    const lower = new Map(own.map(k => [k.toLowerCase(), k]));
    for (const k of keys) {
      const real = lower.get(k.toLowerCase());
      if (real && o[real] != null) return o[real];
    }
    return null;
  };

  function canonicalAsset(value = '') {
    let raw = clean(value).toUpperCase();
    if (!raw || raw.length > 90 || SENSITIVE.test(raw)) return '';
    const otc = /(?:\(|\b|[_-])OTC(?:\)|\b)?/.test(raw);
    raw = raw.replace(/^FRX[:_-]?/, '').replace(/^OTC[:_-]?/, '');
    let s = raw.replace(/\(\s*OTC\s*\)|\bOTC\b/g, '')
      .replace(/\s+/g, '').replace(/_/g, '/').replace(/-/g, '/').replace(/:+/g, '/')
      .replace(/^\/+|\/+$/g, '').replace(/\/{2,}/g, '/');
    if (!s.includes('/')) {
      const quote = QUOTES.find(q => s.length > q.length && s.endsWith(q));
      if (quote) s = `${s.slice(0, -quote.length)}/${quote}`;
      else if (/^[A-Z]{6}$/.test(s)) s = `${s.slice(0, 3)}/${s.slice(3)}`;
    }
    const m = s.match(/^([A-Z0-9]{2,16})\/([A-Z0-9]{2,12})$/);
    if (!m || !QUOTES.includes(m[2])) return '';
    return `${m[1]}/${m[2]}${otc ? ' (OTC)' : ''}`;
  }

  function assetFromText(value = '') {
    const text = clean(value).toUpperCase();
    const direct = text.match(/\b[A-Z0-9]{2,16}\s*[\/_-]\s*(?:USDT|USDC|USD|EUR|GBP|JPY|AUD|CAD|CHF|NZD|BRL|BTC|ETH)(?:\s*\(\s*OTC\s*\)|[_-]?OTC)?/i);
    if (direct) return canonicalAsset(direct[0]);
    const compact = text.match(/\b[A-Z]{6}(?:[_-]?OTC)?\b/i);
    return compact ? canonicalAsset(compact[0]) : '';
  }

  function normalizeTf(value) {
    if (typeof value === 'number' || /^\d+$/.test(clean(value))) {
      const n = Number(value);
      if (n === 1) return 'S1';
      if ([5, 10, 15, 30].includes(n)) return `S${n}`;
      if (n === 60) return 'M1';
      if (n === 120) return 'M2';
      if (n === 300) return 'M5';
      if (n === 900) return 'M15';
      if (n === 1800) return 'M30';
      if (n === 3600) return 'H1';
    }
    const s = clean(value).toUpperCase().replace(/\s+/g, '');
    let m = s.match(/^M(1|2|5|15|30)$/); if (m) return `M${m[1]}`;
    m = s.match(/^(1|2|5|15|30)(?:M|MIN)$/); if (m) return `M${m[1]}`;
    m = s.match(/^S(1|5|10|15|30)$/); if (m) return `S${m[1]}`;
    return /^(H1|1H|60M|60MIN)$/.test(s) ? 'H1' : null;
  }

  function normalizeTime(value) {
    let t = num(value);
    if (t == null || t <= 0) return null;
    while (t > 1e14) t /= 1000;
    if (t < 1e11) t *= 1000;
    return Number.isFinite(t) && t > 946684800000 ? Math.round(t) : null;
  }

  function resolveActiveId(value) {
    const n = Number(value);
    if (!Number.isInteger(n) || n <= 0) return '';
    return canonicalAsset(state.assetIds.get(n) || '');
  }

  function rememberMapping(o) {
    if (!o || typeof o !== 'object' || Array.isArray(o)) return '';
    const raw = pick(o, ASSET_KEYS);
    const asset = canonicalAsset(raw) || assetFromText(raw);
    if (!asset) return '';
    let id = num(pick(o, ACTIVE_ID_KEYS));
    if (id == null && !('open' in o) && !('close' in o)) id = num(o.id);
    if (Number.isInteger(id) && id > 0) state.assetIds.set(id, asset);
    return asset;
  }

  function requestContext(root) {
    if (!root || typeof root !== 'object') return null;
    let raw = '';
    try { raw = JSON.stringify(root).slice(0, 120000); } catch { return null; }
    if (SENSITIVE.test(raw) || !/(candle-generated|get-candles|candles|realTimeChartData|chart)/i.test(raw)) return null;
    const requestId = root.request_id ?? root.requestId ?? root.id ?? null;
    let activeId = null;
    let size = null;
    const stack = [{ v: root, d: 0 }];
    const seen = new WeakSet();
    while (stack.length) {
      const { v, d } = stack.pop();
      if (!v || typeof v !== 'object' || d > 8 || seen.has(v)) continue;
      seen.add(v);
      if (activeId == null) activeId = num(pick(v, ACTIVE_ID_KEYS));
      if (size == null) size = num(pick(v, ['size','duration','interval']));
      let entries = [];
      try { entries = Object.entries(v).slice(0, 100); } catch {}
      for (const [k, child] of entries) {
        if (SENSITIVE.test(k)) continue;
        if (child && typeof child === 'object') stack.push({ v: child, d: d + 1 });
      }
    }
    if (!Number.isInteger(activeId) || activeId <= 0) return null;
    const ctx = { activeId, asset: resolveActiveId(activeId), timeframe: normalizeTf(size), at: Date.now() };
    state.selectedActiveId = activeId;
    state.selectedAt = Date.now();
    if (requestId != null) state.requests.set(String(requestId), ctx);
    while (state.requests.size > 100) state.requests.delete(state.requests.keys().next().value);
    return ctx;
  }

  function rememberCandidate(candidate, transport) {
    if (!candidate?.asset || candidate.price == null) return;
    const asset = canonicalAsset(candidate.asset);
    const price = num(candidate.price);
    if (!asset || price == null || price <= 0) return;
    const previous = state.candidates.get(asset) || {};
    const selected = candidate.selected === true;
    state.candidates.set(asset, {
      ...previous, ...candidate, asset, price, transport, selected,
      observedAt: Date.now(),
      seenCount: Math.min(1000000, Number(previous.seenCount || 0) + 1),
      confidence: Math.max(Number(previous.confidence || 0), Number(candidate.confidence || 0), selected ? 99 : 82)
    });
  }

  function rememberCandle(candle) {
    const asset = canonicalAsset(candle?.asset);
    const open = num(candle?.open), high = num(candle?.high), low = num(candle?.low), close = num(candle?.close);
    const time = normalizeTime(candle?.time ?? candle?.timestamp ?? candle?.from);
    if (!asset || !time || [open, high, low, close].every(Number.isFinite) === false) return;
    if (high < Math.max(open, close) || low > Math.min(open, close)) return;
    const timeframe = normalizeTf(candle?.timeframe ?? candle?.size) || null;
    const rows = state.candles.get(asset) || [];
    const key = `${time}|${timeframe || ''}`;
    const row = { time, open, high, low, close, timeframe };
    const index = rows.findIndex(x => `${x.time}|${x.timeframe || ''}` === key);
    if (index >= 0) rows[index] = row; else rows.push(row);
    rows.sort((a, b) => a.time - b.time);
    state.candles.set(asset, rows.slice(-180));
  }

  function arrayCandle(arr, asset, timeframe) {
    if (!Array.isArray(arr) || arr.length < 5 || arr.length > 16 || !asset) return null;
    const time = normalizeTime(arr[0]);
    const open = num(arr[1]);
    if (!time || open == null) return null;
    const iq = { close: num(arr[2]), high: num(arr[3]), low: num(arr[4]) };
    if ([iq.close, iq.high, iq.low].every(Number.isFinite)
      && iq.high >= Math.max(open, iq.close) && iq.low <= Math.min(open, iq.close)) {
      return { asset, time, open, high: iq.high, low: iq.low, close: iq.close, timeframe };
    }
    const normal = { high: num(arr[2]), low: num(arr[3]), close: num(arr[4]) };
    if ([normal.close, normal.high, normal.low].every(Number.isFinite)
      && normal.high >= Math.max(open, normal.close) && normal.low <= Math.min(open, normal.close)) {
      return { asset, time, open, high: normal.high, low: normal.low, close: normal.close, timeframe };
    }
    return null;
  }

  function scanObject(root, transport, inherited = {}) {
    if (!root || typeof root !== 'object') return;
    const responseId = root.request_id ?? root.requestId ?? null;
    const request = responseId != null ? state.requests.get(String(responseId)) : null;
    const seedAsset = canonicalAsset(inherited.asset || request?.asset || '');
    const seedTf = normalizeTf(inherited.timeframe || request?.timeframe);
    const stack = [{ value: root, depth: 0, asset: seedAsset, timeframe: seedTf, key: '' }];
    const seen = new WeakSet();
    let visited = 0;

    while (stack.length && visited < 5000) {
      const node = stack.pop();
      const value = node.value;
      if (value == null || node.depth > 11) continue;
      if (Array.isArray(value)) {
        const candle = /candle|candles|ohlc|bar|history/i.test(node.key)
          ? arrayCandle(value, node.asset, node.timeframe) : null;
        if (candle) rememberCandle(candle);
        for (let i = Math.min(value.length, 700) - 1; i >= 0; i--) {
          stack.push({ value: value[i], depth: node.depth + 1, asset: node.asset, timeframe: node.timeframe, key: node.key });
        }
        continue;
      }
      if (typeof value !== 'object' || seen.has(value)) continue;
      seen.add(value);
      visited++;

      const learnedAsset = rememberMapping(value);
      const activeId = num(pick(value, ACTIVE_ID_KEYS));
      const idAsset = resolveActiveId(activeId);
      const ownAsset = learnedAsset || idAsset || node.asset || assetFromText(node.key);
      const ownTf = normalizeTf(pick(value, TF_KEYS)) || node.timeframe;
      const selected = Number.isInteger(activeId)
        && activeId === state.selectedActiveId
        && Date.now() - state.selectedAt < 120000;

      const bid = num(pick(value, BID_KEYS));
      const ask = num(pick(value, ASK_KEYS));
      const close = num(pick(value, ['close','c']));
      let price = num(pick(value, PRICE_KEYS));
      if (price == null && close != null) price = close;
      if (price == null && bid != null && ask != null) price = (bid + ask) / 2;
      if (ownAsset && price != null && price > 0) {
        rememberCandidate({
          asset: ownAsset, price, bid, ask, timeframe: ownTf,
          timestamp: normalizeTime(pick(value, TIME_KEYS)), selected,
          activeId: Number.isInteger(activeId) ? activeId : null,
          confidence: selected ? 99 : (activeId != null ? 92 : 82)
        }, transport);
      }

      const open = num(pick(value, ['open','o']));
      const high = num(pick(value, ['high','h','max']));
      const low = num(pick(value, ['low','l','min']));
      if (ownAsset && [open, high, low, close].every(Number.isFinite)) {
        rememberCandle({ asset: ownAsset, open, high, low, close, time: pick(value, TIME_KEYS), timeframe: ownTf });
      }

      let entries = [];
      try { entries = Object.entries(value).slice(0, 160); } catch {}
      for (const [key, child] of entries) {
        if (SENSITIVE.test(key)) continue;
        if (child && typeof child === 'object') {
          stack.push({ value: child, depth: node.depth + 1, asset: ownAsset, timeframe: ownTf, key });
        }
      }
    }
    scheduleFlush();
  }

  function parseJsonFrames(raw) {
    const text = String(raw || '').trim();
    if (!text || text.length > 1572864) return [];
    const attempts = [text];
    if (/^\d{1,3}[\[{]/.test(text)) attempts.push(text.replace(/^\d{1,3}/, ''));
    if (/^(?:42|45)\[/.test(text)) attempts.push(text.slice(2));
    if (/^data:/m.test(text)) {
      for (const line of text.split(/\r?\n/).slice(0, 80)) if (/^data:\s*/.test(line)) attempts.push(line.replace(/^data:\s*/, ''));
    }
    const out = [];
    for (const attempt of attempts) {
      try {
        let value = JSON.parse(attempt);
        if (typeof value === 'string' && /^[\[{]/.test(value.trim())) value = JSON.parse(value);
        out.push(value);
      } catch {}
    }
    return out;
  }

  function observeOutgoing(data) {
    if (typeof data !== 'string') return;
    const text = data.slice(0, 250000);
    if (SENSITIVE.test(text)) return;
    for (const root of parseJsonFrames(text)) requestContext(root);
  }

  function ingest(data, transport) {
    if (data == null) return;
    state.messages[transport] = Number(state.messages[transport] || 0) + 1;
    if (typeof data === 'string') {
      for (const root of parseJsonFrames(data)) scanObject(root, transport);
      return;
    }
    if (data instanceof Blob) {
      if (data.size <= 1572864) data.text().then(text => ingest(text, transport)).catch(() => {});
      return;
    }
    if (data instanceof ArrayBuffer) {
      if (data.byteLength <= 1572864) {
        try { ingest(new TextDecoder().decode(new Uint8Array(data)), transport); } catch {}
      }
      return;
    }
    if (ArrayBuffer.isView(data)) {
      if (data.byteLength <= 1572864) {
        try { ingest(new TextDecoder().decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)), transport); } catch {}
      }
      return;
    }
    if (typeof data === 'object') scanObject(data, transport);
  }

  function flush() {
    state.timer = null;
    const now = Date.now();
    for (const [asset, c] of state.candidates) if (now - Number(c.observedAt || 0) > 15000) state.candidates.delete(asset);
    const candidates = [...state.candidates.values()]
      .sort((a, b) => Number(b.selected) - Number(a.selected)
        || Number(b.confidence || 0) - Number(a.confidence || 0)
        || Number(b.seenCount || 0) - Number(a.seenCount || 0)
        || Number(b.observedAt || 0) - Number(a.observedAt || 0))
      .slice(0, 120);
    if (!candidates.length) return;
    const recentCandles = {};
    for (const [asset, rows] of state.candles) if (rows.length) recentCandles[asset] = rows.slice(-120);
    window.postMessage({
      source: SOURCE,
      type: 'summary',
      payload: {
        messages: { ...state.messages }, connections: { ws: state.messages.ws > 0 ? 1 : 0 }, endpoints: [],
        keys: ['active_id','size','from','open','close','min','max','bid','ask'],
        candidates, candidateCount: candidates.length, recentCandles,
        feedQuality: Math.min(100, 70 + (candidates.some(x => x.selected) ? 20 : 0) + (Object.keys(recentCandles).length ? 10 : 0)),
        parser: { quadcodeActiveId: true, selectedActiveId: state.selectedActiveId, mappedIds: state.assetIds.size, candleAssets: Object.keys(recentCandles).length },
        primaryTransport: 'quadcode-runtime',
        privacy: 'Somente ids de ativo, cotação e OHLC do mercado são observados. Autenticação, cookies, tokens e saldo não são coletados.'
      }
    }, '*');
  }

  function scheduleFlush() {
    if (state.timer) return;
    state.timer = setTimeout(flush, 90);
  }

  function wrapPostMessage(target) {
    if (!target || target.__atsOutgoingObserved || typeof target.postMessage !== 'function') return;
    const native = target.postMessage;
    try { Object.defineProperty(target, '__atsOutgoingObserved', { value: true }); } catch {}
    try {
      target.postMessage = function(data, ...rest) {
        try { observeOutgoing(data); } catch {}
        return native.call(this, data, ...rest);
      };
    } catch {}
  }

  if (window.WebSocket) {
    const Native = window.WebSocket;
    const Wrapped = function(url, protocols) {
      const ws = protocols === undefined ? new Native(url) : new Native(url, protocols);
      try {
        const nativeSend = ws.send;
        ws.send = function(data) {
          try { observeOutgoing(data); } catch {}
          return nativeSend.call(this, data);
        };
        ws.addEventListener('message', event => ingest(event.data, 'ws'));
      } catch {}
      return ws;
    };
    Wrapped.prototype = Native.prototype;
    Object.setPrototypeOf(Wrapped, Native);
    for (const k of ['CONNECTING','OPEN','CLOSING','CLOSED']) {
      try { Object.defineProperty(Wrapped, k, { value: Native[k] }); } catch {}
    }
    window.WebSocket = Wrapped;
  }

  if (window.Worker) {
    const Native = window.Worker;
    const Wrapped = function(...args) {
      const worker = new Native(...args);
      try { worker.addEventListener('message', event => ingest(event.data, 'worker')); wrapPostMessage(worker); } catch {}
      return worker;
    };
    Wrapped.prototype = Native.prototype;
    Object.setPrototypeOf(Wrapped, Native);
    window.Worker = Wrapped;
  }

  if (window.SharedWorker) {
    const Native = window.SharedWorker;
    const Wrapped = function(...args) {
      const worker = new Native(...args);
      try { worker.port.addEventListener('message', event => ingest(event.data, 'sharedworker')); worker.port.start?.(); wrapPostMessage(worker.port); } catch {}
      return worker;
    };
    Wrapped.prototype = Native.prototype;
    Object.setPrototypeOf(Wrapped, Native);
    window.SharedWorker = Wrapped;
  }

  if (window.BroadcastChannel) {
    const Native = window.BroadcastChannel;
    const Wrapped = function(...args) {
      const channel = new Native(...args);
      try { channel.addEventListener('message', event => ingest(event.data, 'broadcast')); wrapPostMessage(channel); } catch {}
      return channel;
    };
    Wrapped.prototype = Native.prototype;
    Object.setPrototypeOf(Wrapped, Native);
    window.BroadcastChannel = Wrapped;
  }

  try { navigator.serviceWorker?.addEventListener('message', event => ingest(event.data, 'serviceworker')); } catch {}
  window.addEventListener('message', event => {
    const data = event.data;
    if (!data || data?.source === SOURCE || String(data?.source || '').startsWith('ATS_')) return;
    ingest(data, 'window');
  }, true);
})();