(() => {
  if (globalThis.__ATS_GENERIC_ADAPTER__) return;
  globalThis.__ATS_GENERIC_ADAPTER__ = true;

  const COMMON_QUOTES = new Set(['USDT','USDC','USD','EUR','GBP','JPY','AUD','CAD','CHF','NZD','BRL','BTC','ETH']);
  const host = String(location.hostname || '').toLowerCase().replace(/\.$/, '');
  const refHost = (() => { try { return new URL(document.referrer || '').hostname.toLowerCase().replace(/\.$/, ''); } catch { return ''; } })();
  const isCasaTradeHost = value => value === 'casatrade.com' || value.endsWith('.casatrade.com') || value === 'casatrade.io' || value.endsWith('.casatrade.io');
  const trustedHost = isCasaTradeHost(host) ? host : (isCasaTradeHost(refHost) ? refHost : '');
  if (!trustedHost) return;

  const FRAME_SOURCE = 'ATS_CT_FRAME_OBSERVATION_V2';
  const frameId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const isTop = window === window.top;
  const frameObservations = new Map();

  let platform = null;
  let networkState = {};
  let timer = null;
  let running = false;
  let lastAsset = null;
  let lastEmitAt = 0;

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
  const classText = el => {
    const parts = [];
    let node = el;
    for (let i = 0; node && i < 4; i++, node = node.parentElement) {
      parts.push(String(node.className || ''), String(node.getAttribute?.('data-state') || ''), String(node.getAttribute?.('aria-selected') || ''));
    }
    return parts.join(' ');
  };

  function deepElements(limit = 12000) {
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
    for (const el of deepElements(3500)) {
      if (el.shadowRoot) parts.push(el.shadowRoot.textContent || '');
    }
    return clean(parts.join(' ')).slice(0, 300000);
  }

  const canonicalAsset = value => {
    let raw = clean(value).toUpperCase();
    if (!raw || raw.length > 80) return '';
    const otc = /(?:\(|\b|[_-])OTC(?:\)|\b)?/.test(raw);
    let s = raw.replace(/\(\s*OTC\s*\)|\bOTC\b/g, '')
      .replace(/^FRX[:_-]?/, '')
      .replace(/\s+/g, '')
      .replace(/_/g, '/')
      .replace(/-/g, '/')
      .replace(/:+/g, '/')
      .replace(/^\/+|\/+$/g, '')
      .replace(/\/{2,}/g, '/');
    if (!s.includes('/')) {
      const quote = [...COMMON_QUOTES].find(q => s.length > q.length && s.endsWith(q));
      if (quote) s = `${s.slice(0, -quote.length)}/${quote}`;
      else if (/^[A-Z]{6}$/.test(s)) s = `${s.slice(0, 3)}/${s.slice(3)}`;
    }
    const m = s.match(/^([A-Z0-9]{2,16})\/([A-Z0-9]{2,12})$/);
    if (!m || !COMMON_QUOTES.has(m[2])) return '';
    return `${m[1]}/${m[2]}${otc ? ' (OTC)' : ''}`;
  };

  const assetRegex = /\b(?:[A-Z0-9]{2,16}\s*[\/_-]\s*(?:USDT|USDC|USD|EUR|GBP|JPY|AUD|CAD|CHF|NZD|BRL|BTC|ETH)|[A-Z]{6})(?:\s*\(\s*OTC\s*\)|\s+OTC)?/gi;
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
    const rows = [];

    for (const el of deepElements()) {
      if (!visible(el)) continue;
      const text = textOf(el);
      if (!text || text.length > 110) continue;
      for (const asset of assetsIn(text)) {
        const r = el.getBoundingClientRect();
        const classes = classText(el);
        let score = (counts.get(asset) || 0) * 18;
        if (/true|active|selected|current|checked/i.test(classes)) score += 130;
        if (/\bOTC\b/i.test(text)) score += 55;
        if (r.top >= 0 && r.top < innerHeight * .42) score += 35;
        if (r.left >= 0 && r.left < innerWidth * .7) score += 20;
        if (text.length < 35) score += 18;
        if (/portfolio|historico|histórico|chat|suporte|leader|depositar/i.test(fold(text))) score -= 80;
        rows.push({ asset, score });
      }
    }

    if (!rows.length && counts.size) {
      for (const [asset, count] of counts) rows.push({ asset, score: count * 18 + (/\(OTC\)$/.test(asset) ? 20 : 0) });
    }
    rows.sort((a, b) => b.score - a.score);
    return rows[0] || null;
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
    const re = new RegExp(`(?:${label})[^0-9]{0,24}([0-9]{1,6}[.,][0-9]{3,8})`, 'i');
    return num(page.match(re)?.[1]);
  };

  function tradeButtonPrice() {
    const page = fullText();
    const buyText = firstPriceAfter(page, 'COMPRAR|BUY');
    const sellText = firstPriceAfter(page, 'VENDER|SELL');
    if (buyText != null && sellText != null) return { price: (buyText + sellText) / 2, source: 'buttons', buy: buyText, sell: sellText };
    if (buyText != null || sellText != null) return { price: buyText ?? sellText, source: 'buttons', buy: buyText, sell: sellText };

    const buys = [], sells = [];
    for (const el of deepElements()) {
      if (!visible(el)) continue;
      const text = textOf(el);
      if (!text || text.length > 120) continue;
      const f = fold(text);
      if (!/\b(comprar|buy|vender|sell)\b/.test(f)) continue;
      const values = decimalPrices(text);
      if (!values.length) continue;
      if (/\b(comprar|buy)\b/.test(f)) buys.push(values[values.length - 1]);
      if (/\b(vender|sell)\b/.test(f)) sells.push(values[values.length - 1]);
    }
    if (buys.length && sells.length) return { price: (buys[0] + sells[0]) / 2, source: 'buttons', buy: buys[0], sell: sells[0] };
    if (buys.length || sells.length) return { price: buys[0] ?? sells[0], source: 'buttons', buy: buys[0] ?? null, sell: sells[0] ?? null };
    return null;
  }

  function chartPrice() {
    const values = [];
    for (const el of deepElements()) {
      if (!visible(el)) continue;
      const text = textOf(el);
      if (!text || text.length > 40 || /%|\$|R\$/i.test(text)) continue;
      for (const value of decimalPrices(text)) {
        const r = el.getBoundingClientRect();
        let score = 0;
        if (r.left > innerWidth * .5) score += 25;
        if (r.top > innerHeight * .12 && r.top < innerHeight * .88) score += 18;
        if (/price|quote|rate|current/i.test(classText(el))) score += 35;
        values.push({ value, score });
      }
    }
    values.sort((a, b) => b.score - a.score);
    return values[0] ? { price: values[0].value, source: 'chart' } : null;
  }

  function selectedTimeframe() {
    const rows = [];
    for (const el of deepElements()) {
      if (!visible(el)) continue;
      const text = textOf(el);
      if (!text || text.length > 24) continue;
      const tf = normalizeTf(text);
      if (!tf) continue;
      const r = el.getBoundingClientRect();
      let score = 0;
      if (/true|active|selected|current|checked/i.test(classText(el))) score += 120;
      if (r.left < innerWidth * .35) score += 25;
      if (r.top > innerHeight * .18 && r.top < innerHeight * .9) score += 10;
      rows.push({ tf, score });
    }
    rows.sort((a, b) => b.score - a.score);
    return rows[0]?.tf || null;
  }

  function selectedExpiration() {
    const page = fullText();
    const match = page.match(/(?:EXPIRA(?:ÇÃO|CAO)|EXPIRY|DURATION)\s*[^0-9]{0,40}(\d{1,4})\s*(S|SEG|SEGUNDO|SEGUNDOS|M|MIN|MINUTO|MINUTOS)/i);
    if (match) return normalizeExp(`${match[1]}${match[2]}`);
    for (const el of deepElements()) {
      if (!visible(el)) continue;
      const text = textOf(el);
      if (!text || text.length > 90) continue;
      const context = fold([text, el.parentElement?.innerText, el.getAttribute?.('aria-label'), el.getAttribute?.('data-testid')].filter(Boolean).join(' '));
      if (!/expira|expiry|duration/.test(context)) continue;
      const value = context.match(/\d{1,4}\s*(?:s|seg|segundo|segundos|m|min|minuto|minutos)/i)?.[0];
      const exp = normalizeExp(value);
      if (exp) return exp;
    }
    return null;
  }

  function instrumentType() {
    const page = fold(fullText().slice(0, 20000));
    if (/\bblitz\b/.test(page)) return 'blitz';
    if (/\bbinaria\b|\bbinary\b/.test(page)) return 'binary';
    if (/\bturbo\b/.test(page)) return 'turbo';
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
  })).filter(c => c.asset && c.price != null && c.price > 0 && Date.now() - c.observedAt < 15000);

  function bestNetworkQuote(preferredAsset = '') {
    const wanted = canonicalAsset(preferredAsset);
    const noOtc = wanted.replace(/ \(OTC\)$/, '');
    let rows = networkCandidates();
    if (wanted) {
      const matching = rows.filter(c => c.asset === wanted || c.asset.replace(/ \(OTC\)$/, '') === noOtc);
      if (!matching.length) return null;
      rows = matching;
    }
    rows.sort((a, b) =>
      Number(b.selected === true) - Number(a.selected === true)
      || b.confidence - a.confidence
      || b.seenCount - a.seenCount
      || b.observedAt - a.observedAt
    );
    return rows[0] || null;
  }

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

  function localObservation() {
    const active = scanAsset();
    const buttonQuote = tradeButtonPrice();
    const chartQuote = buttonQuote ? null : chartPrice();
    const quote = buttonQuote || chartQuote;
    return {
      frameId,
      href: location.href,
      at: Date.now(),
      asset: active?.asset || null,
      assetScore: Number(active?.score || 0),
      price: num(quote?.price),
      buy: num(quote?.buy),
      sell: num(quote?.sell),
      priceSource: quote?.source || null,
      timeframe: selectedTimeframe(),
      expiration: selectedExpiration(),
      instrumentType: instrumentType()
    };
  }

  function postObservation(obs) {
    try {
      window.top.postMessage({ source: FRAME_SOURCE, payload: obs }, '*');
    } catch {}
  }

  function recentFrameRows() {
    const now = Date.now();
    for (const [id, row] of frameObservations) {
      if (!row || now - Number(row.at || 0) > 3500) frameObservations.delete(id);
    }
    return [...frameObservations.values()];
  }

  async function emitAggregated() {
    if (!isTop || !platform) return;
    const now = Date.now();
    if (now - lastEmitAt < 180) return;
    lastEmitAt = now;

    const rows = recentFrameRows();
    const assetRows = rows.filter(r => r.asset).sort((a, b) => b.assetScore - a.assetScore || b.at - a.at);
    const explicitFocus = canonicalAsset(globalThis.__ATS_FOCUSED_ASSET_VALUE__ || '');
    const domAsset = explicitFocus || assetRows[0]?.asset || lastAsset || '';
    const net = bestNetworkQuote(domAsset) || (!domAsset ? bestNetworkQuote('') : null);
    const asset = domAsset || net?.asset || null;

    const sameAssetRows = asset
      ? rows.filter(r => r.asset && canonicalAsset(r.asset).replace(/ \(OTC\)$/, '') === canonicalAsset(asset).replace(/ \(OTC\)$/, ''))
      : [];
    const priceRows = (asset ? sameAssetRows : rows)
      .filter((r, i, arr) => r.price != null && arr.indexOf(r) === i)
      .sort((a, b) => Number(b.priceSource === 'buttons') - Number(a.priceSource === 'buttons') || b.at - a.at);

    let price = priceRows[0]?.price ?? net?.price ?? null;
    if (net?.price != null && price != null) {
      const scale = Math.max(Math.abs(net.price), Math.abs(price), 1e-9);
      if (Math.abs(net.price - price) / scale > 0.08) price = net.price;
    }
    if (price == null && net?.price != null) price = net.price;

    const timeframe = rows.map(r => r.timeframe).find(Boolean) || net?.timeframe || 'M1';
    const expiration = rows.map(r => r.expiration).find(Boolean) || net?.expiration || null;
    const type = sameAssetRows.map(r => r.instrumentType).find(x => x && x !== 'unknown')
      || rows.map(r => r.instrumentType).find(x => x && x !== 'unknown')
      || net?.instrumentType
      || 'unknown';

    if (!asset || price == null) return;
    lastAsset = asset;

    const history = historyFor(asset);
    const marketType = /\(OTC\)$/i.test(asset) ? 'otc' : 'regular';
    const candidate = {
      asset,
      price,
      timeframe,
      expiration,
      transport: net?.transport || priceRows[0]?.priceSource || 'dom',
      source: net ? 'network+cross-frame-dom' : 'cross-frame-dom',
      confidence: net ? Math.max(75, Number(net.confidence || 0)) : 78,
      seenCount: Number(net?.seenCount || 1),
      observedAt: Date.now()
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
        capabilities: {
          structuredQuotes: !!net,
          candles: history.length >= 3,
          expiration: !!expiration,
          multiAsset: false
        },
        diagnostics: {
          capture: net ? 'rede-validada+cross-frame-dom' : 'cross-frame-dom-casatrade',
          frameCount: rows.length,
          structuredSource: net?.transport || null,
          networkQuoteMatched: !!net,
          networkConfidence: Number(net?.confidence || 0),
          networkQuality: Number(networkState?.feedQuality || 0),
          candleHistory: history.length,
          host: trustedHost,
          privacy: 'Sem cookies, credenciais, tokens, headers ou saldo.'
        }
      }
    }).catch(() => {});
  }

  async function inspect() {
    if (!platform || running) return;
    running = true;
    try {
      const obs = localObservation();
      if (isTop) {
        frameObservations.set(frameId, obs);
        await emitAggregated();
      } else {
        postObservation(obs);
      }
    } finally {
      running = false;
    }
  }

  const schedule = (delay = 80) => {
    clearTimeout(timer);
    timer = setTimeout(() => inspect().catch(() => {}), delay);
  };

  async function init() {
    const response = await chrome.runtime.sendMessage({ type: 'ATS_GET_PLATFORM_CONFIG', host: trustedHost }).catch(() => null);
    platform = response?.platform || null;
    if (!platform) return;

    if (isTop) {
      window.addEventListener('message', event => {
        if (event.data?.source !== FRAME_SOURCE) return;
        const obs = event.data?.payload;
        if (!obs?.frameId || !Number(obs.at)) return;
        frameObservations.set(obs.frameId, obs);
        emitAggregated().catch(() => {});
      });
    }

    const stored = await chrome.storage.local.get('scannerState').catch(() => ({}));
    networkState = stored.scannerState?.diagnostics?.network || {};
    chrome.storage.onChanged.addListener(changes => {
      if (!changes.scannerState) return;
      networkState = changes.scannerState.newValue?.diagnostics?.network || {};
      schedule(35);
    });

    const start = () => {
      if (!document.documentElement) return setTimeout(start, 50);
      new MutationObserver(() => schedule(55)).observe(document.documentElement, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['class','aria-selected','data-state','value','aria-label']
      });
      inspect();
      setInterval(() => inspect().catch(() => {}), 450);
    };
    start();
  }

  init().catch(() => {});
})();