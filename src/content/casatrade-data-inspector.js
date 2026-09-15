(() => {
  if (globalThis.__ATS_DATA_INSPECTOR__) return;
  globalThis.__ATS_DATA_INSPECTOR__ = true;

  const clean = value => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  const host = String(location.hostname || '').toLowerCase().replace(/\.$/, '');
  const traderHost = value => value === 'casatraders.online' || value.endsWith('.casatraders.online') || value === 'ivcasatraders.online' || value.endsWith('.ivcasatraders.online');
  if (!traderHost(host)) return;

  const quotes = new Set(['USDT','USDC','USD','EUR','GBP','JPY','AUD','CAD','CHF','NZD','BRL','BTC','ETH']);
  function normAsset(value = '') {
    const raw = clean(value).toUpperCase();
    const otc = /(?:\(|\b|[_-])OTC(?:\)|\b)?/i.test(raw);
    const direct = raw.match(/\b([A-Z0-9]{2,20})\s*[\/_-]\s*([A-Z0-9]{2,12})/i);
    if (!direct || !quotes.has(direct[2])) return '';
    return `${direct[1]}/${direct[2]}${otc ? ' (OTC)' : ''}`;
  }
  const id = value => normAsset(value).replace(/\s*\(OTC\)\s*$/i, '');
  const sameAsset = (a, b) => !!id(a) && id(a) === id(b);
  const safeEndpoint = value => {
    try {
      const url = new URL(String(value || ''), location.href);
      return `${url.origin}${url.pathname}`.slice(0, 240);
    } catch { return ''; }
  };

  let lastSent = 0;
  let lastKey = '';
  window.addEventListener('message', event => {
    const data = event.data;
    if (!data || data.source !== 'ATS_NETWORK_PROBE' || data.type !== 'summary') return;
    const payload = data.payload || {};
    const focus = normAsset(globalThis.__ATS_FOCUSED_ASSET_VALUE__ || '');
    const rows = Array.isArray(payload.candidates) ? payload.candidates : [];
    const focused = focus ? rows.filter(row => sameAsset(row?.asset, focus)) : [];
    focused.sort((a, b) => Number(b?.selected === true) - Number(a?.selected === true)
      || Number(b?.confidence || 0) - Number(a?.confidence || 0)
      || Number(b?.observedAt || 0) - Number(a?.observedAt || 0));
    const candidate = focused[0] || null;
    const recent = payload.recentCandles && typeof payload.recentCandles === 'object' ? payload.recentCandles : {};
    const historyKey = focus ? Object.keys(recent).find(key => sameAsset(key, focus)) : null;
    const candleCount = historyKey && Array.isArray(recent[historyKey]) ? recent[historyKey].length : 0;
    const snapshot = {
      transports: { messages: payload.messages || {}, connections: payload.connections || {}, primary: payload.primaryTransport || null },
      endpoints: (Array.isArray(payload.endpoints) ? payload.endpoints : []).map(safeEndpoint).filter(Boolean).slice(-12),
      keys: (Array.isArray(payload.keys) ? payload.keys : []).filter(key => !/token|auth|cookie|session|password|secret|bearer|csrf|api[-_]?key|credential/i.test(String(key))).slice(0, 80),
      rawCandidateCount: rows.length,
      candleCount,
      focusedCandidate: candidate ? {
        asset: normAsset(candidate.asset),
        price: Number.isFinite(Number(candidate.price)) ? Number(candidate.price) : null,
        bid: Number.isFinite(Number(candidate.bid)) ? Number(candidate.bid) : null,
        ask: Number.isFinite(Number(candidate.ask)) ? Number(candidate.ask) : null,
        timeframe: clean(candidate.timeframe || ''),
        expiration: clean(candidate.expiration || ''),
        timestamp: Number.isFinite(Number(candidate.timestamp)) ? Number(candidate.timestamp) : null,
        transport: clean(candidate.transport || ''),
        confidence: Number(candidate.confidence || 0),
        selected: candidate.selected === true
      } : null
    };
    const key = JSON.stringify(snapshot);
    const now = Date.now();
    if (key === lastKey && now - lastSent < 1500) return;
    if (now - lastSent < 350) return;
    lastKey = key;
    lastSent = now;
    chrome.runtime.sendMessage({ type: 'ATS_DATA_INSPECTOR', snapshot }).catch(() => {});
  });
})();
