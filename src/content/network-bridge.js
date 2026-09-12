(() => {
  if (globalThis.__ATS_NETWORK_BRIDGE__) return;
  globalThis.__ATS_NETWORK_BRIDGE__ = true;

  const RELAY_SOURCE = 'ATS_NETWORK_PROBE_RELAY_V2';
  const isTop = window === window.top;
  const localCandles = new Map();
  const num = v => v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null;
  const clean = v => String(v ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();

  function canonicalAsset(value = '') {
    let s = clean(value).toUpperCase();
    if (!s) return '';
    const otc = /(?:\(|\b|[_-])OTC(?:\)|\b)?/.test(s);
    s = s.replace(/\(OTC\)|\bOTC\b/g, '').replace(/\s+/g, '').replace(/_/g, '/').replace(/-/g, '/').replace(/^\/+|\/+$/g, '');
    if (!s.includes('/') && /^[A-Z]{6}$/.test(s)) s = `${s.slice(0, 3)}/${s.slice(3)}`;
    return s ? `${s}${otc ? ' (OTC)' : ''}` : '';
  }

  function bestCandidate(payload = {}) {
    const rows = Array.isArray(payload.candidates) ? payload.candidates.slice() : [];
    rows.sort((a, b) =>
      Number(b?.selected === true) - Number(a?.selected === true)
      || Number(b?.confidence || 0) - Number(a?.confidence || 0)
      || Number(b?.seenCount || 0) - Number(a?.seenCount || 0)
      || Number(b?.observedAt || 0) - Number(a?.observedAt || 0)
    );
    return rows.find(c => {
      const price = num(c?.price) ?? (num(c?.bid) != null && num(c?.ask) != null ? (num(c.bid) + num(c.ask)) / 2 : null);
      return String(c?.asset || '').trim() && price != null && price > 0;
    }) || null;
  }

  function historyFor(payload = {}, asset = '') {
    const history = payload.recentCandles || {};
    const wanted = canonicalAsset(asset).replace(/\s*\(OTC\)\s*$/, '');
    const key = Object.keys(history).find(k => canonicalAsset(k).replace(/\s*\(OTC\)\s*$/, '') === wanted);
    return key && Array.isArray(history[key]) ? history[key].slice(-120) : [];
  }

  function updateLocalCandle(asset, price, timeframe = 'M1') {
    if (!asset || !Number.isFinite(price)) return [];
    const tf = /^M\d+$/i.test(timeframe) ? timeframe.toUpperCase() : 'M1';
    const minutes = Number(tf.slice(1)) || 1;
    const size = minutes * 60000;
    const time = Math.floor(Date.now() / size) * size;
    const key = canonicalAsset(asset);
    const rows = localCandles.get(key) || [];
    let row = rows.find(x => x.time === time);
    if (!row) {
      row = { time, open: price, high: price, low: price, close: price, timeframe: tf };
      rows.push(row);
    } else {
      row.high = Math.max(Number(row.high), price);
      row.low = Math.min(Number(row.low), price);
      row.close = price;
    }
    rows.sort((a, b) => a.time - b.time);
    localCandles.set(key, rows.slice(-120));
    return localCandles.get(key) || [];
  }

  function sendSnapshot({ asset, price, timeframe = 'M1', expiration = null, candles = [], source = 'market', feedQuality = 0, structured = false }) {
    if (!asset || price == null) return;
    chrome.runtime.sendMessage({
      type: 'ATS_PLATFORM_SNAPSHOT',
      payload: {
        platformId: 'casatrade',
        platformName: 'CasaTrade',
        connection: 'online',
        asset: canonicalAsset(asset),
        price: Number(price),
        timeframe,
        expiration,
        instrumentType: 'unknown',
        marketType: /\(OTC\)/i.test(asset) ? 'otc' : 'regular',
        serverTime: null,
        candles: Array.isArray(candles) ? candles.slice(-120) : [],
        ticks: [{ price: Number(price), at: Date.now() }],
        capabilities: {
          structuredQuotes: !!structured,
          candles: Array.isArray(candles) && candles.length >= 3,
          expiration: !!expiration,
          multiAsset: false
        },
        diagnostics: {
          capture: source,
          feedQuality: Number(feedQuality || 0),
          relayed: true
        }
      }
    }).catch(() => {});
  }

  function publishToExtension(payload = {}) {
    chrome.runtime.sendMessage({ type: 'ATS_NETWORK_DIAGNOSTIC', payload }).catch(() => {});

    const candidate = bestCandidate(payload);
    if (!candidate) return;

    const price = num(candidate.price) ?? (num(candidate.bid) != null && num(candidate.ask) != null ? (num(candidate.bid) + num(candidate.ask)) / 2 : null);
    const asset = canonicalAsset(candidate.asset);
    const networkHistory = historyFor(payload, asset);
    const timeframe = candidate.timeframe || networkHistory.at(-1)?.timeframe || 'M1';
    const localHistory = updateLocalCandle(asset, Number(price), timeframe);
    const candles = networkHistory.length >= 2 ? networkHistory : localHistory;

    sendSnapshot({
      asset,
      price,
      timeframe,
      expiration: candidate.expiration || null,
      candles,
      source: `top-frame-relay:${candidate.transport || payload.primaryTransport || 'market'}`,
      feedQuality: payload.feedQuality,
      structured: candidate.transport !== 'rendered'
    });
  }

  function deepText() {
    const parts = [document.body?.innerText || document.body?.textContent || ''];
    const roots = [document];
    const seen = new Set();
    while (roots.length && parts.length < 600) {
      const root = roots.shift();
      if (!root || seen.has(root)) continue;
      seen.add(root);
      let nodes = [];
      try { nodes = root.querySelectorAll('*'); } catch {}
      for (const el of nodes) {
        if (el.shadowRoot) {
          parts.push(el.shadowRoot.textContent || '');
          roots.push(el.shadowRoot);
        }
      }
    }
    return clean(parts.join(' ')).slice(0, 300000);
  }

  function parsePrice(raw) {
    if (!raw) return null;
    const n = Number(String(raw).replace(',', '.'));
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  function directDomFallback() {
    if (!isTop) return;
    const text = deepText();
    if (!text) return;

    const pair = text.match(/\b([A-Z0-9]{2,16})\s*\/\s*(USDT|USDC|USD|EUR|GBP|JPY|AUD|CAD|CHF|NZD|BRL|BTC|ETH)(?:\s*\(\s*OTC\s*\))?/i)?.[0] || '';
    const asset = canonicalAsset(pair);
    if (!asset) return;

    const buy = parsePrice(text.match(/(?:COMPRAR|BUY)\s*([0-9]{1,6}[.,][0-9]{3,8})/i)?.[1]);
    const sell = parsePrice(text.match(/(?:VENDER|SELL)\s*([0-9]{1,6}[.,][0-9]{3,8})/i)?.[1]);
    const price = buy != null && sell != null ? (buy + sell) / 2 : (buy ?? sell ?? null);
    if (price == null) return;

    const tfRaw = text.match(/(?:^|\s)(M(?:1|2|5|15|30)|(?:1|2|5|15|30)\s*(?:m|min))(?:\s|$)/i)?.[1] || 'M1';
    const tfNumber = String(tfRaw).match(/\d+/)?.[0] || '1';
    const timeframe = `M${tfNumber}`;

    const exp = text.match(/(?:EXPIRA(?:ÇÃO|CAO)|EXPIRY|DURATION)\s*[^0-9]{0,30}(\d{1,4})\s*(S|SEG|SEGUNDO|SEGUNDOS|M|MIN|MINUTO|MINUTOS)/i);
    let expiration = null;
    if (exp) expiration = /^M|MIN/i.test(exp[2]) ? (Number(exp[1]) === 1 ? '60s' : `${Number(exp[1])}m`) : `${Number(exp[1])}s`;

    const candles = updateLocalCandle(asset, price, timeframe);
    sendSnapshot({ asset, price, timeframe, expiration, candles, source: 'top-frame-dom-fallback', feedQuality: 55, structured: false });
  }

  function markConnected() {
    chrome.runtime.sendMessage({
      type: 'ATS_PLATFORM_SNAPSHOT',
      payload: { platformId: 'casatrade', platformName: 'CasaTrade', connection: 'online', asset: null, price: null }
    }).catch(() => {});
  }

  window.addEventListener('message', event => {
    const data = event.data;

    if (data?.source === 'ATS_NETWORK_PROBE' && data?.type === 'summary') {
      const payload = data.payload || {};
      if (isTop) publishToExtension(payload);
      else {
        try { window.top.postMessage({ source: RELAY_SOURCE, type: 'summary', payload }, '*'); } catch {}
      }
      return;
    }

    if (data?.source === 'ATS_NETWORK_PROBE' && data?.type === 'ready') {
      if (isTop) markConnected();
      else {
        try { window.top.postMessage({ source: RELAY_SOURCE, type: 'ready' }, '*'); } catch {}
      }
      return;
    }

    if (isTop && data?.source === RELAY_SOURCE) {
      if (data.type === 'summary') publishToExtension(data.payload || {});
      if (data.type === 'ready') markConnected();
    }
  });

  if (isTop) {
    setInterval(() => {
      try { directDomFallback(); } catch {}
    }, 400);
  }
})();