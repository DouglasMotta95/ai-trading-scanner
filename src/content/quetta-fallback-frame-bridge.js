(() => {
  if (globalThis.__ATS_QUETTA_FALLBACK_FRAME_BRIDGE__) return;
  globalThis.__ATS_QUETTA_FALLBACK_FRAME_BRIDGE__ = true;

  const RELAY_SOURCE = 'ATS_QUETTA_FALLBACK_FRAME_RELAY';
  const ALLOWED_TYPES = new Set([
    'ATS_VISUAL_FOCUS_V2',
    'ATS_MARKET_CLOCK_V2',
    'ATS_EMBEDDED_FEED',
    'ATS_CHART_FRAME_MARKET',
    'ATS_DATA_INSPECTOR',
    'ATS_ACCOUNT_METRICS'
  ]);
  const clean = value => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  const casaHost = value => value === 'casatrade.com' || value.endsWith('.casatrade.com') || value === 'casatrade.io' || value.endsWith('.casatrade.io');
  const traderHost = value => value === 'casatraders.online' || value.endsWith('.casatraders.online') || value === 'ivcasatraders.online' || value.endsWith('.ivcasatraders.online');
  const trustedHost = value => casaHost(value) || traderHost(value);

  function hostFromUrl(value = '') {
    const raw = String(value || '');
    if (!raw) return '';
    try {
      const url = new URL(raw, location.href);
      if (url.hostname) return url.hostname.toLowerCase().replace(/\.$/, '');
      if (url.origin && url.origin !== 'null') {
        const origin = new URL(url.origin);
        if (origin.hostname) return origin.hostname.toLowerCase().replace(/\.$/, '');
      }
    } catch {}
    const blob = raw.match(/^blob:(https?:\/\/[^/]+)/i)?.[1] || '';
    if (blob) {
      try { return new URL(blob).hostname.toLowerCase().replace(/\.$/, ''); } catch {}
    }
    return '';
  }

  const directHost = hostFromUrl(location.href) || String(location.hostname || '').toLowerCase().replace(/\.$/, '');
  const originHost = hostFromUrl(location.origin || '');
  const referrerHost = hostFromUrl(document.referrer || '');
  const effectiveHost = directHost || originHost || referrerHost;
  const fallbackProtocol = ['blob:', 'about:', 'data:'].includes(String(location.protocol || '').toLowerCase());
  const sendMessage = globalThis.__ATS_SEND_MESSAGE__;

  // The normal CasaTrade document is the trusted runtime sender. Child blob/about/data
  // chart documents relay through it because Chrome/Quetta reports those child URLs
  // without a usable hostname even though match_origin_as_fallback injected us there.
  if (window === window.top && trustedHost(directHost) && typeof sendMessage === 'function') {
    window.addEventListener('message', event => {
      const data = event.data;
      if (!data || data.source !== RELAY_SOURCE || data.direction !== 'to-background') return;
      const message = data.message;
      if (!message || !ALLOWED_TYPES.has(String(message.type || ''))) return;
      const origin = hostFromUrl(event.origin || '');
      if (event.origin && event.origin !== 'null' && origin && !trustedHost(origin)) return;
      sendMessage(message).catch(() => null);
    }, true);
  }

  if (!fallbackProtocol || !trustedHost(effectiveHost) || window === window.top) return;

  const frameRole = traderHost(effectiveHost) ? 'trader-frame' : 'casa-chart-frame';
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
  const QUOTES = new Set(['USDT','USDC','USD','EUR','GBP','JPY','AUD','CAD','CHF','NZD','BRL','BTC','ETH']);
  const SENSITIVE = /token|auth|cookie|session|password|secret|bearer|csrf|api[-_]?key|credential|authorization/i;
  const BAD_CLOCK = /hora\s+de\s+compra|purchase\s+time|retorno|return|payout|saldo|balance|valor|amount|lucro|profit/i;

  const post = message => {
    if (!message || !ALLOWED_TYPES.has(String(message.type || ''))) return;
    try {
      window.top.postMessage({ source: RELAY_SOURCE, direction: 'to-background', message }, '*');
    } catch {}
  };

  function canonicalAsset(value = '') {
    const raw = clean(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
    if (!raw || raw.length > 120 || SENSITIVE.test(raw)) return '';
    const otc = /(?:\(|\b|[_-])OTC(?:\)|\b)?/.test(raw);
    const direct = raw.match(/\b([A-Z0-9]{2,20})\s*[\/_-]\s*([A-Z0-9]{2,12})/);
    if (direct && QUOTES.has(direct[2])) return `${direct[1]}/${direct[2]}${otc ? ' (OTC)' : ''}`;
    const stripped = raw.replace(/\(\s*OTC\s*\)|\bOTC\b/g, ' ').replace(/\s+/g, ' ').trim();
    for (const [label, pair] of ALIASES) {
      const pattern = new RegExp(`(^|[^A-Z0-9])${label.replace(/ /g, '\\s+')}([^A-Z0-9]|$)`);
      if (pattern.test(stripped)) return `${pair}${otc ? ' (OTC)' : ''}`;
    }
    const compact = stripped.replace(/\s+/g, '').match(/^([A-Z0-9]{2,16})(USDT|USDC|USD|EUR|GBP|JPY|AUD|CAD|CHF|NZD|BRL|BTC|ETH)$/);
    return compact ? `${compact[1]}/${compact[2]}${otc ? ' (OTC)' : ''}` : '';
  }
  const marketId = value => canonicalAsset(value);
  const sameMarket = (a, b) => !!marketId(a) && marketId(a) === marketId(b);
  const num = value => {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    let text = clean(value).replace(/\s/g, '').replace(/[^\d,.-]/g, '');
    if (!text) return null;
    if (text.includes(',') && text.includes('.')) text = text.lastIndexOf(',') > text.lastIndexOf('.') ? text.replace(/\./g, '').replace(',', '.') : text.replace(/,/g, '');
    else text = text.replace(',', '.');
    const parsed = Number(text);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const normalizeTime = value => {
    let time = num(value);
    if (time == null || time <= 0) return null;
    while (time > 1e14) time /= 1000;
    if (time < 1e11) time *= 1000;
    return Number.isFinite(time) && time > 946684800000 ? Math.round(time) : null;
  };
  const normalizeTf = value => {
    const text = clean(value).toUpperCase().replace(/\s+/g, '');
    let match = text.match(/^S(\d{1,5})$/) || text.match(/^(\d{1,5})(?:S|SEG)$/);
    if (match && Number(match[1]) > 0) return `S${Number(match[1])}`;
    match = text.match(/^M(\d{1,4})$/) || text.match(/^(\d{1,4})(?:M|MIN)$/);
    if (match && Number(match[1]) > 0) return `M${Number(match[1])}`;
    match = text.match(/^H(\d{1,3})$/) || text.match(/^(\d{1,3})H$/);
    return match && Number(match[1]) > 0 ? `H${Number(match[1])}` : null;
  };
  const durationSeconds = timeframe => {
    const tf = normalizeTf(timeframe);
    if (!tf) return null;
    if (tf[0] === 'S') return Number(tf.slice(1));
    if (tf[0] === 'M') return Number(tf.slice(1)) * 60;
    if (tf[0] === 'H') return Number(tf.slice(1)) * 3600;
    return null;
  };
  const visible = element => {
    if (!element || !(element instanceof Element)) return false;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0;
  };

  let elements = [];
  let elementsAt = 0;
  function deepElements(limit = 6000) {
    const now = Date.now();
    if (elements.length && now - elementsAt < 500) return elements.slice(0, limit);
    const out = [];
    const roots = [document];
    const seen = new Set();
    while (roots.length && out.length < 6500) {
      const root = roots.shift();
      if (!root || seen.has(root)) continue;
      seen.add(root);
      let rows = [];
      try { rows = [...root.querySelectorAll('*')]; } catch {}
      for (const row of rows) {
        out.push(row);
        if (out.length >= 6500) break;
        if (row.shadowRoot) roots.push(row.shadowRoot);
      }
    }
    elements = out;
    elementsAt = now;
    return out.slice(0, limit);
  }
  const metaText = element => clean([
    element?.getAttribute?.('aria-label'), element?.getAttribute?.('aria-valuetext'), element?.getAttribute?.('title'),
    element?.getAttribute?.('data-symbol'), element?.getAttribute?.('data-asset'), element?.getAttribute?.('data-instrument'),
    element?.getAttribute?.('data-testid'), element?.innerText, element?.textContent
  ].filter(Boolean).join(' ')).slice(0, 180);
  const contextOf = element => {
    const parts = [];
    let node = element;
    for (let depth = 0; node && depth < 4; depth += 1, node = node.parentElement) {
      parts.push(String(node.id || ''), String(node.className || ''), node.getAttribute?.('role') || '', node.getAttribute?.('data-testid') || '', node.getAttribute?.('aria-label') || '');
    }
    return parts.join(' ').toLowerCase();
  };
  const selected = element => {
    let node = element;
    for (let depth = 0; node && depth < 3; depth += 1, node = node.parentElement) {
      const flags = `${node.getAttribute?.('aria-selected') || ''} ${node.getAttribute?.('aria-current') || ''} ${node.getAttribute?.('data-state') || ''} ${node.getAttribute?.('data-active') || ''} ${node.className || ''}`;
      if (/true|active|selected|current|checked/i.test(flags)) return true;
    }
    return false;
  };

  let focusAsset = '';
  let focusAt = 0;
  let recentInteraction = { asset: '', at: 0 };
  function publishFocus(asset, source = 'fallback-frame-dom', score = 1200) {
    const normalized = canonicalAsset(asset);
    if (!normalized) return;
    const now = Date.now();
    if (sameMarket(focusAsset, normalized) && now - focusAt < 550) return;
    focusAsset = normalized;
    focusAt = now;
    globalThis.__ATS_FOCUSED_ASSET_VALUE__ = normalized;
    post({
      type: 'ATS_VISUAL_FOCUS_V2', asset: normalized, score, samples: 3,
      reliable: true, visual: true, explicit: true,
      interactionHint: source === 'fallback-frame-user', interactionAt: source === 'fallback-frame-user' ? now : null,
      chartScoped: true, chartFound: true, frameHost: effectiveHost, frameRole, source, at: now
    });
  }

  function scanFocus() {
    const rows = [];
    let seen = 0;
    for (const element of deepElements()) {
      if (++seen > 5500 || !visible(element)) continue;
      const text = metaText(element);
      if (!text) continue;
      const asset = canonicalAsset(text);
      if (!asset) continue;
      const context = contextOf(element);
      const strong = /chart|header|asset|ativo|instrument|symbol|market|selected|current/.test(context);
      const isSelected = selected(element);
      const interacted = sameMarket(recentInteraction.asset, asset) && Date.now() - recentInteraction.at < 4000;
      if (!strong && !isSelected && !interacted) continue;
      let score = strong ? 520 : 0;
      if (isSelected) score += 560;
      if (interacted) score += 1000;
      if (text.length <= 32) score += 90;
      rows.push({ asset, score, interacted });
    }
    rows.sort((a, b) => Number(b.interacted) - Number(a.interacted) || b.score - a.score);
    const first = rows[0];
    const second = rows[1];
    if (!first) return;
    if (second && !sameMarket(first.asset, second.asset) && first.score - second.score < 180 && !first.interacted) return;
    publishFocus(first.asset, first.interacted ? 'fallback-frame-user' : 'fallback-frame-dom', first.score);
  }

  function assetFromEvent(event) {
    const path = typeof event?.composedPath === 'function' ? event.composedPath() : [event?.target];
    for (const node of path.slice(0, 10)) {
      if (!(node instanceof Element) || !visible(node)) continue;
      const asset = canonicalAsset(metaText(node));
      if (asset) return asset;
    }
    return '';
  }
  const noteInteraction = event => {
    const asset = assetFromEvent(event);
    if (asset) {
      recentInteraction = { asset, at: Date.now() };
      publishFocus(asset, 'fallback-frame-user', 1900);
    }
    elementsAt = 0;
    setTimeout(scanFocus, 100);
  };
  document.addEventListener('pointerup', noteInteraction, true);
  document.addEventListener('touchend', noteInteraction, true);
  document.addEventListener('click', noteInteraction, true);

  function selectedTimeframe() {
    const rows = [];
    for (const element of deepElements(3500)) {
      if (!visible(element)) continue;
      const text = clean(element.textContent || element.innerText || element.getAttribute?.('aria-label') || '');
      if (!text || text.length > 30) continue;
      const tf = normalizeTf(text);
      if (!tf) continue;
      const context = contextOf(element);
      let score = selected(element) ? 100 : 0;
      if (/timeframe|period|candle|vela|chart/.test(context)) score += 70;
      if (/expira|expiry|duration/.test(context)) score -= 80;
      rows.push({ tf, score });
    }
    rows.sort((a, b) => b.score - a.score);
    return rows[0]?.tf || null;
  }

  function scanDomClock() {
    if (!focusAsset) return;
    const timeframe = selectedTimeframe() || 'M1';
    const duration = durationSeconds(timeframe) || 60;
    const rows = [];
    for (const element of deepElements(4500)) {
      if (!visible(element)) continue;
      const text = clean(element.textContent || element.innerText || element.getAttribute?.('aria-label') || '');
      if (!text || text.length > 90 || BAD_CLOCK.test(text)) continue;
      const context = `${contextOf(element)} ${text}`.toLowerCase();
      let seconds = null;
      const mmss = text.match(/\b(\d{1,2}):(\d{2})\b/);
      if (mmss) seconds = Number(mmss[1]) * 60 + Number(mmss[2]);
      if (seconds == null && /expira|expiry|countdown|timer|tempo|candle|vela/.test(context)) {
        const single = text.match(/\b(\d{1,4})\s*(?:s|seg|segundo|segundos)\b/i);
        if (single) seconds = Number(single[1]);
      }
      if (!Number.isFinite(seconds) || seconds <= 0 || seconds > duration) continue;
      let score = /expira|expiry|countdown|timer/.test(context) ? 100 : 45;
      if (/chart|candle|vela/.test(context)) score += 45;
      rows.push({ seconds, text, score });
    }
    rows.sort((a, b) => b.score - a.score);
    const best = rows[0];
    if (!best || best.score < 70) return;
    post({
      type: 'ATS_MARKET_CLOCK_V2', asset: focusAsset, timeframe,
      secondsRemaining: best.seconds, expiration: null, available: true, verified: true,
      clockRole: 'candle-close', clockSource: 'trader-dom-countdown', clockMode: 'fallback-frame-dom-exact',
      clockText: best.text, clockToken: `${best.seconds}s`, confidence: 92, frameHost: effectiveHost, at: Date.now()
    });
  }

  function scanDomPrice() {
    if (!focusAsset) return;
    const rows = [];
    for (const element of deepElements(4000)) {
      if (!visible(element)) continue;
      const text = clean(element.textContent || element.innerText || element.getAttribute?.('aria-valuetext') || '');
      if (!text || text.length > 70) continue;
      const context = `${contextOf(element)} ${element.getAttribute?.('aria-label') || ''}`.toLowerCase();
      if (/saldo|balance|valor|amount|retorno|return|payout|lucro|profit|expira|expiry|timer|countdown|%/.test(context)) continue;
      if (!/price|quote|rate|cotacao|cotação|preco|preço|current|last|bid|ask|chart/.test(context)) continue;
      const token = text.match(/\b\d{1,9}[.,]\d{2,10}\b/)?.[0];
      const value = num(token);
      if (value == null || value <= 0) continue;
      let score = /price|quote|rate|cotacao|cotação|preco|preço|current|last/.test(context) ? 110 : 50;
      if (/chart/.test(context)) score += 35;
      rows.push({ value, score });
    }
    rows.sort((a, b) => b.score - a.score);
    if (!rows[0] || rows[0].score < 80) return;
    post({ type: 'ATS_CHART_FRAME_MARKET', asset: focusAsset, price: rows[0].value, priceSource: 'fallback-frame-dom-price', confidence: 88, frameHost: effectiveHost, at: Date.now() });
  }

  const BALANCE_RE = /\b(saldo|balance|banca|conta\s+real|real\s+account|wallet|funds|equity)\b/i;
  const STAKE_RE = /\b(valor|amount|invest|investimento|investment|stake|entrada|aposta)\b/i;
  const PAYOUT_RE = /\b(payout|retorno|rendimento|return|lucro|profit)\b/i;
  function firstPositiveAfter(labelRe, percent = false) {
    for (const element of deepElements(4500)) {
      if (!visible(element)) continue;
      const text = clean(element.textContent || element.innerText || '');
      if (!text || text.length > 180 || !labelRe.test(text)) continue;
      if (percent) {
        const hit = text.match(/(\d{1,3}(?:[.,]\d+)?)\s*%/);
        const value = num(hit?.[1]);
        if (value != null && value > 0 && value <= 100) return { value, score: 12 };
      } else {
        const label = text.match(labelRe);
        const after = label ? text.slice((label.index || 0) + label[0].length) : text;
        const hit = after.match(/(?:R\$|US\$|\$|€|£)?\s*\d[\d.,\s]*/);
        const value = num(hit?.[0]);
        if (value != null && value > 0 && value <= 1e9) return { value, score: 11, currency: /R\$/.test(hit[0]) ? 'BRL' : /€/.test(hit[0]) ? 'EUR' : /£/.test(hit[0]) ? 'GBP' : /\$/.test(hit[0]) ? 'USD' : null };
      }
    }
    return null;
  }
  let lastMetricsKey = '';
  function scanMetrics() {
    const balance = firstPositiveAfter(BALANCE_RE, false);
    const stake = firstPositiveAfter(STAKE_RE, false);
    const payout = firstPositiveAfter(PAYOUT_RE, true);
    if (!balance && !stake && !payout) return;
    const key = JSON.stringify([balance?.value ?? null, stake?.value ?? null, payout?.value ?? null]);
    if (key === lastMetricsKey) return;
    lastMetricsKey = key;
    post({
      type: 'ATS_ACCOUNT_METRICS',
      snapshot: {
        balance: balance?.value ?? null, stake: stake?.value ?? null, payoutPct: payout?.value ?? null,
        currency: balance?.currency || stake?.currency || null,
        confidence: { balance: balance?.score || 0, stake: stake?.score || 0, payout: payout?.score || 0 },
        source: 'quetta-fallback-frame-dom', observedAt: Date.now()
      }
    });
  }

  let clockProbe = null;
  let lastFeedAt = 0;
  function publishNetworkClock(candidate, timeframe) {
    const serverTime = normalizeTime(candidate?.timestamp);
    const tf = normalizeTf(timeframe || candidate?.timeframe || selectedTimeframe());
    const duration = durationSeconds(tf);
    const now = Date.now();
    if (!serverTime || !tf || !duration || Math.abs(now - serverTime) > 7000) { clockProbe = null; return; }
    const previous = clockProbe;
    const serverDelta = previous ? serverTime - previous.serverTime : 0;
    const localDelta = previous ? now - previous.observedAt : 0;
    const progressed = previous && sameMarket(previous.asset, focusAsset) && previous.timeframe === tf
      && serverDelta > 0 && serverDelta <= 5000 && localDelta > 0 && localDelta <= 5000 && Math.abs(serverDelta - localDelta) <= 1800;
    const count = progressed ? Math.min(8, previous.count + 1) : 1;
    clockProbe = { asset: focusAsset, timeframe: tf, serverTime, observedAt: now, count };
    if (count < 2) return;
    const durationMs = duration * 1000;
    const elapsed = ((serverTime % durationMs) + durationMs) % durationMs;
    let remaining = Math.ceil((durationMs - elapsed) / 1000);
    if (!Number.isFinite(remaining) || remaining <= 0 || remaining > duration) remaining = duration;
    post({
      type: 'ATS_MARKET_CLOCK_V2', asset: focusAsset, timeframe: tf, secondsRemaining: remaining,
      expiration: candidate?.expiration || null, available: true, verified: true,
      clockRole: 'candle-close', clockSource: 'network-server-cycle', clockMode: 'fallback-frame-structured-server-time',
      clockText: 'Tempo do servidor confirmado no frame interno', clockToken: `${remaining}s`, confidence: Math.max(90, Number(candidate?.confidence || 0)), frameHost: effectiveHost, at: now
    });
  }

  function safeInspector(payload, candidate) {
    const recent = payload?.recentCandles && typeof payload.recentCandles === 'object' ? payload.recentCandles : {};
    const historyKey = focusAsset ? Object.keys(recent).find(key => sameMarket(key, focusAsset)) : null;
    const candleCount = historyKey && Array.isArray(recent[historyKey]) ? recent[historyKey].length : 0;
    const keys = (Array.isArray(payload?.keys) ? payload.keys : []).map(clean).filter(key => key && !SENSITIVE.test(key)).slice(0, 80);
    const endpoints = (Array.isArray(payload?.endpoints) ? payload.endpoints : []).map(clean).filter(Boolean).slice(-12);
    const tradeRe = /trade|order|position|deal|result|outcome|payout|profit|win|loss|settle|closed|expiry|expiration/i;
    return {
      transports: { messages: payload?.messages || {}, connections: payload?.connections || {}, primary: payload?.primaryTransport || null },
      endpoints, keys,
      tradeEvidence: { detected: keys.some(key => tradeRe.test(key)) || endpoints.some(endpoint => tradeRe.test(endpoint)), keys: keys.filter(key => tradeRe.test(key)).slice(0, 30), endpoints: endpoints.filter(endpoint => tradeRe.test(endpoint)).slice(-12), observedAt: Date.now() },
      rawCandidateCount: Array.isArray(payload?.candidates) ? payload.candidates.length : 0,
      candleCount,
      focusedCandidate: candidate ? {
        asset: canonicalAsset(candidate.asset), price: num(candidate.price), bid: num(candidate.bid), ask: num(candidate.ask),
        timeframe: clean(candidate.timeframe || ''), expiration: clean(candidate.expiration || ''), timestamp: normalizeTime(candidate.timestamp),
        transport: clean(candidate.transport || payload?.primaryTransport || ''), confidence: Number(candidate.confidence || 0), selected: candidate.selected === true
      } : null
    };
  }

  window.addEventListener('message', event => {
    const data = event.data;
    if (!data || data.source !== 'ATS_NETWORK_PROBE' || data.type !== 'summary') return;
    const payload = data.payload || {};
    const candidates = (Array.isArray(payload.candidates) ? payload.candidates : [])
      .map(row => ({ ...row, asset: canonicalAsset(row?.asset) }))
      .filter(row => row.asset);

    if (!focusAsset) {
      const selectedRows = candidates.filter(row => row.selected === true);
      const unique = [...new Map(selectedRows.map(row => [marketId(row.asset), row])).values()];
      if (unique.length === 1) publishFocus(unique[0].asset, 'fallback-frame-protocol', Math.max(1500, Number(unique[0].confidence || 0) * 10));
    }
    if (!focusAsset) return;

    const matching = candidates.filter(row => sameMarket(row.asset, focusAsset)).sort((a, b) => Number(b.selected === true) - Number(a.selected === true) || Number(b.confidence || 0) - Number(a.confidence || 0) || Number(b.observedAt || 0) - Number(a.observedAt || 0));
    const candidate = matching[0] || null;
    post({ type: 'ATS_DATA_INSPECTOR', snapshot: safeInspector(payload, candidate) });
    if (!candidate) return;

    const now = Date.now();
    if (now - lastFeedAt >= 70) {
      lastFeedAt = now;
      post({ type: 'ATS_EMBEDDED_FEED', payload });
    }
    const price = num(candidate.price) ?? (num(candidate.bid) != null && num(candidate.ask) != null ? (num(candidate.bid) + num(candidate.ask)) / 2 : null);
    if (price != null && price > 0) post({ type: 'ATS_CHART_FRAME_MARKET', asset: focusAsset, price, priceSource: `fallback-${candidate.transport || payload.primaryTransport || 'network'}`, confidence: Math.max(80, Number(candidate.confidence || 0)), frameHost: effectiveHost, at: now });
    publishNetworkClock(candidate, candidate.timeframe);
  }, true);

  new MutationObserver(() => { elementsAt = 0; }).observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });
  setInterval(() => {
    scanFocus();
    scanDomPrice();
    scanDomClock();
    scanMetrics();
  }, 800);
  setTimeout(() => {
    scanFocus();
    scanDomPrice();
    scanDomClock();
    scanMetrics();
  }, 180);
})();
