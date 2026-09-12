(() => {
  if (globalThis.__ATS_HISTORY_ADAPTER__) return;
  globalThis.__ATS_HISTORY_ADAPTER__ = true;

  const normAsset = v => String(v || '').trim().toUpperCase().replace(/\s/g, '').replace(/-/g, '/');
  const normTf = v => {
    const s = String(v || '').trim().toUpperCase().replace(/\s+/g, '');
    if (/^\d+M$/.test(s)) return `M${s.replace('M', '')}`;
    if (/^\d+S$/.test(s)) return `S${s.replace('S', '')}`;
    return s || null;
  };
  let lastSignature = '';
  let timer = null;

  async function publish() {
    const { scannerState = {} } = await chrome.storage.local.get('scannerState');
    if (!scannerState?.asset || !scannerState?.price || scannerState?.platformId !== 'casatrade') return;
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
    const sig = `${asset}|${timeframe || ''}|${rows.length}|${rows.at(-1)?.time}|${rows.at(-1)?.close}`;
    if (sig === lastSignature) return;
    lastSignature = sig;
    const payload = {
      platformId: scannerState.platformId,
      platformName: scannerState.platformName || 'CasaTrade',
      asset: scannerState.asset,
      timeframe: scannerState.timeframe || timeframe,
      analysisTimeframe: scannerState.timeframe || timeframe,
      price: scannerState.price,
      expiration: scannerState.expiration || null,
      targetExpiration: scannerState.expiration || null,
      serverTime: scannerState.serverTime || Date.now(),
      marketType: scannerState.marketType || 'unknown',
      instrumentType: scannerState.instrumentType || 'unknown',
      candles: rows,
      capabilities: { ...(scannerState.capabilities || {}), candles: true },
      diagnostics: { ...(scannerState.diagnostics || {}), candleHistory: { source: 'network-observed', asset, timeframe, count: rows.length, lastTime: rows.at(-1)?.time || null } }
    };
    chrome.runtime.sendMessage({ type: 'ATS_PLATFORM_SNAPSHOT', payload }).catch(() => {});
  }
  const schedule = () => { clearTimeout(timer); timer = setTimeout(() => publish().catch(() => {}), 160); };
  chrome.storage.onChanged.addListener(changes => { if (changes.scannerState) schedule(); });
  schedule();
})();