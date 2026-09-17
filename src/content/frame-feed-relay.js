(() => {
  if (globalThis.__ATS_FRAME_FEED_RELAY__) return;
  globalThis.__ATS_FRAME_FEED_RELAY__ = true;

  const TOP_MESSAGE = 'ATS_CT_FRAME_FEED_V1';
  const isTop = window === window.top;
  const quotes = new Set(['USDT','USDC','USD','EUR','GBP','JPY','AUD','CAD','CHF','NZD','BRL','BTC','ETH']);
  const clean = v => String(v ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  const num = v => v == null || v === '' ? null : Number.isFinite(Number(String(v).replace(',', '.'))) ? Number(String(v).replace(',', '.')) : null;

  function canonicalAsset(value = '') {
    let raw = clean(value).toUpperCase();
    if (!raw) return '';
    const otc = /(?:\(|\b|[_-])OTC(?:\)|\b)?/.test(raw);
    let s = raw.replace(/\(\s*OTC\s*\)|\bOTC\b/g, '').replace(/^FRX[:_-]?/, '')
      .replace(/\s+/g, '').replace(/_/g, '/').replace(/-/g, '/').replace(/:+/g, '/').replace(/^\/+|\/+$/g, '');
    if (!s.includes('/')) {
      const q = [...quotes].find(x => s.length > x.length && s.endsWith(x));
      if (q) s = `${s.slice(0, -q.length)}/${q}`;
      else if (/^[A-Z]{6}$/.test(s)) s = `${s.slice(0, 3)}/${s.slice(3)}`;
    }
    const m = s.match(/^([A-Z0-9]{2,16})\/([A-Z0-9]{2,12})$/);
    if (!m || !quotes.has(m[2])) return '';
    return `${m[1]}/${m[2]}${otc ? ' (OTC)' : ''}`;
  }

  const identity = a => canonicalAsset(a).replace(/\s*\(OTC\)\s*$/, '');
  const sameAsset = (a, b) => !!identity(a) && identity(a) === identity(b);
  const pairRe = /\b([A-Z0-9]{2,16})\s*[\/_-]\s*(USDT|USDC|USD|EUR|GBP|JPY|AUD|CAD|CHF|NZD|BRL|BTC|ETH)(?:\s*\(\s*OTC\s*\)|\s+OTC)?/i;

  function normalizedCandidates(payload = {}) {
    return (Array.isArray(payload.candidates) ? payload.candidates : []).map(c => {
      const asset = canonicalAsset(c?.asset);
      const bid = num(c?.bid), ask = num(c?.ask);
      const price = num(c?.price) ?? (bid != null && ask != null ? (bid + ask) / 2 : null);
      return { ...c, asset, price };
    }).filter(c => c.asset && c.price != null && c.price > 0)
      .sort((a, b) => Number(b.selected === true) - Number(a.selected === true)
        || Number(b.confidence || 0) - Number(a.confidence || 0)
        || Number(b.seenCount || 0) - Number(a.seenCount || 0));
  }

  function historyFor(payload, asset) {
    const map = payload?.recentCandles && typeof payload.recentCandles === 'object' ? payload.recentCandles : {};
    const key = Object.keys(map).find(k => sameAsset(k, asset));
    return key && Array.isArray(map[key]) ? map[key].slice(-120) : [];
  }

  function relay(evidence) {
    if (!evidence?.asset || evidence?.price == null) return;
    const packet = { source: TOP_MESSAGE, evidence: { ...evidence, at: Date.now() } };
    if (isTop) publish(packet.evidence);
    else {
      try { window.top.postMessage(packet, '*'); } catch {}
    }
  }

  function publish(evidence) {
    if (!isTop || !evidence?.asset || evidence?.price == null) return;
    const asset = canonicalAsset(evidence.asset);
    if (!asset) return;
    const quality = Math.max(0, Math.min(100, Number(evidence.feedQuality || 0)));
    const reliable = evidence.reliable === true || quality >= 80;

    chrome.runtime.sendMessage({
      type: 'ATS_FOCUSED_ASSET', asset, score: reliable ? 180 : 90, samples: reliable ? 2 : 1,
      reliable, visual: evidence.visual === true, source: evidence.source || 'frame-relay', at: Date.now()
    }).catch(() => {});

    if (quality > 0) {
      chrome.runtime.sendMessage({
        type: 'ATS_NETWORK_DIAGNOSTIC',
        payload: { feedQuality: quality, candidateCount: 1, primaryTransport: evidence.transport || 'frame-relay',
          candidates: [{ asset, price: Number(evidence.price), confidence: quality, selected: reliable, transport: evidence.transport || 'frame-relay' }],
          recentCandles: evidence.candles?.length ? { [asset]: evidence.candles } : {}, parser: { frameRelay: true } }
      }).catch(() => {});
    }

    chrome.runtime.sendMessage({
      type: 'ATS_PLATFORM_SNAPSHOT',
      payload: {
        platformId: 'casatrade', platformName: 'CasaTrade', connection: 'online', asset,
        price: Number(evidence.price), timeframe: evidence.timeframe || 'M1', analysisTimeframe: evidence.timeframe || 'M1',
        expiration: evidence.expiration || null, secondsRemaining: Number.isFinite(Number(evidence.secondsRemaining)) ? Number(evidence.secondsRemaining) : null,
        marketType: /\(OTC\)$/i.test(asset) ? 'otc' : 'regular', instrumentType: 'unknown', serverTime: num(evidence.timestamp),
        candles: Array.isArray(evidence.candles) ? evidence.candles.slice(-120) : [],
        capabilities: { structuredQuotes: evidence.structured === true, candles: Array.isArray(evidence.candles) && evidence.candles.length >= 2, expiration: !!evidence.expiration, multiAsset: false },
        diagnostics: { capture: evidence.source || 'frame-relay', frameRelay: true, feedQuality: quality }
      }
    }).catch(() => {});
  }

  if (isTop) {
    window.addEventListener('message', event => {
      if (event?.data?.source !== TOP_MESSAGE) return;
      publish(event.data.evidence || {});
    });
  }

  // Network/worker probes already parse the real CasaTrade transport. Relay their strongest
  // candidate through the top frame so background validation sees the CasaTrade tab URL even
  // when the feed itself lives in an opaque/about/embedded child frame.
  window.addEventListener('message', event => {
    const data = event?.data;
    if (!data || data.source !== 'ATS_NETWORK_PROBE' || data.type !== 'summary') return;
    const payload = data.payload || {};
    const candidate = normalizedCandidates(payload)[0];
    if (!candidate) return;
    const quality = Math.max(Number(payload.feedQuality || 0), Number(candidate.confidence || 0));
    relay({
      asset: candidate.asset, price: candidate.price, timeframe: candidate.timeframe || 'M1', expiration: candidate.expiration || null,
      secondsRemaining: candidate.secondsRemaining ?? payload.secondsRemaining ?? null, timestamp: candidate.timestamp || null,
      candles: historyFor(payload, candidate.asset), feedQuality: quality, structured: true,
      reliable: candidate.selected === true || quality >= 80 || Number(candidate.seenCount || 0) >= 2,
      source: 'child-network-relay', transport: candidate.transport || payload.primaryTransport || 'network'
    });
  });

  // DOM fallback: only grant confirmation-grade quality when the selected asset and a concrete
  // BUY/SELL price are both visible in the same frame. A weak generic DOM match stays below 80.
  function domEvidence() {
    const text = clean(document.body?.innerText || document.body?.textContent || '');
    const m = text.match(pairRe);
    const asset = canonicalAsset(m?.[0] || '');
    if (!asset) return null;
    const buy = text.match(/(?:COMPRAR|BUY)[^0-9]{0,30}(\d{1,6}[.,]\d{3,8})/i);
    const sell = text.match(/(?:VENDER|SELL)[^0-9]{0,30}(\d{1,6}[.,]\d{3,8})/i);
    const buyPrice = num(buy?.[1]), sellPrice = num(sell?.[1]);
    const price = buyPrice != null && sellPrice != null ? (buyPrice + sellPrice) / 2 : (buyPrice ?? sellPrice);
    if (price == null) return null;
    const selected = !!document.querySelector('[aria-selected="true"],[data-active="true"],[data-state="active"],[data-state="selected"]');
    return { asset, price, feedQuality: selected ? 85 : 65, structured: false, reliable: selected, visual: true, source: 'child-dom-relay', transport: 'rendered' };
  }

  let lastDomSignature = '';
  setInterval(() => {
    const evidence = domEvidence();
    if (!evidence) return;
    const signature = `${evidence.asset}|${evidence.price}|${evidence.feedQuality}`;
    if (signature === lastDomSignature) return;
    lastDomSignature = signature;
    relay(evidence);
  }, 450);
})();
