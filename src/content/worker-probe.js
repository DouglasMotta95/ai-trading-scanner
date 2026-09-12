(() => {
  if (window.__ATS_RUNTIME_FEED_PROBE__) return;
  window.__ATS_RUNTIME_FEED_PROBE__ = true;

  const SOURCE = 'ATS_NETWORK_PROBE';
  const QUOTES = ['USDT','USDC','USD','EUR','GBP','JPY','AUD','CAD','CHF','NZD','BRL','BTC','ETH'];
  const SENSITIVE = /token|auth|cookie|session|password|secret|bearer|csrf|api[-_]?key|credential|authorization/i;
  const ASSET_KEYS = ['symbol','symbolName','symbol_name','asset','assetName','asset_name','instrument','instrumentName','instrument_name','ticker','pair','marketSymbol','underlying'];
  const PRICE_KEYS = ['lastPrice','last_price','price','last','close','mid','midPrice','markPrice','quote'];
  const BID_KEYS = ['bid','bidPrice','bid_price','bestBid','best_bid'];
  const ASK_KEYS = ['ask','askPrice','ask_price','bestAsk','best_ask'];
  const TF_KEYS = ['timeframe','interval','period','resolution','tf'];
  const TIME_KEYS = ['timestamp','time','ts','serverTime','server_time','eventTime','event_time'];
  const EXP_KEYS = ['expiration','expiry','duration','expiresIn','expires_in'];
  const SELECT_KEYS = ['selected','active','isActive','is_active','current','isCurrent','is_current'];

  const state = {
    candidates: new Map(),
    candles: new Map(),
    messages: { worker: 0, sharedworker: 0, broadcast: 0, serviceworker: 0, window: 0 },
    timer: null
  };

  const clean = v => String(v ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  const num = v => {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    const s0 = clean(v);
    if (!s0 || s0.length > 48) return null;
    let s = s0.replace(/\s/g, '').replace(/[^\d,.-]/g, '');
    if (!s) return null;
    if (s.includes(',') && s.includes('.')) s = s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
    else s = s.replace(',', '.');
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  };
  const bool = v => v === true || v === 1 || String(v).toLowerCase() === 'true';
  const pick = (o, keys) => {
    if (!o || typeof o !== 'object') return null;
    for (const k of keys) if (Object.prototype.hasOwnProperty.call(o, k) && o[k] != null) return o[k];
    let own = [];
    try { own = Object.keys(o).slice(0, 120); } catch {}
    const lower = new Map(own.map(k => [k.toLowerCase(), k]));
    for (const k of keys) {
      const real = lower.get(k.toLowerCase());
      if (real && o[real] != null) return o[real];
    }
    return null;
  };

  function canonicalAsset(value = '') {
    let raw = clean(value).toUpperCase();
    if (!raw || raw.length > 80 || SENSITIVE.test(raw)) return '';
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
    const direct = text.match(/\b[A-Z0-9]{2,16}\s*[\/_-]\s*(?:USDT|USDC|USD|EUR|GBP|JPY|AUD|CAD|CHF|NZD|BRL|BTC|ETH)(?:\s*\(\s*OTC\s*\)|\s+OTC)?/i);
    if (direct) return canonicalAsset(direct[0]);
    const compact = text.match(/\b[A-Z]{6}(?:[_-]?OTC)?\b/i);
    return compact ? canonicalAsset(compact[0]) : '';
  }

  function normalizeTf(value) {
    const s = clean(value).toUpperCase().replace(/\s+/g, '');
    let m = s.match(/^M(1|2|5|15|30)$/); if (m) return `M${m[1]}`;
    m = s.match(/^(1|2|5|15|30)(?:M|MIN)$/); if (m) return `M${m[1]}`;
    m = s.match(/^S(5|15|30)$/); if (m) return `S${m[1]}`;
    if (/^(H1|1H|60M|60MIN)$/.test(s)) return 'H1';
    return null;
  }

  function normalizeExp(value) {
    const s = clean(value).toLowerCase().replace(/\s+/g, '');
    let m = s.match(/^(\d{1,4})(?:s|seg|segundo|segundos)$/); if (m) return `${Number(m[1])}s`;
    m = s.match(/^(\d{1,3})(?:m|min|minuto|minutos)$/); if (m) return Number(m[1]) === 1 ? '60s' : `${Number(m[1])}m`;
    return null;
  }

  function normalizeTime(value) {
    let t = num(value);
    if (t == null) return null;
    if (t > 0 && t < 1e11) t *= 1000;
    return Number.isFinite(t) && t > 946684800000 ? t : null;
  }

  function rememberCandidate(candidate, transport) {
    if (!candidate?.asset || candidate.price == null) return;
    const asset = canonicalAsset(candidate.asset);
    if (!asset) return;
    const previous = state.candidates.get(asset) || {};
    state.candidates.set(asset, {
      ...previous,
      ...candidate,
      asset,
      transport,
      observedAt: Date.now(),
      seenCount: Math.min(1000000, Number(previous.seenCount || 0) + 1),
      confidence: Math.max(Number(previous.confidence || 0), Number(candidate.confidence || 0), 70)
    });
  }

  function rememberCandle(candle) {
    if (!candle?.asset) return;
    const asset = canonicalAsset(candle.asset);
    const open = num(candle.open), high = num(candle.high), low = num(candle.low), close = num(candle.close);
    const time = normalizeTime(candle.time ?? candle.timestamp);
    if (!asset || !time || [open, high, low, close].some(v => v == null)) return;
    const timeframe = normalizeTf(candle.timeframe) || null;
    const rows = state.candles.get(asset) || [];
    const key = `${time}|${timeframe || ''}`;
    const row = { time, open, high, low, close, timeframe };
    const idx = rows.findIndex(x => `${x.time}|${x.timeframe || ''}` === key);
    if (idx >= 0) rows[idx] = row; else rows.push(row);
    rows.sort((a, b) => a.time - b.time);
    state.candles.set(asset, rows.slice(-180));
  }

  function candidateFromObject(o, inheritedAsset = '', inheritedTf = '') {
    if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
    const rawAsset = pick(o, ASSET_KEYS);
    const asset = canonicalAsset(rawAsset) || canonicalAsset(inheritedAsset) || assetFromText(rawAsset);
    if (!asset) return null;

    const bid = num(pick(o, BID_KEYS));
    const ask = num(pick(o, ASK_KEYS));
    let price = num(pick(o, PRICE_KEYS));
    const close = num(pick(o, ['close','c']));
    if (price == null && close != null) price = close;
    if (price == null && bid != null && ask != null) price = (bid + ask) / 2;
    if (price == null || price <= 0) return null;

    const timeframe = normalizeTf(pick(o, TF_KEYS)) || normalizeTf(inheritedTf);
    const expiration = normalizeExp(pick(o, EXP_KEYS));
    const timestamp = normalizeTime(pick(o, TIME_KEYS));
    const selected = SELECT_KEYS.some(k => Object.prototype.hasOwnProperty.call(o, k) && bool(o[k]));
    let confidence = 70;
    if (bid != null || ask != null) confidence += 12;
    if (timeframe) confidence += 6;
    if (timestamp) confidence += 6;
    if (selected) confidence += 10;
    return { asset, price, bid, ask, timeframe, expiration, timestamp, selected, confidence: Math.min(100, confidence) };
  }

  function scan(root, transport) {
    if (root == null) return;
    if (typeof root === 'string') {
      const text = root.trim();
      if (!text || text.length > 1048576) return;
      try { root = JSON.parse(text); } catch { return; }
    }
    if (root instanceof ArrayBuffer || ArrayBuffer.isView(root) || root instanceof Blob) return;

    const stack = [{ value: root, depth: 0, asset: '', tf: '', key: '' }];
    const seen = new WeakSet();
    let visited = 0;

    while (stack.length && visited < 3500) {
      const node = stack.pop();
      const value = node.value;
      if (value == null || node.depth > 9) continue;
      if (Array.isArray(value)) {
        for (let i = Math.min(value.length, 500) - 1; i >= 0; i--) {
          stack.push({ value: value[i], depth: node.depth + 1, asset: node.asset, tf: node.tf, key: node.key });
        }
        continue;
      }
      if (typeof value !== 'object') continue;
      if (seen.has(value)) continue;
      seen.add(value);
      visited++;

      const ownAsset = canonicalAsset(pick(value, ASSET_KEYS)) || node.asset || assetFromText(node.key);
      const ownTf = normalizeTf(pick(value, TF_KEYS)) || node.tf;
      const candidate = candidateFromObject(value, ownAsset, ownTf);
      if (candidate) rememberCandidate(candidate, transport);

      const open = num(pick(value, ['open','o']));
      const high = num(pick(value, ['high','h']));
      const low = num(pick(value, ['low','l']));
      const close = num(pick(value, ['close','c']));
      if (ownAsset && [open, high, low, close].every(v => v != null)) {
        rememberCandle({ asset: ownAsset, open, high, low, close, time: pick(value, TIME_KEYS), timeframe: ownTf });
      }

      let entries = [];
      try { entries = Object.entries(value).slice(0, 120); } catch {}
      for (const [key, child] of entries) {
        if (SENSITIVE.test(key)) continue;
        let childAsset = ownAsset;
        if (!childAsset) childAsset = canonicalAsset(key) || assetFromText(key) || '';
        if (child && typeof child === 'object') stack.push({ value: child, depth: node.depth + 1, asset: childAsset, tf: ownTf, key });
      }
    }
    scheduleFlush();
  }

  function flush() {
    state.timer = null;
    const now = Date.now();
    for (const [asset, c] of state.candidates) if (now - Number(c.observedAt || 0) > 15000) state.candidates.delete(asset);
    const candidates = [...state.candidates.values()]
      .sort((a, b) => Number(b.selected) - Number(a.selected) || Number(b.confidence || 0) - Number(a.confidence || 0) || Number(b.observedAt || 0) - Number(a.observedAt || 0))
      .slice(0, 100);
    if (!candidates.length) return;

    const recentCandles = {};
    for (const [asset, rows] of state.candles) if (rows.length) recentCandles[asset] = rows.slice(-120);

    window.postMessage({
      source: SOURCE,
      type: 'summary',
      payload: {
        messages: { ...state.messages }, connections: { ws: 0 }, endpoints: [], keys: [],
        candidates, candidateCount: candidates.length, recentCandles,
        feedQuality: Math.min(100, 65 + Math.min(25, candidates.length * 5) + (Object.keys(recentCandles).length ? 10 : 0)),
        parser: { runtimeFeed: true }, primaryTransport: 'runtime',
        privacy: 'Somente mensagens de mercado trocadas pela página são observadas. Campos de autenticação são ignorados.'
      }
    }, '*');
  }

  function scheduleFlush() {
    if (state.timer) return;
    state.timer = setTimeout(flush, 120);
  }

  function observePort(port, transport) {
    if (!port || port.__atsRuntimeObserved) return;
    try { Object.defineProperty(port, '__atsRuntimeObserved', { value: true }); } catch {}
    try { port.addEventListener('message', event => { state.messages[transport]++; scan(event.data, transport); }); } catch {}
    try { port.start?.(); } catch {}
  }

  if (window.Worker) {
    const NativeWorker = window.Worker;
    const WrappedWorker = function(...args) {
      const worker = new NativeWorker(...args);
      try { worker.addEventListener('message', event => { state.messages.worker++; scan(event.data, 'worker'); }); } catch {}
      return worker;
    };
    WrappedWorker.prototype = NativeWorker.prototype;
    Object.setPrototypeOf(WrappedWorker, NativeWorker);
    window.Worker = WrappedWorker;
  }

  if (window.SharedWorker) {
    const NativeSharedWorker = window.SharedWorker;
    const WrappedSharedWorker = function(...args) {
      const worker = new NativeSharedWorker(...args);
      observePort(worker.port, 'sharedworker');
      return worker;
    };
    WrappedSharedWorker.prototype = NativeSharedWorker.prototype;
    Object.setPrototypeOf(WrappedSharedWorker, NativeSharedWorker);
    window.SharedWorker = WrappedSharedWorker;
  }

  if (window.BroadcastChannel) {
    const NativeBroadcast = window.BroadcastChannel;
    const WrappedBroadcast = function(...args) {
      const channel = new NativeBroadcast(...args);
      try { channel.addEventListener('message', event => { state.messages.broadcast++; scan(event.data, 'broadcast'); }); } catch {}
      return channel;
    };
    WrappedBroadcast.prototype = NativeBroadcast.prototype;
    Object.setPrototypeOf(WrappedBroadcast, NativeBroadcast);
    window.BroadcastChannel = WrappedBroadcast;
  }

  try {
    navigator.serviceWorker?.addEventListener('message', event => {
      state.messages.serviceworker++;
      scan(event.data, 'serviceworker');
    });
  } catch {}

  window.addEventListener('message', event => {
    const data = event.data;
    if (!data || data?.source === SOURCE || String(data?.source || '').startsWith('ATS_')) return;
    state.messages.window++;
    scan(data, 'window');
  }, true);
})();