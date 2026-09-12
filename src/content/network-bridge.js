(() => {
  if (globalThis.__ATS_NETWORK_BRIDGE__) return;
  globalThis.__ATS_NETWORK_BRIDGE__ = true;

  const RELAY_SOURCE = 'ATS_NETWORK_PROBE_RELAY_V3';
  const isTop = window === window.top;
  const localCandles = new Map();
  const QUOTES = new Set(['USDT','USDC','USD','EUR','GBP','JPY','AUD','CAD','CHF','NZD','BRL','BTC','ETH']);
  const num = v => v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null;
  const clean = v => String(v ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();

  function canonicalAsset(value = '') {
    let s = clean(value).toUpperCase();
    if (!s || s.length > 80) return '';
    const otc = /(?:\(|\b|[_-])OTC(?:\)|\b)?/.test(s);
    s = s.replace(/\(\s*OTC\s*\)|\bOTC\b/g, '').replace(/^FRX[:_-]?/, '')
      .replace(/\s+/g, '').replace(/_/g, '/').replace(/-/g, '/').replace(/:+/g, '/')
      .replace(/^\/+|\/+$/g, '').replace(/\/{2,}/g, '/');
    if (!s.includes('/')) {
      const quote = [...QUOTES].find(q => s.length > q.length && s.endsWith(q));
      if (quote) s = `${s.slice(0, -quote.length)}/${quote}`;
      else if (/^[A-Z]{6}$/.test(s)) s = `${s.slice(0, 3)}/${s.slice(3)}`;
    }
    const m = s.match(/^([A-Z0-9]{2,16})\/([A-Z0-9]{2,12})$/);
    if (!m || !QUOTES.has(m[2])) return '';
    return `${m[1]}/${m[2]}${otc ? ' (OTC)' : ''}`;
  }

  const assetBase = value => canonicalAsset(value).replace(/\s*\(OTC\)\s*$/, '');
  const visible = el => {
    if (!el || !(el instanceof Element)) return false;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity || 1) > 0;
  };

  function deepElements(limit = 9000) {
    const out = [];
    const roots = [document];
    const seen = new Set();
    while (roots.length && out.length < limit) {
      const root = roots.shift();
      if (!root || seen.has(root)) continue;
      seen.add(root);
      let nodes = [];
      try { nodes = root.querySelectorAll('*'); } catch {}
      for (const el of nodes) {
        out.push(el);
        if (out.length >= limit) break;
        if (el.shadowRoot) roots.push(el.shadowRoot);
      }
    }
    return out;
  }

  function selectedAssetFromDom() {
    const rows = [];
    const re = /\b([A-Z0-9]{2,16})\s*\/\s*(USDT|USDC|USD|EUR|GBP|JPY|AUD|CAD|CHF|NZD|BRL|BTC|ETH)(?:\s*\(\s*OTC\s*\))?/i;
    for (const el of deepElements(7000)) {
      if (!visible(el)) continue;
      const text = clean(el.innerText || el.textContent || el.getAttribute?.('aria-label') || '');
      if (!text || text.length > 100) continue;
      const m = text.match(re);
      if (!m) continue;
      const asset = canonicalAsset(m[0]);
      if (!asset) continue;
      const r = el.getBoundingClientRect();
      const flags = `${el.className || ''} ${el.getAttribute?.('aria-selected') || ''} ${el.getAttribute?.('data-state') || ''} ${el.getAttribute?.('aria-current') || ''}`;
      let score = 20;
      if (/true|active|selected|current|checked/i.test(flags)) score += 120;
      if (/\(OTC\)/i.test(text)) score += 24;
      if (r.top >= 0 && r.top < innerHeight * .35) score += 28;
      if (r.left >= 0 && r.left < innerWidth * .7) score += 15;
      if (text.length < 40) score += 12;
      rows.push({ asset, score });
    }
    rows.sort((a, b) => b.score - a.score);
    return rows[0]?.asset || '';
  }

  function selectedTimeframeFromDom() {
    const rows = [];
    const normalize = raw => {
      const s = clean(raw).toUpperCase().replace(/\s+/g, '');
      let m = s.match(/^M(1|2|5|15|30)$/); if (m) return `M${m[1]}`;
      m = s.match(/^(1|2|5|15|30)(?:M|MIN)$/); if (m) return `M${m[1]}`;
      m = s.match(/^S(5|15|30)$/); if (m) return `S${m[1]}`;
      return /^(H1|1H|60M|60MIN)$/.test(s) ? 'H1' : null;
    };
    for (const el of deepElements(6000)) {
      if (!visible(el)) continue;
      const text = clean(el.innerText || el.textContent || el.value || '');
      if (!text || text.length > 24) continue;
      const tf = normalize(text);
      if (!tf) continue;
      const flags = `${el.className || ''} ${el.getAttribute?.('aria-selected') || ''} ${el.getAttribute?.('aria-pressed') || ''} ${el.getAttribute?.('data-state') || ''}`;
      const r = el.getBoundingClientRect();
      let score = 5;
      if (/true|active|selected|current|checked|on/i.test(flags)) score += 130;
      if (r.left < innerWidth * .4) score += 18;
      if (r.top > innerHeight * .18 && r.top < innerHeight * .9) score += 10;
      rows.push({ tf, score });
    }
    rows.sort((a, b) => b.score - a.score);
    return rows[0]?.tf || null;
  }

  function selectedExpirationFromDom() {
    const text = deepText();
    const m = text.match(/(?:EXPIRA(?:ÇÃO|CAO)|EXPIRY|DURATION)\s*[^0-9]{0,40}(\d{1,4})\s*(S|SEG|SEGUNDO|SEGUNDOS|M|MIN|MINUTO|MINUTOS)/i);
    if (!m) return null;
    const n = Number(m[1]);
    return /^M|MIN/i.test(m[2]) ? (n === 1 ? '60s' : `${n}m`) : `${n}s`;
  }

  function timeframeSeconds(tf = 'M1') {
    const s = String(tf || '').toUpperCase();
    let m = s.match(/^M(\d+)$/); if (m) return Number(m[1]) * 60;
    m = s.match(/^S(\d+)$/); if (m) return Number(m[1]);
    m = s.match(/^H(\d+)$/); if (m) return Number(m[1]) * 3600;
    return 60;
  }

  function countdownFromDom(timeframe = 'M1') {
    const max = timeframeSeconds(timeframe);
    const rows = [];
    for (const el of deepElements(6000)) {
      if (!visible(el)) continue;
      const text = clean(el.innerText || el.textContent || '');
      const m = text.match(/^(\d{1,2}):([0-5]\d)$/);
      if (!m) continue;
      const total = Number(m[1]) * 60 + Number(m[2]);
      if (total <= 0 || total > max) continue;
      const r = el.getBoundingClientRect();
      let score = 10;
      if (r.left > innerWidth * .45 && r.left < innerWidth * .9) score += 25;
      if (r.top > innerHeight * .15 && r.top < innerHeight * .85) score += 20;
      if (text.length <= 5) score += 10;
      rows.push({ total, score });
    }
    rows.sort((a, b) => b.score - a.score || a.total - b.total);
    return rows[0]?.total ?? null;
  }

  function bestCandidate(payload = {}, preferredAsset = '') {
    const wanted = assetBase(preferredAsset);
    let rows = (Array.isArray(payload.candidates) ? payload.candidates : []).map(c => {
      const asset = canonicalAsset(c?.asset);
      const price = num(c?.price) ?? (num(c?.bid) != null && num(c?.ask) != null ? (num(c.bid) + num(c.ask)) / 2 : null);
      return { ...c, asset, price };
    }).filter(c => c.asset && c.price != null && c.price > 0);

    if (wanted) rows = rows.filter(c => assetBase(c.asset) === wanted);
    rows.sort((a, b) =>
      Number(b?.selected === true) - Number(a?.selected === true)
      || Number(b?.confidence || 0) - Number(a?.confidence || 0)
      || Number(b?.seenCount || 0) - Number(a?.seenCount || 0)
      || Number(b?.observedAt || 0) - Number(a?.observedAt || 0)
    );
    return rows[0] || null;
  }

  function historyFor(payload = {}, asset = '') {
    const history = payload.recentCandles || {};
    const wanted = assetBase(asset);
    const key = Object.keys(history).find(k => assetBase(k) === wanted);
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

  function sendSnapshot({ asset, price, timeframe = 'M1', expiration = null, secondsRemaining = null, candles = [], source = 'market', feedQuality = 0, structured = false }) {
    const cleanAsset = canonicalAsset(asset);
    if (!cleanAsset || price == null) return;
    chrome.runtime.sendMessage({
      type: 'ATS_PLATFORM_SNAPSHOT',
      payload: {
        platformId: 'casatrade',
        platformName: 'CasaTrade',
        connection: 'online',
        asset: cleanAsset,
        price: Number(price),
        timeframe,
        analysisTimeframe: timeframe,
        expiration,
        secondsRemaining: Number.isFinite(Number(secondsRemaining)) ? Number(secondsRemaining) : null,
        instrumentType: 'unknown',
        marketType: /\(OTC\)/i.test(cleanAsset) ? 'otc' : 'regular',
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

    const domAsset = selectedAssetFromDom();
    const candidate = bestCandidate(payload, domAsset);
    if (!candidate) return;

    const asset = canonicalAsset(candidate.asset);
    const price = Number(candidate.price);
    const networkHistory = historyFor(payload, asset);
    const timeframe = selectedTimeframeFromDom() || candidate.timeframe || networkHistory.at(-1)?.timeframe || 'M1';
    const expiration = selectedExpirationFromDom() || candidate.expiration || null;
    const secondsRemaining = countdownFromDom(timeframe);
    const localHistory = updateLocalCandle(asset, price, timeframe);
    const candles = networkHistory.length >= 2 ? networkHistory : localHistory;

    sendSnapshot({
      asset,
      price,
      timeframe,
      expiration,
      secondsRemaining,
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

  function labeledPrice(label) {
    const rows = [];
    const labelRe = new RegExp(`\\b(?:${label})\\b`, 'i');
    for (const el of deepElements(7000)) {
      if (!visible(el)) continue;
      const text = clean(el.innerText || el.textContent || '');
      if (!text || text.length > 140 || !labelRe.test(text)) continue;
      const values = [...text.matchAll(/\b\d{1,6}[.,]\d{3,8}\b/g)].map(m => parsePrice(m[0])).filter(v => v != null);
      if (!values.length) continue;
      const r = el.getBoundingClientRect();
      let score = 10;
      if (r.left > innerWidth * .55) score += 35;
      if (r.top > innerHeight * .2 && r.top < innerHeight * .85) score += 20;
      if (/button|trade|buy|sell|order/i.test(String(el.className || ''))) score += 20;
      rows.push({ value: values[values.length - 1], score });
    }
    rows.sort((a, b) => b.score - a.score);
    return rows[0]?.value ?? null;
  }

  function directDomFallback() {
    if (!isTop) return;
    const text = deepText();
    if (!text) return;

    const firstPair = text.match(/\b([A-Z0-9]{2,16})\s*\/\s*(USDT|USDC|USD|EUR|GBP|JPY|AUD|CAD|CHF|NZD|BRL|BTC|ETH)(?:\s*\(\s*OTC\s*\))?/i)?.[0] || '';
    const asset = selectedAssetFromDom() || canonicalAsset(firstPair);
    if (!asset) return;

    const buy = labeledPrice('COMPRAR|BUY') ?? parsePrice(text.match(/(?:COMPRAR|BUY)[^0-9]{0,60}([0-9]{1,6}[.,][0-9]{3,8})/i)?.[1]);
    const sell = labeledPrice('VENDER|SELL') ?? parsePrice(text.match(/(?:VENDER|SELL)[^0-9]{0,60}([0-9]{1,6}[.,][0-9]{3,8})/i)?.[1]);
    const price = buy != null && sell != null ? (buy + sell) / 2 : (buy ?? sell ?? null);
    if (price == null) return;

    const timeframe = selectedTimeframeFromDom() || 'M1';
    const expiration = selectedExpirationFromDom();
    const secondsRemaining = countdownFromDom(timeframe);
    const candles = updateLocalCandle(asset, price, timeframe);
    sendSnapshot({ asset, price, timeframe, expiration, secondsRemaining, candles, source: 'top-frame-dom-fallback', feedQuality: 60, structured: false });
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
    }, 300);
  }
})();