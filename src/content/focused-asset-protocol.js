(() => {
  try { globalThis.__ATS_PROTOCOL_FOCUS_RUNTIME__?.teardown?.(); } catch {}
  globalThis.__ATS_PROTOCOL_FOCUS__ = true;

  const host = String(location.hostname || '').toLowerCase().replace(/\.$/, '');
  const traderHost = value => value === 'casatraders.online' || value.endsWith('.casatraders.online') || value === 'ivcasatraders.online' || value.endsWith('.ivcasatraders.online');
  const casaHost = value => value === 'casatrade.com' || value.endsWith('.casatrade.com') || value === 'casatrade.io' || value.endsWith('.casatrade.io');
  if (!traderHost(host) && !casaHost(host)) return;
  const frameRole = traderHost(host) ? 'trader-frame' : 'casa-chart-frame';
  const sendMessage = globalThis.__ATS_SEND_MESSAGE__;
  if (typeof sendMessage !== 'function') return;

  const quotes = new Set(['USDT','USDC','USD','EUR','GBP','JPY','AUD','CAD','CHF','NZD','BRL','BTC','ETH']);
  const aliases = new Map([
    ['TRON', 'TRX/USD'], ['TRX', 'TRX/USD'], ['EURO', 'EUR/USD'], ['EUR', 'EUR/USD'],
    ['BITCOIN', 'BTC/USD'], ['BTC', 'BTC/USD'], ['ETHEREUM', 'ETH/USD'], ['ETH', 'ETH/USD']
  ]);
  const clean = value => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  function normAsset(value = '') {
    const raw = clean(value).toUpperCase();
    if (!raw || raw.length > 100) return '';
    const otc = /(?:\(|\b|[_-])OTC(?:\)|\b)?/i.test(raw);
    const direct = raw.match(/\b([A-Z0-9]{2,20})\s*[\/_-]\s*([A-Z0-9]{2,12})/i);
    if (direct && quotes.has(direct[2])) return `${direct[1]}/${direct[2]}${otc ? ' (OTC)' : ''}`;
    const compact = raw.replace(/\(\s*OTC\s*\)|\bOTC\b/gi, '').replace(/\s+/g, '').match(/^([A-Z0-9]{2,20})(USDT|USDC|USD|EUR|GBP|JPY|AUD|CAD|CHF|NZD|BRL|BTC|ETH)$/);
    if (compact) return `${compact[1]}/${compact[2]}${otc ? ' (OTC)' : ''}`;
    const bare = raw.replace(/\(\s*OTC\s*\)|\bOTC\b/gi, '').trim();
    const alias = aliases.get(bare);
    return alias ? `${alias}${otc ? ' (OTC)' : ''}` : '';
  }
  const identity = value => normAsset(value);
  const same = (a, b) => !!identity(a) && identity(a) === identity(b);

  function visualBlocksProtocolRollback(asset) {
    const meta = globalThis.__ATS_FOCUSED_ASSET_META__ || null;
    const current = globalThis.__ATS_FOCUSED_ASSET_VALUE__ || meta?.asset || '';
    if (!meta || !current || !Number(meta.at)) return false;
    const source = String(meta.source || '');
    if (source === 'protocol-selected') return false;

    // A direct user asset selection is stronger evidence than a stale network/app
    // "selected" flag. Keep it authoritative until the protocol catches up to the
    // same market or another visual interaction replaces it.
    const explicitTransition = source === 'user-selected-transition' || meta.interactionHint === true;
    if (explicitTransition) return !same(current, asset);

    if (Date.now() - Number(meta.at) > 5000) return false;
    return !same(current, asset);
  }

  let lastAsset = '';
  let lastAt = 0;
  const protocolMessageHandler = event => {
    const data = event.data;
    if (!data || data.source !== 'ATS_NETWORK_PROBE' || data.type !== 'summary') return;
    const rows = (Array.isArray(data.payload?.candidates) ? data.payload.candidates : [])
      .filter(row => row?.selected === true)
      .map(row => ({ ...row, asset: normAsset(row.asset) }))
      .filter(row => row.asset);
    const unique = [...new Map(rows.map(row => [identity(row.asset), row])).values()];
    if (unique.length !== 1) return;
    const winner = unique[0];
    // Network/app state can lag after the visible chart changes. It may confirm
    // the same asset, but it must not roll an explicit user selection back.
    if (visualBlocksProtocolRollback(winner.asset)) return;
    const now = Date.now();
    if (identity(lastAsset) === identity(winner.asset) && now - lastAt < 700) return;
    lastAsset = winner.asset; lastAt = now;
    globalThis.__ATS_FOCUSED_ASSET_VALUE__ = winner.asset;
    globalThis.__ATS_FOCUSED_ASSET_META__ = {
      asset: winner.asset, reliable: true, explicit: true, chartScoped: true,
      frameHost: host, frameRole, source: 'protocol-selected', at: now
    };
    sendMessage({
      type: 'ATS_VISUAL_FOCUS_V2', asset: winner.asset,
      score: Math.max(1000, Number(winner.confidence || 0) * 10), samples: 3,
      reliable: true, visual: false, explicit: true, chartScoped: true, chartFound: true,
      frameHost: host, frameRole, source: 'protocol-selected', at: now
    }).catch(() => {});
  };
  window.addEventListener('message', protocolMessageHandler);
  globalThis.__ATS_PROTOCOL_FOCUS_RUNTIME__ = {
    version: 'focused-asset-protocol-restartable',
    teardown() {
      try { window.removeEventListener('message', protocolMessageHandler); } catch {}
    }
  };
})();
