(() => {
  if (globalThis.__ATS_OPAQUE_FRAME_RECOVERY__) return;
  globalThis.__ATS_OPAQUE_FRAME_RECOVERY__ = true;

  const protocol = String(location.protocol || '').toLowerCase();
  const host = String(location.hostname || '').toLowerCase().replace(/\.$/, '');
  const opaque = !host || ['blob:', 'about:', 'data:'].includes(protocol);
  if (!opaque || window === window.top) return;
  const sendMessage = globalThis.__ATS_SEND_MESSAGE__;
  if (typeof sendMessage !== 'function') return;

  const clean = value => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  const fold = value => clean(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
  const QUOTES = new Set(['USDT','USDC','USD','EUR','GBP','JPY','AUD','CAD','CHF','NZD','BRL','BTC','ETH']);
  const ALIASES = new Map([
    ['TRON','TRX/USD'],['TRX','TRX/USD'],['EURO','EUR/USD'],['EUR','EUR/USD'],
    ['BITCOIN','BTC/USD'],['BTC','BTC/USD'],['ETHEREUM','ETH/USD'],['ETH','ETH/USD'],
    ['RIPPLE','XRP/USD'],['XRP','XRP/USD'],['SOLANA','SOL/USD'],['SOL','SOL/USD'],
    ['CARDANO','ADA/USD'],['ADA','ADA/USD'],['DOGECOIN','DOGE/USD'],['DOGE','DOGE/USD'],
    ['SHIBA INU','SHIB/USD'],['SHIB','SHIB/USD'],['LITECOIN','LTC/USD'],['LTC','LTC/USD'],
    ['CHAINLINK','LINK/USD'],['LINK','LINK/USD'],['AVALANCHE','AVAX/USD'],['AVAX','AVAX/USD'],
    ['POLKADOT','DOT/USD'],['DOT','DOT/USD']
  ]);
  const SENSITIVE = /token|auth|cookie|session|password|secret|bearer|csrf|api[-_]?key|credential|authorization/i;

  function assetFrom(value = '') {
    const raw = fold(value);
    if (!raw || raw.length > 160 || SENSITIVE.test(raw)) return '';
    const otc = /(?:\(|\b|[_-])OTC(?:\)|\b)?/.test(raw);
    const direct = raw.match(/\b([A-Z0-9]{2,20})\s*[\/_-]\s*([A-Z0-9]{2,12})/);
    if (direct && QUOTES.has(direct[2])) return `${direct[1]}/${direct[2]}${otc ? ' (OTC)' : ''}`;
    const stripped = raw.replace(/\(\s*OTC\s*\)|\bOTC\b/g, ' ').replace(/\s+/g, ' ').trim();
    for (const [label, pair] of ALIASES) {
      const re = new RegExp(`(^|[^A-Z0-9])${label.replace(/ /g, '\\s+')}([^A-Z0-9]|$)`);
      if (re.test(stripped)) return `${pair}${otc ? ' (OTC)' : ''}`;
    }
    const compact = stripped.replace(/\s+/g, '').match(/^([A-Z0-9]{2,16})(USDT|USDC|USD|EUR|GBP|JPY|AUD|CAD|CHF|NZD|BRL|BTC|ETH)$/);
    return compact ? `${compact[1]}/${compact[2]}${otc ? ' (OTC)' : ''}` : '';
  }

  const normAsset = value => assetFrom(value);
  const sameAsset = (a, b) => !!normAsset(a) && normAsset(a) === normAsset(b);
  const num = value => {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    let text = clean(value).replace(/[^\d,.-]/g, '');
    if (!text) return null;
    if (text.includes(',') && text.includes('.')) text = text.lastIndexOf(',') > text.lastIndexOf('.') ? text.replace(/\./g, '').replace(',', '.') : text.replace(/,/g, '');
    else text = text.replace(',', '.');
    const n = Number(text);
    return Number.isFinite(n) ? n : null;
  };
  const tf = value => {
    const s = fold(value).replace(/\s+/g, '');
    let m = s.match(/^M(\d{1,4})$/) || s.match(/^(\d{1,4})(?:M|MIN)$/); if (m && Number(m[1]) > 0) return `M${Number(m[1])}`;
    m = s.match(/^S(\d{1,5})$/) || s.match(/^(\d{1,5})(?:S|SEG)$/); if (m && Number(m[1]) > 0) return `S${Number(m[1])}`;
    m = s.match(/^H(\d{1,3})$/) || s.match(/^(\d{1,3})H$/); return m && Number(m[1]) > 0 ? `H${Number(m[1])}` : null;
  };
  const tfSeconds = value => { const x = tf(value); return !x ? null : x[0] === 'S' ? Number(x.slice(1)) : x[0] === 'M' ? Number(x.slice(1)) * 60 : Number(x.slice(1)) * 3600; };
  const normalizeTime = value => { let t = num(value); if (t == null || t <= 0) return null; while (t > 1e14) t /= 1000; if (t < 1e11) t *= 1000; return t > 946684800000 ? Math.round(t) : null; };

  const visible = el => {
    if (!el || !(el instanceof Element)) return false;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity || 1) > 0;
  };
  let cache = [], cacheAt = 0;
  function elements(limit = 6500) {
    const now = Date.now();
    if (cache.length && now - cacheAt < 400) return cache.slice(0, limit);
    const out = [], roots = [document], seen = new Set();
    while (roots.length && out.length < 7000) {
      const root = roots.shift();
      if (!root || seen.has(root)) continue;
      seen.add(root);
      let rows = [];
      try { rows = [...root.querySelectorAll('*')]; } catch {}
      for (const el of rows) { out.push(el); if (out.length >= 7000) break; if (el.shadowRoot) roots.push(el.shadowRoot); }
    }
    cache = out; cacheAt = now; return out.slice(0, limit);
  }
  const meta = el => clean([el?.getAttribute?.('aria-label'), el?.getAttribute?.('title'), el?.getAttribute?.('data-symbol'), el?.getAttribute?.('data-asset'), el?.getAttribute?.('data-instrument'), el?.getAttribute?.('data-testid'), el?.innerText, el?.textContent].filter(Boolean).join(' ')).slice(0, 160);
  const context = el => {
    const parts = [];
    let node = el;
    for (let i = 0; node && i < 4; i += 1, node = node.parentElement) parts.push(node.id || '', node.className || '', node.getAttribute?.('role') || '', node.getAttribute?.('data-testid') || '', node.getAttribute?.('aria-label') || '');
    return parts.join(' ').toLowerCase();
  };
  function chartRect() {
    const rows = [];
    for (const el of elements(4500)) {
      if (!visible(el)) continue;
      const tag = String(el.tagName || '').toLowerCase();
      const ctx = `${el.id || ''} ${el.className || ''} ${el.getAttribute?.('data-testid') || ''}`.toLowerCase();
      if (tag !== 'canvas' && tag !== 'svg' && !/chart|candle|graph|tradingview|plot/.test(ctx)) continue;
      const r = el.getBoundingClientRect();
      if (r.width >= 160 && r.height >= 100) rows.push({ r, score: r.width * r.height * (tag === 'canvas' ? 1.8 : 1) });
    }
    rows.sort((a, b) => b.score - a.score);
    return rows[0]?.r || null;
  }
  const near = (r, chart) => !!chart && r.right >= chart.left - Math.max(100, chart.width * .25) && r.left <= chart.right + Math.max(100, chart.width * .25) && r.bottom >= Math.max(0, chart.top - 180) && r.top <= chart.top + Math.min(180, chart.height * .3);

  let focus = '', focusAt = 0;
  function scanAsset() {
    const chart = chartRect();
    const rows = [];
    for (const el of elements()) {
      if (!visible(el)) continue;
      const text = meta(el);
      const asset = assetFrom(text);
      if (!asset) continue;
      const r = el.getBoundingClientRect();
      const ctx = context(el);
      const selected = /true|active|selected|current|checked/i.test(`${el.getAttribute?.('aria-selected') || ''} ${el.getAttribute?.('aria-current') || ''} ${el.getAttribute?.('data-state') || ''} ${el.getAttribute?.('data-active') || ''} ${el.className || ''}`);
      const chartScoped = near(r, chart) || /chart|header|instrument|symbol|asset|ativo|market/.test(ctx);
      const listOnly = /watchlist|asset-list|instrument-list|listbox|search|modal|drawer|dropdown|menu/.test(ctx) && !chartScoped;
      if (listOnly || !chartScoped) continue;
      let score = 400 + (selected ? 600 : 0) + (near(r, chart) ? 450 : 0) + (text.length <= 32 ? 90 : 0);
      rows.push({ asset, score });
    }
    rows.sort((a, b) => b.score - a.score);
    if (!rows[0]) return '';
    if (rows[1] && rows[1].asset !== rows[0].asset && rows[0].score - rows[1].score < 180) return '';
    return rows[0].asset;
  }

  async function proxy(payload) {
    if (!payload?.type) return null;
    return sendMessage({ type: 'ATS_OPAQUE_FRAME_PROXY', payload }).catch(() => null);
  }
  async function publishFocus(force = false) {
    const asset = scanAsset();
    if (!asset) return;
    const now = Date.now();
    if (!force && asset === focus && now - focusAt < 700) return;
    focus = asset; focusAt = now;
    await proxy({ type: 'ATS_VISUAL_FOCUS_V2', asset, score: 1800, samples: 3, reliable: true, visual: true, explicit: true, chartScoped: true, chartFound: true, frameRole: 'casa-chart-frame', source: 'opaque-frame-recovery', at: now });
  }

  function priceFromDom() {
    const chart = chartRect();
    if (!chart) return null;
    let best = null;
    for (const el of elements(5000)) {
      if (!visible(el)) continue;
      const r = el.getBoundingClientRect();
      if (!near(r, chart)) continue;
      const text = clean(el.getAttribute?.('aria-valuetext') || el.getAttribute?.('aria-label') || el.innerText || el.textContent || '');
      if (!text || text.length > 100) continue;
      const ctx = `${text} ${context(el)}`.toLowerCase();
      if (/saldo|balance|valor|amount|payout|retorno|profit|expira|timer|%/.test(ctx)) continue;
      if (!/price|quote|rate|cotacao|cotação|preco|preço|current|last|bid|ask|comprar|vender|buy|sell/.test(ctx)) continue;
      const matches = [...text.matchAll(/\b\d{1,8}[.,]\d{2,10}\b/g)].map(m => num(m[0])).filter(v => v != null && v > 0);
      if (!matches.length) continue;
      const score = /price|quote|rate|cotacao|cotação|preco|preço|current|last/.test(ctx) ? 100 : 70;
      if (!best || score > best.score) best = { price: matches[0], score };
    }
    return best;
  }

  function selectedTimeframe() {
    let best = null;
    for (const el of elements(4500)) {
      if (!visible(el)) continue;
      const text = clean(el.innerText || el.textContent || el.getAttribute?.('aria-label') || '');
      if (!text || text.length > 24) continue;
      const value = tf(text);
      if (!value) continue;
      const selected = /true|active|selected|current|checked/i.test(`${el.getAttribute?.('aria-selected') || ''} ${el.getAttribute?.('aria-current') || ''} ${el.getAttribute?.('data-state') || ''} ${el.className || ''}`);
      const ctx = context(el);
      let score = (selected ? 100 : 0) + (/timeframe|candle|vela|period/.test(ctx) ? 45 : 0);
      if (!best || score > best.score) best = { value, score };
    }
    return best?.value || null;
  }

  function domCountdown(timeframe) {
    const duration = tfSeconds(timeframe) || 60;
    const chart = chartRect();
    let best = null;
    for (const el of elements(5000)) {
      if (!visible(el)) continue;
      const text = clean(el.innerText || el.textContent || el.getAttribute?.('aria-label') || '');
      if (!text || text.length > 40) continue;
      const ctx = `${text} ${context(el)}`.toLowerCase();
      if (/hora de compra|purchase time|retorno|payout|saldo|balance|valor|amount/.test(ctx)) continue;
      let seconds = null;
      let m = text.match(/^(\d{1,2}):(\d{2})$/);
      if (m) seconds = Number(m[1]) * 60 + Number(m[2]);
      else { m = text.match(/^(\d{1,4})\s*s$/i); if (m) seconds = Number(m[1]); }
      if (!Number.isFinite(seconds) || seconds < 0 || seconds > duration) continue;
      const r = el.getBoundingClientRect();
      const chartScoped = near(r, chart) || /chart|candle|vela|expiry|expira|countdown|timer/.test(ctx);
      if (!chartScoped) continue;
      let score = near(r, chart) ? 100 : 50;
      if (/expiry|expira|countdown|timer|candle|vela/.test(ctx)) score += 60;
      if (!best || score > best.score) best = { seconds, text, score };
    }
    return best;
  }

  function scanMetrics() {
    let balance = null, stake = null, payoutPct = null, currency = null;
    const currencyFrom = text => /R\$/i.test(text) ? 'BRL' : /€/.test(text) ? 'EUR' : /£/.test(text) ? 'GBP' : /\$/.test(text) ? 'USD' : null;
    for (const el of elements(3500)) {
      if (!visible(el)) continue;
      const text = clean(el.innerText || el.textContent || el.getAttribute?.('aria-label') || '');
      if (!text || text.length > 140) continue;
      const low = text.toLowerCase();
      const money = text.match(/(?:R\$|US\$|\$|€|£)?\s*\d[\d.,\s]*/)?.[0];
      const value = num(money);
      if (value != null && value > 0) {
        if (balance == null && /saldo|balance|banca|conta real|real account|wallet|funds|equity/.test(low)) { balance = value; currency = currencyFrom(text) || currency; }
        if (stake == null && /valor|amount|invest|investimento|stake|entrada|aposta/.test(low)) { stake = value; currency = currencyFrom(text) || currency; }
      }
      const pct = text.match(/(\d{1,3}(?:[.,]\d+)?)\s*%/);
      const p = pct ? num(pct[1]) : null;
      if (payoutPct == null && p != null && p > 0 && p <= 100 && /payout|retorno|rendimento|return|lucro|profit/.test(low)) payoutPct = p;
    }
    return { balance, stake, payoutPct, currency };
  }

  let clockProbe = null;
  async function relaySummary(payload = {}) {
    await publishFocus(false);
    if (!focus) return;
    await proxy({ type: 'ATS_EMBEDDED_FEED', payload });

    const rows = (Array.isArray(payload.candidates) ? payload.candidates : []).filter(row => sameAsset(row?.asset, focus));
    rows.sort((a, b) => Number(b?.selected === true) - Number(a?.selected === true) || Number(b?.confidence || 0) - Number(a?.confidence || 0) || Number(b?.observedAt || 0) - Number(a?.observedAt || 0));
    const candidate = rows[0] || null;
    const recent = payload.recentCandles && typeof payload.recentCandles === 'object' ? payload.recentCandles : {};
    const historyKey = Object.keys(recent).find(key => sameAsset(key, focus));
    const candleCount = historyKey && Array.isArray(recent[historyKey]) ? recent[historyKey].length : 0;
    await proxy({ type: 'ATS_DATA_INSPECTOR', snapshot: { transports: { messages: payload.messages || {}, connections: payload.connections || {}, primary: payload.primaryTransport || null }, endpoints: Array.isArray(payload.endpoints) ? payload.endpoints.slice(-12) : [], keys: Array.isArray(payload.keys) ? payload.keys.filter(key => !SENSITIVE.test(String(key))).slice(0, 80) : [], rawCandidateCount: Array.isArray(payload.candidates) ? payload.candidates.length : 0, candleCount, focusedCandidate: candidate || null } });

    const serverTime = normalizeTime(candidate?.timestamp);
    const timeframe = tf(candidate?.timeframe) || selectedTimeframe();
    const duration = tfSeconds(timeframe);
    const now = Date.now();
    if (serverTime && timeframe && duration && Math.abs(now - serverTime) <= 7000) {
      const prev = clockProbe;
      const progressed = prev && sameAsset(prev.asset, focus) && prev.timeframe === timeframe && serverTime > prev.serverTime && serverTime - prev.serverTime <= 5000 && now - prev.observedAt <= 5000;
      clockProbe = { asset: focus, timeframe, serverTime, observedAt: now, count: progressed ? Math.min(8, Number(prev.count || 1) + 1) : 1 };
      if (clockProbe.count >= 2) {
        const durationMs = duration * 1000;
        const elapsed = ((serverTime % durationMs) + durationMs) % durationMs;
        let remaining = Math.ceil((durationMs - elapsed) / 1000);
        if (remaining <= 0 || remaining > duration) remaining = duration;
        await proxy({ type: 'ATS_MARKET_CLOCK_V2', asset: focus, timeframe, secondsRemaining: remaining, available: true, verified: true, clockRole: 'candle-close', clockSource: 'network-server-cycle', clockMode: 'opaque-frame-server-time', clockText: 'Servidor confirmado no frame interno', clockToken: `${remaining}s`, confidence: Math.max(60, Number(candidate?.confidence || 0)), at: now });
      }
    }
  }

  window.addEventListener('message', event => {
    const data = event.data;
    if (!data || data.source !== 'ATS_NETWORK_PROBE' || data.type !== 'summary') return;
    relaySummary(data.payload || {}).catch(() => {});
  });

  const note = () => { cacheAt = 0; setTimeout(() => publishFocus(true).catch(() => {}), 80); };
  document.addEventListener('pointerup', note, true);
  document.addEventListener('touchend', note, true);
  document.addEventListener('click', note, true);
  new MutationObserver(() => { cacheAt = 0; }).observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });

  let lastPrice = null;
  setInterval(() => {
    publishFocus(false).catch(() => {});
    if (!focus) return;
    const timeframe = selectedTimeframe() || 'M1';
    const countdown = domCountdown(timeframe);
    if (countdown) proxy({ type: 'ATS_MARKET_CLOCK_V2', asset: focus, timeframe, secondsRemaining: countdown.seconds, available: true, verified: true, clockRole: 'candle-close', clockSource: 'trader-dom-countdown', clockMode: 'opaque-frame-dom-exact', clockText: countdown.text, clockToken: `${countdown.seconds}s`, confidence: 96, at: Date.now() }).catch(() => {});
    const quote = priceFromDom();
    if (quote?.price && quote.price !== lastPrice) { lastPrice = quote.price; proxy({ type: 'ATS_CHART_FRAME_MARKET', asset: focus, price: quote.price, priceSource: 'opaque-frame-chart-price', confidence: 90, at: Date.now() }).catch(() => {}); }
  }, 700);

  setInterval(() => {
    const metrics = scanMetrics();
    if (metrics.balance != null || metrics.stake != null || metrics.payoutPct != null) proxy({ type: 'ATS_ACCOUNT_METRICS', snapshot: { ...metrics, confidence: { balance: metrics.balance != null ? 12 : 0, stake: metrics.stake != null ? 12 : 0, payout: metrics.payoutPct != null ? 12 : 0 }, source: 'opaque-frame-dom', observedAt: Date.now() } }).catch(() => {});
  }, 2500);

  setTimeout(() => publishFocus(true).catch(() => {}), 250);
})();
