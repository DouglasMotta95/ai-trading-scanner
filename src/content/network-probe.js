(() => {
  if (window.__ATS_NETWORK_PROBE__) return;
  window.__ATS_NETWORK_PROBE__ = true;

  const SENSITIVE = /token|auth|cookie|session|password|secret|bearer|csrf|api[-_]?key|credential|authorization/i;
  const ASSET_KEYS = ['symbol', 'symbolName', 'symbol_name', 'asset', 'assetName', 'asset_name', 'instrument', 'instrumentName', 'instrument_name', 'ticker', 'pair', 'market'];
  const PRICE_KEYS = ['price', 'last', 'lastPrice', 'last_price', 'quote', 'close', 'value', 'rate', 'current'];
  const BID_KEYS = ['bid', 'bidPrice', 'bid_price', 'bestBid', 'best_bid'];
  const ASK_KEYS = ['ask', 'askPrice', 'ask_price', 'bestAsk', 'best_ask'];
  const TIME_KEYS = ['timestamp', 'time', 'ts', 'createdAt', 'created_at', 'serverTime', 'server_time'];
  const TF_KEYS = ['timeframe', 'interval', 'period', 'resolution', 'tf'];
  const EXP_KEYS = ['expiration', 'expiry', 'expiresAt', 'expires_at', 'duration'];
  const CONTROL_EXP_KEY = /^(?:expiration|expiry|expirationTime|expiration_time|expiryTime|expiry_time|optionDuration|option_duration|tradeDuration|trade_duration|operationDuration|operation_duration|dealDuration|deal_duration)$/i;
  const GENERIC_DURATION_KEY = /^duration$/i;
  const PAYOUT_KEYS = ['payout', 'profit', 'return', 'yield', 'percent'];
  const SELECTED_KEYS = ['selected', 'active', 'isActive', 'is_active', 'current', 'isCurrent', 'is_current'];
  const TYPE_KEYS = ['type', 'instrumentType', 'instrument_type', 'mode', 'optionType', 'option_type'];
  const CANDLE_CONTAINER = /candle|candles|kline|klines|ohlc|bars|history|chart/i;
  const QUOTE_CONTAINER = /quote|quotes|tick|ticks|price|prices|market|symbols|assets|instruments/i;
  const COMMON_QUOTES = ['USDT', 'USDC', 'USD', 'EUR', 'GBP', 'JPY', 'AUD', 'CAD', 'CHF', 'NZD', 'BRL', 'BTC', 'ETH'];

  const stats = {
    messages: { ws: 0, fetch: 0, xhr: 0 },
    outbound: { ws: 0, fetch: 0, xhr: 0 },
    connections: { ws: 0 },
    endpoints: new Set(),
    keys: new Set(),
    assets: new Map(),
    candles: new Map(),
    controlExpiration: null,
    expirationTrace: [],
    parse: { frames: 0, decoded: 0, candidates: 0, candles: 0, binary: 0 }
  };

  const now = () => Date.now();
  const trimSet = (set, max) => { while (set.size > max) set.delete(set.values().next().value); };
  const safeUrl = u => {
    try { const x = new URL(String(u || ''), location.href); return x.origin + x.pathname; }
    catch { return ''; }
  };
  const num = v => {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    const s0 = String(v ?? '').trim();
    if (!s0 || s0.length > 48) return null;
    let s = s0.replace(/\s/g, '').replace(/[^\d,.-]/g, '');
    if (!s) return null;
    if (s.includes(',') && s.includes('.')) s = s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
    else s = s.replace(',', '.');
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  };
  const bool = v => v === true || v === 1 || String(v).toLowerCase() === 'true';
  const pick = (o, names) => {
    if (!o || typeof o !== 'object') return null;
    for (const k of names) if (Object.prototype.hasOwnProperty.call(o, k) && o[k] != null) return o[k];
    const lower = new Map(Object.keys(o).map(k => [k.toLowerCase(), k]));
    for (const k of names) { const real = lower.get(k.toLowerCase()); if (real && o[real] != null) return o[real]; }
    return null;
  };
  const pickEntry = (o, names) => {
    if (!o || typeof o !== 'object') return null;
    for (const k of names) if (Object.prototype.hasOwnProperty.call(o, k) && o[k] != null) return { key: k, value: o[k] };
    const lower = new Map(Object.keys(o).map(k => [k.toLowerCase(), k]));
    for (const k of names) {
      const real = lower.get(k.toLowerCase());
      if (real && o[real] != null) return { key: real, value: o[real] };
    }
    return null;
  };
  const normalizeTime = v => {
    let t = num(v);
    if (t == null) return null;
    if (t > 0 && t < 1e11) t *= 1000;
    return Number.isFinite(t) && t > 946684800000 ? t : null;
  };
  const normalizeTf = v => {
    const s = String(v ?? '').trim().toUpperCase().replace(/\s+/g, '');
    if (!s) return null;
    let m = s.match(/^(?:M)?(1|2|5|15|30)(?:M|MIN)?$/); if (m) return `M${m[1]}`;
    m = s.match(/^(?:S)?(5|15|30)(?:S|SEG)?$/); if (m && /S|SEG/.test(s)) return `S${m[1]}`;
    if (/^(?:H1|1H|60M|60MIN)$/.test(s)) return 'H1';
    if (/^(?:H4|4H)$/.test(s)) return 'H4';
    return s.length <= 12 ? s : null;
  };
  const normalizeExp = v => {
    const s = String(v ?? '').trim().toLowerCase().replace(/\s+/g, '');
    if (!s) return null;
    let m = s.match(/^(\d{1,4})(?:s|seg|segundos?)$/); if (m) return `${Number(m[1])}s`;
    m = s.match(/^(\d{1,3})(?:m|min|minutos?)$/); if (m) return Number(m[1]) === 1 ? '60s' : `${Number(m[1])}m`;
    const n = num(v);
    if (n != null && n > 0 && n <= 3600) return n < 60 ? `${n}s` : n === 60 ? '60s' : n % 60 === 0 ? `${n / 60}m` : `${n}s`;
    return null;
  };
  const safeTraceValue = value => {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
      const s = value.trim();
      return s && s.length <= 40 && !SENSITIVE.test(s) ? s : null;
    }
    return null;
  };
  const pushExpirationTrace = (entry = {}) => {
    const row = {
      at: now(),
      direction: entry.direction === 'out' ? 'out' : 'in',
      transport: String(entry.transport || '').slice(0, 16),
      endpoint: String(entry.endpoint || '').slice(0, 240),
      sourceKey: String(entry.sourceKey || '').slice(0, 80),
      parentKey: String(entry.parentKey || '').slice(0, 80),
      shape: String(entry.shape || 'object-key').slice(0, 80),
      expiration: String(entry.expiration || '').slice(0, 24),
      rawValue: safeTraceValue(entry.rawValue)
    };
    const previous = stats.expirationTrace.at(-1);
    const same = previous
      && previous.direction === row.direction
      && previous.transport === row.transport
      && previous.endpoint === row.endpoint
      && previous.sourceKey === row.sourceKey
      && previous.expiration === row.expiration
      && previous.rawValue === row.rawValue;
    if (!same || row.at - Number(previous?.at || 0) > 350) stats.expirationTrace.push(row);
    stats.expirationTrace = stats.expirationTrace.slice(-40);
  };
  const recordControlExpiration = (key, value, meta = {}) => {
    const expiration = normalizeExp(value);
    if (!expiration) return;
    const semanticKey = String(key || '');
    const parentKey = String(meta.parentKey || '');
    const objectKeys = Array.isArray(meta.objectKeys) ? meta.objectKeys.join(' ') : '';
    const genericAllowed = GENERIC_DURATION_KEY.test(semanticKey)
      && /trade|option|operation|deal|expiry|expiration/i.test(`${parentKey} ${objectKeys}`);
    if (!CONTROL_EXP_KEY.test(semanticKey) && !genericAllowed) return;
    const confidence = CONTROL_EXP_KEY.test(semanticKey) && !GENERIC_DURATION_KEY.test(semanticKey) ? 97 : 84;
    const observedAt = now();
    pushExpirationTrace({
      direction: meta.direction,
      transport: meta.transport,
      endpoint: meta.endpoint,
      sourceKey: semanticKey,
      parentKey,
      shape: meta.shape || 'object-key',
      expiration,
      rawValue: value
    });
    // Investigation only: outbound evidence is traced but must not change the
    // authoritative runtime expiration state.
    if (meta.direction === 'out') return;
    const current = stats.controlExpiration;
    if (!current || confidence > Number(current.confidence || 0) || observedAt - Number(current.observedAt || 0) > 2500) {
      stats.controlExpiration = {
        expiration,
        confidence,
        sourceKey: semanticKey,
        transport: meta.transport || null,
        endpoint: meta.endpoint || null,
        observedAt
      };
    }
  };
  const canonicalAsset = v => {
    let raw = String(v ?? '').trim().toUpperCase();
    if (!raw || raw.length > 64 || SENSITIVE.test(raw)) return '';
    raw = raw.replace(/^FRX[:_-]?/, '').replace(/^OTC[:_-]?/, '');
    const otc = /(?:\(|\b|[_-])OTC(?:\)|\b)?/.test(raw);
    let s = raw.replace(/\(OTC\)|\bOTC\b/g, '').replace(/\s+/g, '').replace(/_/g, '/').replace(/-/g, '/').replace(/:+/g, '/');
    s = s.replace(/^\/+|\/+$/g, '').replace(/\/{2,}/g, '/');
    if (!s.includes('/')) {
      const quote = COMMON_QUOTES.find(q => s.length > q.length && s.endsWith(q));
      if (quote) s = `${s.slice(0, -quote.length)}/${quote}`;
      else if (/^[A-Z]{6}$/.test(s)) s = `${s.slice(0, 3)}/${s.slice(3)}`;
    }
    if (!/^[A-Z0-9]{2,16}\/[A-Z0-9]{2,12}$/.test(s)) return '';
    return `${s}${otc ? ' (OTC)' : ''}`;
  };
  const assetFromText = v => {
    const text = String(v ?? '').toUpperCase();
    const direct = text.match(/\b[A-Z0-9]{2,16}\s*[\/_-]\s*[A-Z0-9]{2,12}(?:\s*\(?OTC\)?)?/);
    if (direct) return canonicalAsset(direct[0]);
    const compact = text.match(/\b[A-Z]{6}(?:[_-]?OTC)?\b/);
    return compact ? canonicalAsset(compact[0]) : '';
  };
  const instrumentType = v => {
    const s = String(v ?? '').toLowerCase();
    if (/blitz/.test(s)) return 'blitz';
    if (/bin[aá]ri|binary/.test(s)) return 'binary';
    if (/turbo/.test(s)) return 'turbo';
    if (/cfd/.test(s)) return 'cfd';
    return null;
  };

  const parseJson = s => {
    try {
      let v = JSON.parse(s);
      if (typeof v === 'string' && /^[\[{]/.test(v.trim())) { try { v = JSON.parse(v); } catch {} }
      return v;
    } catch { return null; }
  };
  const decodeStringFrames = raw => {
    const s = String(raw ?? '').trim();
    if (!s) return [];
    const out = [];
    const add = value => { if (value != null) out.push(value); };
    add(parseJson(s));
    if (/^\d{1,2}[\[{]/.test(s)) add(parseJson(s.replace(/^\d{1,2}/, '')));
    if (/^(?:42|45)\[/.test(s)) add(parseJson(s.slice(2)));
    if (/^data:/m.test(s)) {
      for (const line of s.split(/\r?\n/)) if (/^data:\s*/.test(line)) add(parseJson(line.replace(/^data:\s*/, '')));
    }
    if (!out.length && s.includes('\n')) for (const line of s.split(/\r?\n/).slice(0, 50)) add(parseJson(line.trim()));
    return out.filter(Boolean);
  };
  const toText = async data => {
    if (typeof data === 'string') return data;
    if (data instanceof Blob) {
      if (data.size > 1048576) return '';
      stats.parse.binary++;
      return data.text().catch(() => '');
    }
    if (data instanceof ArrayBuffer) {
      if (data.byteLength > 1048576) return '';
      stats.parse.binary++;
      try { return new TextDecoder().decode(new Uint8Array(data)); } catch { return ''; }
    }
    if (ArrayBuffer.isView(data)) {
      if (data.byteLength > 1048576) return '';
      stats.parse.binary++;
      try { return new TextDecoder().decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)); } catch { return ''; }
    }
    return '';
  };

  const recordCandle = c => {
    if (![c?.open, c?.high, c?.low, c?.close].every(Number.isFinite)) return;
    const time = normalizeTime(c.timestamp);
    const asset = canonicalAsset(c.asset);
    if (!time || !asset) return;
    const rows = stats.candles.get(asset) || [];
    const timeframe = normalizeTf(c.timeframe) || null;
    const key = `${time}|${timeframe || ''}`;
    const item = { time, open: c.open, high: c.high, low: c.low, close: c.close, timeframe };
    const i = rows.findIndex(x => `${x.time}|${x.timeframe || ''}` === key);
    if (i >= 0) rows[i] = item; else rows.push(item);
    rows.sort((a, b) => a.time - b.time);
    stats.candles.set(asset, rows.slice(-180));
    stats.parse.candles++;
    while (stats.candles.size > 60) stats.candles.delete(stats.candles.keys().next().value);
  };

  const candidateFromObject = (o, inheritedAsset = '') => {
    if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
    const rawAsset = pick(o, ASSET_KEYS);
    const asset = canonicalAsset(rawAsset) || canonicalAsset(inheritedAsset) || assetFromText(rawAsset);
    if (!asset) return null;
    const bid = num(pick(o, BID_KEYS));
    const ask = num(pick(o, ASK_KEYS));
    let price = num(pick(o, PRICE_KEYS));
    const open = num(pick(o, ['open', 'o']));
    const high = num(pick(o, ['high', 'h']));
    const low = num(pick(o, ['low', 'l']));
    const close = num(pick(o, ['close', 'c']));
    if (price == null && close != null) price = close;
    if (price == null && bid != null && ask != null) price = (bid + ask) / 2;
    if (price == null && bid == null && ask == null && close == null) return null;
    const timestamp = pick(o, TIME_KEYS);
    const timeframe = normalizeTf(pick(o, TF_KEYS));
    const expirationEntry = pickEntry(o, EXP_KEYS);
    const expiration = normalizeExp(expirationEntry?.value);
    if (expirationEntry) {
      recordControlExpiration(expirationEntry.key, expirationEntry.value, {
        parentKey: inheritedAsset,
        objectKeys: Object.keys(o).slice(0, 40)
      });
    }
    const payout = num(pick(o, PAYOUT_KEYS));
    const selected = SELECTED_KEYS.some(k => Object.prototype.hasOwnProperty.call(o, k) && bool(o[k]));
    const typeRaw = pick(o, TYPE_KEYS);
    const iType = instrumentType(typeRaw);
    const marketType = /OTC/i.test(String(rawAsset ?? inheritedAsset)) ? 'otc' : null;
    let confidence = 30;
    if (price != null) confidence += 20;
    if (bid != null || ask != null) confidence += 15;
    if (timeframe) confidence += 8;
    if (expiration) confidence += 5;
    if (timestamp != null) confidence += 7;
    if (selected) confidence += 10;
    if (iType) confidence += 5;
    const c = { asset, observedAt: now(), confidence: Math.min(100, confidence), selected };
    if (price != null) c.price = price;
    if (bid != null) c.bid = bid;
    if (ask != null) c.ask = ask;
    if (open != null) c.open = open;
    if (high != null) c.high = high;
    if (low != null) c.low = low;
    if (close != null) c.close = close;
    if (timestamp != null) c.timestamp = timestamp;
    if (timeframe) c.timeframe = timeframe;
    if (expiration) {
      c.expiration = expiration;
      c.expirationSourceKey = expirationEntry?.key || null;
    }
    if (payout != null) c.payout = payout;
    if (iType) c.instrumentType = iType;
    if (marketType) c.marketType = marketType;
    return c;
  };

  const arrayCandle = (arr, inheritedAsset, inheritedTf) => {
    if (!Array.isArray(arr) || arr.length < 5 || arr.length > 12) return null;
    const t = normalizeTime(arr[0]);
    const o = num(arr[1]), h = num(arr[2]), l = num(arr[3]), c = num(arr[4]);
    const asset = canonicalAsset(inheritedAsset);
    if (!t || !asset || ![o, h, l, c].every(Number.isFinite)) return null;
    return { asset, timestamp: t, open: o, high: h, low: l, close: c, timeframe: normalizeTf(inheritedTf) };
  };

  const scanValue = (root, meta = {}) => {
    if (root == null) return;
    const stack = [{ v: root, d: 0, asset: '', key: '', tf: '' }];
    let seen = 0;
    while (stack.length && seen < 1800) {
      const node = stack.pop(); seen++;
      const { v, d, key } = node;
      if (v == null || d > 9) continue;
      if (Array.isArray(v)) {
        if (CANDLE_CONTAINER.test(key)) {
          const candle = arrayCandle(v, node.asset, node.tf); if (candle) recordCandle(candle);
        }
        if (v.length <= 24) {
          for (let i = 0; i < v.length; i++) {
            const label = typeof v[i] === 'string' ? String(v[i]) : '';
            if (!/(?:expir|expiry|trade.?duration|operation.?duration|deal.?duration|option.?duration)/i.test(label)) continue;
            for (const candidate of [v[i + 1], v[i - 1]]) {
              if (candidate == null || typeof candidate === 'object') continue;
              const expiration = normalizeExp(candidate);
              if (!expiration) continue;
              pushExpirationTrace({
                direction: meta.direction,
                transport: meta.transport,
                endpoint: meta.endpoint,
                sourceKey: label,
                parentKey: key,
                shape: 'array-event',
                expiration,
                rawValue: candidate
              });
            }
          }
        }
        for (let i = Math.min(v.length, 350) - 1; i >= 0; i--) stack.push({ v: v[i], d: d + 1, asset: node.asset, key, tf: node.tf });
        continue;
      }
      if (typeof v !== 'object') continue;
      const ownAsset = canonicalAsset(pick(v, ASSET_KEYS)) || node.asset;
      const ownTf = normalizeTf(pick(v, TF_KEYS)) || node.tf;
      const c = candidateFromObject(v, ownAsset);
      if (c) {
        const previous = stats.assets.get(c.asset);
        stats.assets.set(c.asset, {
          ...previous,
          ...c,
          transport: meta.transport || previous?.transport || null,
          endpoint: meta.endpoint || previous?.endpoint || null,
          firstObservedAt: previous?.firstObservedAt || c.observedAt,
          seenCount: Math.min(1000000, Number(previous?.seenCount || 0) + 1),
          confidence: Math.max(Number(previous?.confidence || 0), Number(c.confidence || 0))
        });
        recordCandle(c);
        stats.parse.candidates++;
      }
      for (const [k, val] of Object.entries(v)) {
        if (SENSITIVE.test(k)) continue;
        if (k.length <= 64) stats.keys.add(k);
        recordControlExpiration(k, val, {
          parentKey: key,
          objectKeys: Object.keys(v).slice(0, 40),
          transport: meta.transport,
          endpoint: meta.endpoint,
          direction: meta.direction
        });
        let childAsset = ownAsset;
        if (!childAsset && QUOTE_CONTAINER.test(key || k)) childAsset = canonicalAsset(k) || assetFromText(k);
        if (!childAsset) childAsset = canonicalAsset(k) || '';
        if (val && typeof val === 'object') stack.push({ v: val, d: d + 1, asset: childAsset, key: k, tf: ownTf });
      }
    }
    trimSet(stats.keys, 400);
  };

  const scan = (data, meta = {}) => {
    stats.parse.frames++;
    if (typeof data === 'object' && data && !(data instanceof Blob) && !(data instanceof ArrayBuffer) && !ArrayBuffer.isView(data)) {
      scanValue(data, meta); stats.parse.decoded++; return;
    }
    if (typeof data !== 'string') return;
    const decoded = decodeStringFrames(data);
    for (const value of decoded) { scanValue(value, meta); stats.parse.decoded++; }
  };

  const feedQuality = () => {
    const t = now();
    const fresh = [...stats.assets.values()].filter(c => t - Number(c.observedAt || 0) <= 6000);
    const repeated = fresh.filter(c => Number(c.seenCount || 0) >= 2);
    const highConfidence = repeated.filter(c => Number(c.confidence || 0) >= 55);
    let q = 0;
    if (stats.connections.ws > 0) q += 25;
    if (fresh.length) q += 20;
    if (repeated.length) q += 25;
    if (highConfidence.length) q += 20;
    if (stats.candles.size) q += 10;
    return Math.max(0, Math.min(100, q));
  };

  const flushTimer = () => {
    if (flushTimer.id) return;
    flushTimer.id = setTimeout(() => {
      flushTimer.id = null;
      const t = now();
      for (const [asset, c] of stats.assets) if (t - Number(c.observedAt || 0) > 60000) stats.assets.delete(asset);
      trimSet(stats.endpoints, 120);
      const recentCandles = {};
      for (const [asset, rows] of [...stats.candles.entries()].slice(-30)) recentCandles[asset] = rows.slice(-120);
      const candidates = [...stats.assets.values()]
        .sort((a, b) => Number(b.selected) - Number(a.selected) || Number(b.confidence || 0) - Number(a.confidence || 0) || Number(b.observedAt || 0) - Number(a.observedAt || 0))
        .slice(0, 150);
      window.postMessage({
        source: 'ATS_NETWORK_PROBE',
        type: 'summary',
        payload: {
          messages: { ...stats.messages }, outbound: { ...stats.outbound }, connections: { ...stats.connections }, endpoints: [...stats.endpoints].slice(-24),
          keys: [...stats.keys].slice(0, 160), candidates, candidateCount: candidates.length, recentCandles,
          expirationTrace: stats.expirationTrace.slice(-24),
          controls: stats.controlExpiration && t - Number(stats.controlExpiration.observedAt || 0) < 7000
            ? { expiration: stats.controlExpiration.expiration, confidence: stats.controlExpiration.confidence, sourceKey: stats.controlExpiration.sourceKey, observedAt: stats.controlExpiration.observedAt }
            : null,
          feedQuality: feedQuality(), parser: { ...stats.parse }, primaryTransport: stats.connections.ws > 0 ? 'ws' : 'http',
          privacy: 'Diagnóstico temporário: payloads de rede são inspecionados localmente apenas para localizar campos/eventos de expiração. O relatório exporta somente direção, transporte, endpoint sem query, nome do campo/evento e valor de duração; tokens, headers, cookies e credenciais não são exportados.'
        }
      }, '*');
    }, 220);
  };

  const record = (transport, url, data) => {
    if (stats.messages[transport] != null) stats.messages[transport]++;
    const endpoint = safeUrl(url); if (endpoint) stats.endpoints.add(`${transport}:${endpoint}`);
    trimSet(stats.endpoints, 120);
    scan(data, { transport, endpoint, direction: 'in' });
    flushTimer();
  };
  const recordOutbound = (transport, url, data) => {
    if (stats.outbound[transport] != null) stats.outbound[transport]++;
    const endpoint = safeUrl(url); if (endpoint) stats.endpoints.add(`${transport}:${endpoint}`);
    trimSet(stats.endpoints, 120);
    scan(data, { transport, endpoint, direction: 'out' });
    flushTimer();
  };
  const inspectOutboundBody = (transport, url, body) => {
    if (body == null) return;
    if (typeof body === 'string') {
      if (body.length <= 1048576) recordOutbound(transport, url, body);
      return;
    }
    if (body instanceof URLSearchParams) {
      const obj = {};
      for (const [key, value] of body.entries()) if (!SENSITIVE.test(key)) obj[key] = value;
      recordOutbound(transport, url, obj);
      return;
    }
    if (body instanceof FormData) {
      const obj = {};
      for (const [key, value] of body.entries()) {
        if (SENSITIVE.test(key) || typeof value !== 'string') continue;
        obj[key] = value;
      }
      recordOutbound(transport, url, obj);
      return;
    }
    if (body instanceof Blob || body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
      toText(body).then(text => { if (text) recordOutbound(transport, url, text); }).catch(() => {});
    }
  };

  if (window.WebSocket) {
    const Native = window.WebSocket;
    const nativeSend = Native.prototype.send;
    Native.prototype.send = function(data) {
      try {
        if (typeof data === 'string') recordOutbound('ws', this.url, data);
        else toText(data).then(text => { if (text) recordOutbound('ws', this.url, text); }).catch(() => {});
      } catch {}
      return nativeSend.call(this, data);
    };
    const Wrapped = function(url, protocols) {
      const ws = protocols === undefined ? new Native(url) : new Native(url, protocols);
      stats.connections.ws++;
      const endpoint = safeUrl(url); if (endpoint) stats.endpoints.add(`ws:${endpoint}`);
      flushTimer();
      ws.addEventListener('message', e => {
        if (typeof e.data === 'string') record('ws', url, e.data);
        else toText(e.data).then(t => { if (t) record('ws', url, t); }).catch(() => {});
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
      const url = args[0] instanceof Request ? args[0].url : args[0];
      try {
        if (args[0] instanceof Request && !args[1]?.body) {
          const clone = args[0].clone();
          clone.text().then(text => { if (text && text.length <= 1048576) recordOutbound('fetch', url, text); }).catch(() => {});
        } else {
          inspectOutboundBody('fetch', url, args[1]?.body);
        }
      } catch {}
      const r = await nativeFetch.apply(this, args);
      try {
        const ct = r.headers.get('content-type') || '';
        if (/json|text|javascript|event-stream/i.test(ct)) {
          const clone = r.clone();
          clone.text().then(t => { if (t && t.length <= 1048576) record('fetch', url, t); }).catch(() => {});
        }
      } catch {}
      return r;
    };
  }

  if (window.XMLHttpRequest) {
    const X = window.XMLHttpRequest, open = X.prototype.open, send = X.prototype.send;
    X.prototype.open = function(method, url, ...rest) { this.__atsUrl = url; return open.call(this, method, url, ...rest); };
    X.prototype.send = function(...args) {
      try { inspectOutboundBody('xhr', this.__atsUrl, args[0]); } catch {}
      this.addEventListener('load', () => {
        try {
          const ct = this.getResponseHeader('content-type') || '';
          if (!/json|text|javascript|event-stream/i.test(ct)) return;
          if (this.responseType === '' || this.responseType === 'text') {
            const t = String(this.responseText || ''); if (t && t.length <= 1048576) record('xhr', this.__atsUrl, t);
          } else if (this.responseType === 'json') record('xhr', this.__atsUrl, this.response);
        } catch {}
      }, { once: true });
      return send.apply(this, args);
    };
  }

  window.postMessage({ source: 'ATS_NETWORK_PROBE', type: 'ready', payload: { ready: true } }, '*');
})();
