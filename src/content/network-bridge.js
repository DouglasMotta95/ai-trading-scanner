(() => {
  if (globalThis.__ATS_NETWORK_BRIDGE__) return;
  globalThis.__ATS_NETWORK_BRIDGE__ = true;

  const RELAY_SOURCE = 'ATS_NETWORK_PROBE_RELAY_V2';
  const isTop = window === window.top;
  const num = v => v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null;

  function bestCandidate(payload = {}) {
    const rows = Array.isArray(payload.candidates) ? payload.candidates.slice() : [];
    rows.sort((a, b) =>
      Number(b?.selected === true) - Number(a?.selected === true)
      || Number(b?.confidence || 0) - Number(a?.confidence || 0)
      || Number(b?.seenCount || 0) - Number(a?.seenCount || 0)
      || Number(b?.observedAt || 0) - Number(a?.observedAt || 0)
    );
    return rows.find(c => {
      const price = num(c?.price) ?? (num(c?.bid) != null && num(c?.ask) != null ? (num(c.bid) + num(c.ask)) / 2 : null);
      return String(c?.asset || '').trim() && price != null && price > 0;
    }) || null;
  }

  function historyFor(payload = {}, asset = '') {
    const history = payload.recentCandles || {};
    const wanted = String(asset || '').toUpperCase().replace(/\s*\(OTC\)\s*$/, '');
    const key = Object.keys(history).find(k => String(k).toUpperCase().replace(/\s*\(OTC\)\s*$/, '') === wanted);
    return key && Array.isArray(history[key]) ? history[key].slice(-120) : [];
  }

  function publishToExtension(payload = {}) {
    chrome.runtime.sendMessage({ type: 'ATS_NETWORK_DIAGNOSTIC', payload }).catch(() => {});

    const candidate = bestCandidate(payload);
    if (!candidate) return;

    const price = num(candidate.price) ?? (num(candidate.bid) != null && num(candidate.ask) != null ? (num(candidate.bid) + num(candidate.ask)) / 2 : null);
    const asset = String(candidate.asset || '').trim();
    const candles = historyFor(payload, asset);
    const timeframe = candidate.timeframe || candles.at(-1)?.timeframe || 'M1';
    const expiration = candidate.expiration || null;

    chrome.runtime.sendMessage({
      type: 'ATS_PLATFORM_SNAPSHOT',
      payload: {
        platformId: 'casatrade',
        platformName: 'CasaTrade',
        connection: 'online',
        asset,
        price,
        timeframe,
        expiration,
        instrumentType: candidate.instrumentType || candidate.type || 'unknown',
        marketType: /\(OTC\)/i.test(asset) ? 'otc' : 'regular',
        serverTime: Number(candidate.timestamp) > 1e12 ? Number(candidate.timestamp) : null,
        candles,
        ticks: [{ price, at: Date.now() }],
        capabilities: {
          structuredQuotes: candidate.transport !== 'rendered',
          candles: candles.length >= 3,
          expiration: !!expiration,
          multiAsset: false
        },
        diagnostics: {
          capture: `top-frame-relay:${candidate.transport || payload.primaryTransport || 'market'}`,
          feedQuality: Number(payload.feedQuality || 0),
          relayed: true,
          candidateCount: Number(payload.candidateCount || payload.candidates?.length || 0)
        }
      }
    }).catch(() => {});
  }

  window.addEventListener('message', event => {
    const data = event.data;

    if (data?.source === 'ATS_NETWORK_PROBE' && data?.type === 'summary') {
      const payload = data.payload || {};
      if (isTop) publishToExtension(payload);
      else {
        try { window.top.postMessage({ source: RELAY_SOURCE, payload }, '*'); } catch {}
      }
      return;
    }

    if (isTop && data?.source === RELAY_SOURCE) {
      publishToExtension(data.payload || {});
    }
  });
})();