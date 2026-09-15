(() => {
  if (globalThis.__ATS_PROTOCOL_FOCUS__) return;
  globalThis.__ATS_PROTOCOL_FOCUS__ = true;

  const host = String(location.hostname || '').toLowerCase().replace(/\.$/, '');
  const traderHost = value => value === 'casatraders.online' || value.endsWith('.casatraders.online') || value === 'ivcasatraders.online' || value.endsWith('.ivcasatraders.online');
  if (!traderHost(host)) return;

  const quotes = new Set(['USDT','USDC','USD','EUR','GBP','JPY','AUD','CAD','CHF','NZD','BRL','BTC','ETH']);
  const clean = value => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  function normAsset(value = '') {
    const raw = clean(value).toUpperCase();
    const otc = /(?:\(|\b|[_-])OTC(?:\)|\b)?/i.test(raw);
    const direct = raw.match(/\b([A-Z0-9]{2,20})\s*[\/_-]\s*([A-Z0-9]{2,12})/i);
    if (!direct || !quotes.has(direct[2])) return '';
    return `${direct[1]}/${direct[2]}${otc ? ' (OTC)' : ''}`;
  }
  const identity = value => normAsset(value).replace(/\s*\(OTC\)\s*$/i, '');

  let lastAsset = '';
  let lastAt = 0;
  window.addEventListener('message', event => {
    const data = event.data;
    if (!data || data.source !== 'ATS_NETWORK_PROBE' || data.type !== 'summary') return;
    const rows = (Array.isArray(data.payload?.candidates) ? data.payload.candidates : [])
      .filter(row => row?.selected === true)
      .map(row => ({ ...row, asset: normAsset(row.asset) }))
      .filter(row => row.asset);
    const unique = [...new Map(rows.map(row => [identity(row.asset), row])).values()];
    if (unique.length !== 1) return;
    const winner = unique[0];
    const now = Date.now();
    if (identity(lastAsset) === identity(winner.asset) && now - lastAt < 700) return;
    lastAsset = winner.asset;
    lastAt = now;
    globalThis.__ATS_FOCUSED_ASSET_VALUE__ = winner.asset;
    globalThis.__ATS_FOCUSED_ASSET_META__ = {
      asset: winner.asset, reliable: true, explicit: true, chartScoped: true,
      frameHost: host, frameRole: 'trader-frame', source: 'protocol-selected', at: now
    };
    chrome.runtime.sendMessage({
      type: 'ATS_VISUAL_FOCUS_V2', asset: winner.asset,
      score: Math.max(1000, Number(winner.confidence || 0) * 10), samples: 3,
      reliable: true, visual: false, explicit: true, chartScoped: true, chartFound: true,
      frameHost: host, frameRole: 'trader-frame', source: 'protocol-selected', at: now
    }).catch(() => {});
  });
})();
