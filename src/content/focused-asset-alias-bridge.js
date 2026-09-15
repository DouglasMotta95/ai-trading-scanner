(() => {
  if (globalThis.__ATS_FOCUSED_ASSET_ALIAS_BRIDGE__) return;
  globalThis.__ATS_FOCUSED_ASSET_ALIAS_BRIDGE__ = true;

  const host = String(location.hostname || '').toLowerCase().replace(/\.$/, '');
  const traderHost = value => value === 'casatraders.online' || value.endsWith('.casatraders.online') || value === 'ivcasatraders.online' || value.endsWith('.ivcasatraders.online');
  const casaHost = value => value === 'casatrade.com' || value.endsWith('.casatrade.com') || value === 'casatrade.io' || value.endsWith('.casatrade.io');
  if (!traderHost(host) && !casaHost(host)) return;
  const frameRole = traderHost(host) ? 'trader-frame' : 'casa-chart-frame';
  const sendMessage = globalThis.__ATS_SEND_MESSAGE__;
  if (typeof sendMessage !== 'function') return;

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
  const STOP = new Set(['BUY','SELL','CALL','PUT','OTC','USD','USDT','USDC','TIME','TIMER','PRICE','ASSET','ATIVO','VALOR','SALDO','PAYOUT']);
  const clean = value => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  const fold = value => clean(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
  const visible = el => {
    if (!el || !(el instanceof Element)) return false;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0;
  };

  function canonicalFromText(value = '', allowGenericTicker = false) {
    const raw = fold(value);
    if (!raw || raw.length > 100) return '';
    const otc = /(?:\(|\b|[_-])OTC(?:\)|\b)?/.test(raw);
    const stripped = raw.replace(/\(\s*OTC\s*\)|\bOTC\b/g, ' ').replace(/\s+/g, ' ').trim();
    for (const [label, pair] of ALIASES) {
      const re = new RegExp(`(^|[^A-Z0-9])${label.replace(/ /g, '\\s+')}([^A-Z0-9]|$)`);
      if (re.test(stripped)) return `${pair}${otc ? ' (OTC)' : ''}`;
    }
    if (!allowGenericTicker) return '';
    const ticker = stripped.match(/^([A-Z0-9]{2,8})$/)?.[1] || '';
    if (!ticker || STOP.has(ticker)) return '';
    return `${ticker}/USD${otc ? ' (OTC)' : ''}`;
  }

  const metaText = el => clean([
    el?.getAttribute?.('aria-label'), el?.getAttribute?.('title'), el?.getAttribute?.('data-symbol'),
    el?.getAttribute?.('data-asset'), el?.getAttribute?.('data-instrument'), el?.getAttribute?.('data-testid'),
    el?.innerText, el?.textContent
  ].filter(Boolean).join(' ')).slice(0, 100);

  function contextOf(el) {
    const parts = [];
    let node = el;
    for (let i = 0; node && i < 4; i += 1, node = node.parentElement) {
      parts.push(String(node.id || ''), String(node.className || ''), node.getAttribute?.('role') || '', node.getAttribute?.('data-testid') || '', node.getAttribute?.('aria-label') || '');
    }
    return parts.join(' ').toLowerCase();
  }

  function selected(el) {
    let node = el;
    for (let i = 0; node && i < 3; i += 1, node = node.parentElement) {
      const flags = `${node.getAttribute?.('aria-selected') || ''} ${node.getAttribute?.('aria-current') || ''} ${node.getAttribute?.('data-state') || ''} ${node.getAttribute?.('data-active') || ''} ${node.className || ''}`;
      if (/true|active|selected|current|checked/i.test(flags)) return true;
    }
    return false;
  }

  let recentInteraction = { asset: '', at: 0 };
  let lastSent = { asset: '', at: 0 };

  function eventAsset(event) {
    const path = typeof event?.composedPath === 'function' ? event.composedPath() : [event?.target];
    for (const node of path.slice(0, 8)) {
      if (!(node instanceof Element) || !visible(node)) continue;
      const text = metaText(node);
      const asset = canonicalFromText(text, false);
      if (asset) return asset;
      const context = contextOf(node);
      if (/asset|ativo|instrument|symbol|market|list|option|row/.test(context)) {
        const generic = canonicalFromText(text, true);
        if (generic) return generic;
      }
    }
    return '';
  }

  async function publish(asset, source, score = 1200) {
    if (!asset) return;
    const now = Date.now();
    if (lastSent.asset === asset && now - lastSent.at < 650) return;
    lastSent = { asset, at: now };
    globalThis.__ATS_FOCUSED_ASSET_VALUE__ = asset;
    globalThis.__ATS_FOCUSED_ASSET_META__ = {
      asset, reliable: true, explicit: true, chartScoped: true,
      frameHost: host, frameRole, source, at: now
    };
    await sendMessage({
      type: 'ATS_VISUAL_FOCUS_V2', asset, score, samples: 3,
      reliable: true, visual: true, explicit: true, interactionHint: source === 'user-selected-alias',
      interactionAt: source === 'user-selected-alias' ? now : null,
      chartScoped: true, chartFound: true, frameHost: host, frameRole, source, at: now
    }).catch(() => {});
  }

  function scanVisibleAlias() {
    const rows = [];
    let seen = 0;
    for (const el of document.querySelectorAll('*')) {
      if (++seen > 5000 || !visible(el)) continue;
      const text = metaText(el);
      if (!text) continue;
      const context = contextOf(el);
      const strongContext = /chart|header|asset|ativo|instrument|symbol|market|selected|current/.test(context);
      const asset = canonicalFromText(text, strongContext && text.length <= 28);
      if (!asset) continue;
      const isSelected = selected(el);
      const interacted = recentInteraction.asset === asset && Date.now() - recentInteraction.at < 3500;
      if (!strongContext && !isSelected && !interacted) continue;
      let score = strongContext ? 500 : 0;
      if (isSelected) score += 500;
      if (interacted) score += 900;
      if (text.length <= 24) score += 80;
      rows.push({ asset, score, source: interacted ? 'user-selected-alias' : 'visible-name-alias' });
    }
    rows.sort((a, b) => b.score - a.score);
    const first = rows[0];
    const second = rows[1];
    if (!first) return;
    if (second && second.asset !== first.asset && first.score - second.score < 180 && first.source !== 'user-selected-alias') return;
    publish(first.asset, first.source, first.score).catch(() => {});
  }

  const note = event => {
    const asset = eventAsset(event);
    if (!asset) return;
    recentInteraction = { asset, at: Date.now() };
    // A direct user selection is a strong short-lived fallback when CasaTrade's
    // chart header only exposes a human name such as TRON instead of TRX/USD.
    setTimeout(() => publish(asset, 'user-selected-alias', 1800).catch(() => {}), 80);
    setTimeout(scanVisibleAlias, 160);
  };

  document.addEventListener('pointerup', note, true);
  document.addEventListener('touchend', note, true);
  document.addEventListener('click', note, true);
  new MutationObserver(() => setTimeout(scanVisibleAlias, 120)).observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });
  setInterval(scanVisibleAlias, 900);
  setTimeout(scanVisibleAlias, 300);
})();
