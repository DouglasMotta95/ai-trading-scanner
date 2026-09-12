(() => {
  if (globalThis.__ATS_GENERIC_ADAPTER__) return;
  globalThis.__ATS_GENERIC_ADAPTER__ = true;

  let platform = null;
  let networkState = {};
  let timer = null;
  let running = false;
  let lastAsset = null;

  const COMMON_QUOTES = new Set(['USDT','USDC','USD','EUR','GBP','JPY','AUD','CAD','CHF','NZD','BRL','BTC','ETH']);
  const host = String(location.hostname || '').toLowerCase().replace(/\.$/, '');
  const isCasaTradeHost = value => value === 'casatrade.com' || value.endsWith('.casatrade.com') || value === 'casatrade.io' || value.endsWith('.casatrade.io');
  if (!isCasaTradeHost(host)) return;

  const clean = v => String(v ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  const fold = v => clean(v).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const num = v => {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    let s = clean(v).replace(/[^\d,.-]/g, '');
    if (!s) return null;
    if (s.includes(',') && s.includes('.')) s = s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
    else s = s.replace(',', '.');
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  };
  const visible = el => {
    if (!el || !(el instanceof Element)) return false;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity || 1) > 0;
  };
  const textOf = el => clean(el?.innerText || el?.textContent || el?.getAttribute?.('aria-label') || '');

  function deepElements(limit = 9000) {
    const out = [];
    const roots = [document];
    const seenRoots = new Set();
    while (roots.length && out.length < limit) {
      const root = roots.shift();
      if (!root || seenRoots.has(root)) continue;
      seenRoots.add(root);
      let nodes = [];
      try { nodes = [...root.querySelectorAll('*')]; } catch {}
      for (const el of nodes) {
        out.push(el);
        if (out.length >= limit) break;
        if (el.shadowRoot) roots.push(el.shadowRoot);
      }
    }
    return out;
  }

  function fullText() {
    const parts = [document.body?.innerText || document.body?.textContent || ''];
    for (const el of deepElements(2500)) {
      if (el.shadowRoot) parts.push(el.shadowRoot.textContent || '');
    }
    return clean(parts.join(' ')).slice(0, 220000);
  }

  const canonicalAsset = value => {
    let raw = clean(value).toUpperCase();
    if (!raw || raw.length > 64) return '';
    const otc = /(?:\(|\b|[_-])OTC(?:\)|\b)?/.test(raw);
    let s = raw.replace(/\(OTC\)|\bOTC\b/g, '').replace(/^FRX[:_-]?/, '').replace(/\s+/g, '').replace(/_/g, '/').replace(/-/g, '/').replace(/:+/g, '/');
    s = s.replace(/^\/+|\/+$/g, '').replace(/\/{2,}/g, '/');
    if (!s.includes('/')) {
      const quote = [...COMMON_QUOTES].find(q => s.length > q.length && s.endsWith(q));
      if (quote) s = `${s.slice(0, -quote.length)}/${quote}`;
      else if (/^[A-Z]{6}$/.test(s)) s = `${s.slice(0, 3)}/${s.slice(3)}`;
    }
    const m = s.match(/^([A-Z0-9]{2,16})\/([A-Z0-9]{2,12})$/);
    if (!m || !COMMON_QUOTES.has(m[2])) return '';
    return `${m[1]}/${m[2]}${otc ? ' (OTC)' : ''}`;
  };
  const assetRegex = /\b(?:[A-Z0-9]{2,16}\s*[\/_-]\s*(?:USDT|USDC|USD|EUR|GBP|JPY|AUD|CAD|CHF|NZD|BRL|BTC|ETH)|[A-Z]{6})(?:\s*\(?OTC\)?)?\b/gi;
  const assetsIn = text => {
    const out = [];
    for (const match of String(text || '').matchAll(assetRegex)) {
      const asset = canonicalAsset(match[0]);
      if (asset) out.push(asset);
    }
    return out;
  };

  const normalizeTf = value => {
    const s = fold(value).replace(/\s+/g, '');
    let m = s.match(/^m(1|2|5|15|30)$/); if (m) return `M${m[1]}`;
    m = s.match(/^(1|2|5|15|30)(?:m|min|minuto|minutos)$/); if (m) return `M${m[1]}`;
    m = s.match(/^s(5|15|30)$/); if (m) return `S${m[1]}`;
    m = s.match(/^(5|15|30)(?:s|seg|segundo|segundos)$/); if (m) return `S${m[1]}`;
    return /^(h1|1h|60m|60min)$/.test(s) ? 'H1' : null;
  };
  const normalizeExp = value => {
    const s = fold(value).replace(/\s+/g, '');
    let m = s.match(/^(\d{1,4})(?:s|seg|segundo|segundos)$/); if (m) return `${Number(m[1])}s`;
    m = s.match(/^(\d{1,3})(?:m|min|minuto|minutos)$/); if (m) return Number(m[1]) === 1 ? '60s' : `${Number(m[1])}m`;
    return null;
  };

  function scanAsset() {
    const page = fullText();
    const counts = new Map();
    for (const asset of assetsIn(page)) counts.set(asset, (counts.get(asset) || 0) + 1);
    const map = new Map();
    for (const el of deepElements()) {
      if (!visible(el)) continue;
      const text = textOf(el);
      if (!text || text.length > 90) continue;
      for (const asset of assetsIn(text)) {
        const r = el.getBoundingClientRect();
        let score = (counts.get(asset) || 0) * 25;
        if (el.getAttribute?.('aria-selected') === 'true' || /active|selected|current/i.test(String(el.className || ''))) score += 80;
        if (/\bOTC\b/i.test(text)) score += 45;
        if (r.top >= 0 && r.top < innerHeight * .42) score += 25;
        if (r.left >= 0 && r.left < innerWidth * .62) score += 12;
        if (/portfolio|historico|histórico|chat|suporte|leader|depositar/i.test(fold(text))) score -= 45;
        const previous = map.get(asset);
        if (!previous || score > previous.score) map.set(asset, { asset, score, el });
      }
    }
    if (!map.size && counts.size) {
      const fallback = [...counts.entries()].sort((a, b) => b[1] - a[1] || Number(/\(OTC\)$/.test(b[0])) - Number(/\(OTC\)$/.test(a[0])))[0];
      return fallback ? { asset: fallback[0], score: fallback[1] * 20, el: null } : null;
    }
    return [...map.values()].sort((a, b) => b.score - a.score)[0] || null;
  }

  const decimalPrices = text => {
    const out = [];
    for (const match of String(text || '').matchAll(/\b\d{1,6}[.,]\d{3,8}\b/g)) {
      const value = num(match[0]);
      if (value != null && value > 0) out.push(value);
    }
    return out;
  };
  const firstPriceAfter = (page, label) => {
    const re = new RegExp(`(?:${label})\\s*([0-9]{1,6}[.,][0-9]{3,8})`, 'i');
    return num(page.match(re)?.[1]);
  };
  function tradeButtonPrice() {
    const page = fullText();
    const buyText = firstPriceAfter(page, 'COMPRAR|BUY');
    const sellText = firstPriceAfter(page, 'VENDER|SELL');
    if (buyText != null && sellText != null) return (buyText + sellText) / 2;
    if (buyText != null || sellText != null) return buyText ?? sellText;

    const buy = [], sell = [];
    for (const el of deepElements()) {
      if (!visible(el)) continue;
      const text = textOf(el);
      if (!text || text.length > 100) continue;
      const f = fold(text);
      if (!/\b(comprar|buy|vender|sell)\b/.test(f)) continue;
      const values = decimalPrices(text);
      if (!values.length) continue;
      if (/\b(comprar|buy)\b/.test(f)) buy.push(values[values.length - 1]);
      if (/\b(vender|sell)\b/.test(f)) sell.push(values[values.length - 1]);
    }
    if (buy.length && sell.length) return (buy[0] + sell[0]) / 2;
    return buy[0] ?? sell[0] ?? null;
  }

  function chartPrice() {
    const values = [];
    for (const el of deepElements()) {
      if (!visible(el)) continue;
      const text = textOf(el);
      if (!text || text.length > 36 || /%|\$|R\$/i.test(text)) continue;
      for (const value of decimalPrices(text)) {
        const r = el.getBoundingClientRect();
        let score = 0;
        if (r.left > innerWidth * .5) score += 20;
        if (r.top > innerHeight * .12 && r.top < innerHeight * .88) score += 12;
        if (/price|quote|rate/i.test(String(el.className || ''))) score += 22;
        values.push({ value, score });
      }
    }
    values.sort((a, b) => b.score - a.score);
    return values[0]?.value ?? null;
  }

  function selectedTimeframe() {
    const rows = [];
    for (const el of deepElements()) {
      if (!visible(el)) continue;
      const text = textOf(el);
      if (!text || text.length > 20) continue;
      const tf = normalizeTf(text);
      if (!tf) continue;
      const r = el.getBoundingClientRect();
      let score = 0;
      if (el.getAttribute?.('aria-selected') === 'true' || /active|selected|current/i.test(String(el.className || ''))) score += 80;
      if (r.left < innerWidth * .35) score += 20;
      if (r.top > innerHeight * .18 && r.top < innerHeight * .9) score += 10;
      rows.push({ tf, score });
    }
    rows.sort((a, b) => b.score - a.score);
    return rows[0]?.tf || null;
  }

  function selectedExpiration() {
    const page = fullText();
    const match = page.match(/(?:EXPIRA(?:ÇÃO|CAO)|EXPIRY|DURATION)\s*[^\d]{0,40}(\d{1,4})\s*(S|SEG|SEGUNDO|SEGUNDOS|M|MIN|MINUTO|MINUTOS)/i);
    if (match) return normalizeExp(`${match[1]}${match[2]}`);
    for (const el of deepElements()) {
      if (!visible(el)) continue;
      const text = textOf(el);
      if (!text || text.length > 80) continue;
      const local = fold([text, el.parentElement?.innerText, el.getAttribute?.('aria-label'), el.getAttribute?.('data-testid')].filter(Boolean).join(' '));
      if (!/expira|expiry|duration/.test(local)) continue;
      const value = text.match(/\d{1,4}\s*(?:s|seg|segundo|segundos|m|min|minuto|minutos)/i)?.[0] || local.match(/\d{1,4}\s*(?:s|seg|segundo|segundos|m|min|minuto|minutos)/i)?.[0];
      const exp = normalizeExp(value);
      if (exp) return exp;
    }
    return null;
  }

  function instrumentType(assetEl) {
    const local = fold([assetEl?.parentElement?.innerText, assetEl?.innerText, fullText().slice(0, 10000)].filter(Boolean).join(' '));
    if (/\bblitz\b/.test(local)) return 'blitz';
    if (/\bbinaria\b|\bbinary\b/.test(local)) return 'binary';
    if (/\bturbo\b/.test(local)) return 'turbo';
    return 'unknown';
  }

  const networkCandidates = () => (Array.isArray(networkState?.candidates) ? networkState.candidates : []).map(c => ({
    ...c,
    asset: canonicalAsset(c.asset),
    price: num(c.price) ?? (num(c.bid) != null && num(c.ask) != null ? (num(c.bid) + num(c.ask)) / 2 : null),
    timeframe: normalizeTf(c.timeframe),
    expiration: normalizeExp(c.expiration),
    observedAt: Number(c.observedAt || 0),
    confidence: Number(c.confidence || 0),
    seenCount: Number(c.seenCount || 0)
  })).filter(c => c.asset && c.price != null && c.price > 0);

  const networkQuoteFor = asset => {
    const wanted = canonicalAsset(asset);
    if (!wanted) return null;
    const noOtc = wanted.replace(/ \(OTC\)$/, '');
    return networkCandidates()
      .filter(c => Date.now() - c.observedAt < 10000)
      .filter(c => c.asset === wanted || c.asset.replace(/ \(OTC\)$/, '') === noOtc)
      .sort((a, b) => Number(b.selected === true) - Number(a.selected === true) || b.confidence - a.confidence || b.seenCount - a.seenCount)[0] || null;
  };

  const historyFor = asset => {
    const wanted = canonicalAsset(asset);
    if (!wanted) return [];
    const noOtc = wanted.replace(/ \(OTC\)$/, '');
    const history = networkState?.recentCandles || {};
    const key = Object.keys(history).find(k => {
      const c = canonicalAsset(k);
      return c && (c === wanted || c.replace(/ \(OTC\)$/, '') === noOtc);
    });
    return key && Array.isArray(history[key]) ? history[key].slice(-120) : [];
  };

  async function inspect() {
    if (!platform || running) return;
    running = true;
    try {
      const active = scanAsset();
      const activeAsset = active?.asset || lastAsset;
      const net = networkQuoteFor(activeAsset);
      const asset = activeAsset || net?.asset || null;
      const price = tradeButtonPrice() ?? net?.price ?? chartPrice() ?? null;
      if (!asset || price == null) return;
      lastAsset = asset;

      const timeframe = selectedTimeframe() || net?.timeframe || null;
      const expiration = selectedExpiration() || net?.expiration || null;
      const history = historyFor(asset);
      const type = net?.instrumentType || instrumentType(active?.el);
      const marketType = /\(OTC\)$/i.test(asset) ? 'otc' : 'regular';
      const candidate = {
        asset, price, timeframe, expiration, transport: net?.transport || 'dom', source: net ? 'network+dom' : 'dom',
        confidence: net ? Math.max(70, Number(net.confidence || 0)) : 70, seenCount: Number(net?.seenCount || 1), observedAt: Date.now()
      };

      chrome.runtime.sendMessage({
        type: 'ATS_DOM_CATALOG',
        payload: { candidates: [candidate], assetCount: 1, timeframe, expiration, instrumentType: type, marketType }
      }).catch(() => {});

      chrome.runtime.sendMessage({
        type: 'ATS_PLATFORM_SNAPSHOT',
        payload: {
          platformId: platform.id,
          platformName: platform.name,
          adapterVersion: chrome.runtime.getManifest().version,
          connection: 'online',
          url: location.origin + location.pathname,
          asset,
          timeframe,
          price,
          marketType,
          instrumentType: type,
          expiration,
          serverTime: Number(net?.timestamp) > 1e12 ? Number(net.timestamp) : null,
          candles: history,
          ticks: [{ price, at: Date.now() }],
          capabilities: { structuredQuotes: !!net, candles: history.length >= 3, expiration: !!expiration, multiAsset: false },
          diagnostics: {
            capture: net ? 'rede-validada+frame-dom' : 'frame-dom-casatrade',
            frameUrl: location.href,
            structuredSource: net?.transport || null,
            networkQuoteMatched: !!net,
            networkConfidence: Number(net?.confidence || 0),
            networkQuality: Number(networkState?.feedQuality || 0),
            missing: [!timeframe ? 'timeframe' : null, !expiration ? 'expiration' : null].filter(Boolean),
            host: location.hostname,
            candleHistory: history.length,
            privacy: 'Sem cookies, credenciais, tokens, headers ou saldo.'
          }
        }
      }).catch(() => {});
    } finally {
      running = false;
    }
  }

  const schedule = (delay = 80) => { clearTimeout(timer); timer = setTimeout(inspect, delay); };
  async function init() {
    const response = await chrome.runtime.sendMessage({ type: 'ATS_GET_PLATFORM_CONFIG', host: location.hostname }).catch(() => null);
    platform = response?.platform || null;
    if (!platform) return;
    const stored = await chrome.storage.local.get('scannerState').catch(() => ({}));
    networkState = stored.scannerState?.diagnostics?.network || {};
    chrome.storage.onChanged.addListener(changes => {
      if (!changes.scannerState) return;
      networkState = changes.scannerState.newValue?.diagnostics?.network || {};
      schedule(40);
    });
    const start = () => {
      if (!document.documentElement) return setTimeout(start, 50);
      new MutationObserver(() => schedule(70)).observe(document.documentElement, {
        subtree: true, childList: true, characterData: true, attributes: true,
        attributeFilter: ['class','aria-selected','data-state','value']
      });
      inspect();
      setInterval(inspect, 700);
    };
    start();
  }
  init().catch(() => {});
})();
