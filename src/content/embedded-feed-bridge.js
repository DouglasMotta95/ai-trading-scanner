(() => {
  if (globalThis.__ATS_EMBEDDED_FEED_BRIDGE__) return;
  globalThis.__ATS_EMBEDDED_FEED_BRIDGE__ = true;

  const protocol = String(location.protocol || '').toLowerCase();
  const opaqueChild = window !== window.top && (!location.hostname || ['about:','blob:','data:'].includes(protocol));
  const directSend = message => {
    const fn = globalThis.__ATS_SEND_MESSAGE__;
    if (typeof fn === 'function') return fn(message);
    return new Promise(resolve => {
      let tries = 0;
      const retry = () => {
        const current = globalThis.__ATS_SEND_MESSAGE__;
        if (typeof current === 'function') current(message).then(resolve).catch(() => resolve(null));
        else if (++tries < 80) setTimeout(retry, 50);
        else resolve(null);
      };
      retry();
    });
  };
  const marketSend = message => opaqueChild
    ? directSend({ type: 'ATS_OPAQUE_FRAME_PROXY', payload: message })
    : directSend(message);

  const clean = value => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  const asset = value => {
    const raw = clean(value).toUpperCase();
    const otc = /(?:\(|\b|[_-])OTC(?:\)|\b)?/.test(raw);
    const match = raw.match(/\b([A-Z0-9]{2,20})\s*[\/_-]\s*([A-Z0-9]{2,12})/);
    return match ? `${match[1]}/${match[2]}${otc ? ' (OTC)' : ''}` : '';
  };
  const timeframe = value => {
    const raw = clean(value).toUpperCase().replace(/\s+/g, '');
    let match = raw.match(/^M(\d+)$/) || raw.match(/^(\d+)M$/);
    if (match) return `M${Number(match[1])}`;
    match = raw.match(/^S(\d+)$/) || raw.match(/^(\d+)S$/);
    if (match) return `S${Number(match[1])}`;
    match = raw.match(/^H(\d+)$/) || raw.match(/^(\d+)H$/);
    return match ? `H${Number(match[1])}` : null;
  };
  const timeframeMs = value => {
    const tf = timeframe(value);
    return !tf ? null : tf[0] === 'S' ? Number(tf.slice(1)) * 1000 : tf[0] === 'M' ? Number(tf.slice(1)) * 60000 : Number(tf.slice(1)) * 3600000;
  };
  const timestamp = value => {
    let n = Number(value);
    if (!Number.isFinite(n)) return null;
    if (n < 1e12) n *= 1000;
    return n > 946684800000 ? n : null;
  };
  const validCandle = row => [row?.open,row?.high,row?.low,row?.close].every(value => Number.isFinite(Number(value))) && timestamp(row?.time ?? row?.timestamp);
  const feedQuality = payload => {
    const raw = Number(payload?.feedQuality);
    if (!Number.isFinite(raw)) return 0;
    return Math.max(0, Math.min(1, raw > 1 ? raw / 100 : raw));
  };

  let focusAsset = '';
  let focusAt = 0;
  let focusSource = '';
  let lastFocusRead = 0;
  let lastSignature = '';
  let lastSignatureAt = 0;
  let lastSummaryAt = 0;
  let networkAsset = '';
  let networkHits = 0;
  let networkFirstAt = 0;
  let networkLastAt = 0;

  function rememberFocus(state = {}) {
    const focus = state?.diagnostics?.focusedAsset || {};
    focusAsset = asset(focus.asset || '');
    focusAt = Number(focus.at || 0);
    focusSource = String(focus.source || '');
    return focusAsset;
  }

  function refreshFocus(force = false) {
    const now = Date.now();
    if (!force && now - lastFocusRead < 250) return Promise.resolve(focusAsset);
    lastFocusRead = now;
    return directSend({ type: 'ATS_READ_SCANNER_STATE' }).then(response => rememberFocus(response?.state || {})).catch(() => focusAsset);
  }

  function uniqueSelected(payload = {}) {
    const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
    const selected = candidates.filter(row => row?.selected === true && asset(row?.asset));
    const unique = [...new Set(selected.map(row => asset(row.asset)))];
    if (unique.length !== 1) return null;
    const wanted = unique[0];
    const row = selected
      .filter(item => asset(item.asset) === wanted)
      .sort((a,b) => Number(b?.confidence || 0) - Number(a?.confidence || 0)
        || Number(b?.observedAt || 0) - Number(a?.observedAt || 0))[0] || null;
    if (!row || Number(row.confidence || 0) < 90 || feedQuality(payload) < .8) return null;
    const recent = payload.recentCandles && typeof payload.recentCandles === 'object' ? payload.recentCandles : {};
    const hasHistory = Object.keys(recent).some(name => asset(name) === wanted && Array.isArray(recent[name]) && recent[name].some(validCandle));
    return hasHistory ? { asset: wanted, row } : null;
  }

  function observeNetworkSelection(payload = {}) {
    const selected = uniqueSelected(payload);
    const now = Date.now();
    if (!selected) {
      networkAsset = '';
      networkHits = 0;
      networkFirstAt = 0;
      networkLastAt = 0;
      return null;
    }
    if (selected.asset === networkAsset && now - networkLastAt < 1200) networkHits += 1;
    else {
      networkAsset = selected.asset;
      networkHits = 1;
      networkFirstAt = now;
    }
    networkLastAt = now;
    return { ...selected, hits: networkHits, stableMs: now - networkFirstAt };
  }

  async function recoverFocusFromNetwork(payload = {}) {
    const selected = observeNetworkSelection(payload);
    if (!selected) return focusAsset;
    const now = Date.now();
    const noFocus = !focusAsset;
    const staleFocus = !!focusAsset && now - Number(focusAt || 0) > 2600;
    const enough = noFocus
      ? selected.hits >= 3 && selected.stableMs >= 220
      : selected.hits >= 5 && selected.stableMs >= 700;
    if (!enough || (!noFocus && !staleFocus) || (!noFocus && selected.asset === focusAsset)) return focusAsset;

    await marketSend({
      type: 'ATS_VISUAL_FOCUS_V2',
      asset: selected.asset,
      reliable: true,
      chartScoped: true,
      visual: false,
      explicit: false,
      score: noFocus ? 92 : 90,
      samples: selected.hits,
      frameRole: location.hostname.includes('casatraders') ? 'trader-frame' : 'casa-chart-frame',
      source: noFocus ? 'network-bootstrap-selected' : 'network-stable-fallback'
    }).catch(() => {});
    focusAsset = selected.asset;
    focusAt = now;
    focusSource = noFocus ? 'network-bootstrap-selected' : 'network-stable-fallback';
    return focusAsset;
  }

  function process(payload, visibleAsset) {
    const wanted = asset(visibleAsset);
    if (!wanted) return;

    const recent = payload.recentCandles && typeof payload.recentCandles === 'object' ? payload.recentCandles : {};
    const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
    const key = Object.keys(recent).find(name => asset(name) === wanted);
    const rawRows = key ? recent[key] : [];
    const rows = (Array.isArray(rawRows) ? rawRows : []).filter(validCandle).sort((a,b) => timestamp(a.time ?? a.timestamp) - timestamp(b.time ?? b.timestamp));
    const latest = rows.at(-1);
    const candidate = candidates
      .filter(row => asset(row?.asset) === wanted)
      .sort((a,b) => Number(b?.selected === true) - Number(a?.selected === true)
        || Number(b?.confidence || 0) - Number(a?.confidence || 0)
        || Number(b?.observedAt || 0) - Number(a?.observedAt || 0))[0] || null;

    if (!candidate) return;

    const signature = `${wanted}|${Number(candidate.price ?? candidate.bid ?? candidate.ask ?? 0)}|${timestamp(latest?.time ?? latest?.timestamp) || 0}|${Number(payload.feedQuality ?? 0)}`;
    const now = Date.now();
    if (signature === lastSignature && now - lastSignatureAt < 350) return;
    lastSignature = signature;
    lastSignatureAt = now;

    marketSend({ type: 'ATS_EMBEDDED_FEED', payload }).catch(() => {});

    if (!latest) return;
    const tf = timeframe(candidate.timeframe || latest.timeframe);
    const durationMs = timeframeMs(tf);
    const openAt = timestamp(latest.time ?? latest.timestamp);
    const sourceNow = timestamp(candidate.timestamp ?? candidate.time ?? candidate.serverTime);
    if (!tf || !durationMs || !openAt) return;

    window.dispatchEvent(new CustomEvent('ATS_NUMERIC_OHLC_CLOCK', {
      detail: {
        asset: wanted,
        timeframe: tf,
        openAt,
        durationMs,
        sourceNow,
        expiration: candidate.expiration || null
      }
    }));
  }

  window.addEventListener('message', event => {
    const data = event.data;
    if (!data || data.source !== 'ATS_NETWORK_PROBE' || data.type !== 'summary') return;
    const now = Date.now();
    if (now - lastSummaryAt < 60) return;
    lastSummaryAt = now;
    const payload = data.payload || {};
    refreshFocus().then(async current => {
      const recovered = current || await recoverFocusFromNetwork(payload);
      if (current) await recoverFocusFromNetwork(payload);
      process(payload, recovered || focusAsset);
    }).catch(() => {});
  }, true);

  chrome?.storage?.onChanged?.addListener?.((changes, area) => {
    if (area !== 'local' || !changes.scannerState?.newValue) return;
    rememberFocus(changes.scannerState.newValue || {});
  });

  refreshFocus(true).catch(() => {});
})();
