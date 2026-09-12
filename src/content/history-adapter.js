(() => {
  if (globalThis.__ATS_HISTORY_ADAPTER__) return;
  globalThis.__ATS_HISTORY_ADAPTER__ = true;

  const normAsset = v => String(v || '').trim().toUpperCase().replace(/\s*\(OTC\)\s*/g, '').replace(/\s/g, '').replace(/-/g, '/');
  const normTf = v => {
    const s = String(v || '').trim().toUpperCase().replace(/\s+/g, '');
    if (/^\d+M$/.test(s)) return `M${s.replace('M', '')}`;
    if (/^\d+S$/.test(s)) return `S${s.replace('S', '')}`;
    return s || null;
  };
  const num = v => v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null;
  let lastSignature = '';
  let timer = null;

  async function publish() {
    const { scannerState = {} } = await chrome.storage.local.get('scannerState');
    if (!scannerState?.asset || scannerState?.platformId !== 'casatrade') return;
    const asset = normAsset(scannerState.asset);
    const history = scannerState.marketHistory || scannerState.diagnostics?.network?.recentCandles || {};
    const key = Object.keys(history).find(k => normAsset(k) === asset);
    if (!key || !Array.isArray(history[key]) || history[key].length < 3) return;
    const timeframe = normTf(scannerState.timeframe || scannerState.analysisTimeframe || null);
    const rows = history[key]
      .filter(r => !r.timeframe || !timeframe || normTf(r.timeframe) === timeframe)
      .slice(-80)
      .map(r => ({ time: Number(r.time), open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close) }))
      .filter(r => [r.time, r.open, r.high, r.low, r.close].every(Number.isFinite));
    if (rows.length < 3) return;

    const candidates = Array.isArray(scannerState.diagnostics?.network?.candidates) ? scannerState.diagnostics.network.candidates : [];
    const live = candidates.find(c => normAsset(c?.asset) === asset && ['ws','fetch','xhr'].includes(String(c?.transport || '')) && Number(c?.seenCount || 0) >= 2 && Date.now() - Number(c?.observedAt || 0) <= 6000);
    const bid = num(live?.bid), ask = num(live?.ask);
    const networkPrice = num(live?.price) ?? (bid != null && ask != null ? (bid + ask) / 2 : null);
    const price = networkPrice ?? num(scannerState.price) ?? rows.at(-1)?.close ?? null;
    if (price == null) return;
    const structured = !!live && networkPrice != null;

    const sig = `${asset}|${timeframe || ''}|${rows.length}|${rows.at(-1)?.time}|${rows.at(-1)?.close}|${price}|${structured}`;
    if (sig === lastSignature) return;
    lastSignature = sig;
    const payload = {
      platformId: scannerState.platformId,
      platformName: scannerState.platformName || 'CasaTrade',
      asset: scannerState.asset,
      timeframe: scannerState.timeframe || timeframe,
      analysisTimeframe: scannerState.timeframe || timeframe,
      price,
      expiration: scannerState.expiration || null,
      targetExpiration: scannerState.expiration || null,
      serverTime: num(live?.timestamp) || scannerState.serverTime || Date.now(),
      marketType: /\(OTC\)/i.test(String(scannerState.asset || '')) ? 'otc' : (scannerState.marketType || 'unknown'),
      instrumentType: scannerState.instrumentType || 'unknown',
      candles: rows,
      capabilities: { ...(scannerState.capabilities || {}), candles: true, structuredQuotes: structured },
      diagnostics: {
        ...(scannerState.diagnostics || {}),
        candleHistory: { source: 'network-observed', asset, timeframe, count: rows.length, lastTime: rows.at(-1)?.time || null },
        activeQuoteValidation: { matchedAsset: structured, transport: live?.transport || null, seenCount: Number(live?.seenCount || 0), ageMs: live ? Date.now() - Number(live.observedAt || 0) : null }
      }
    };
    chrome.runtime.sendMessage({ type: 'ATS_PLATFORM_SNAPSHOT', payload }).catch(() => {});
  }
  const schedule = () => { clearTimeout(timer); timer = setTimeout(() => publish().catch(() => {}), 160); };
  chrome.storage.onChanged.addListener(changes => { if (changes.scannerState) schedule(); });
  schedule();
})();