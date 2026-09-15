(() => {
  if (globalThis.__ATS_EMBEDDED_FEED_BRIDGE__) return;
  globalThis.__ATS_EMBEDDED_FEED_BRIDGE__ = true;

  const host = String(location.hostname || '').toLowerCase().replace(/\.$/, '');
  const trusted = host === 'casatraders.online' || host.endsWith('.casatraders.online') ||
    host === 'ivcasatraders.online' || host.endsWith('.ivcasatraders.online') ||
    host === 'casatrade.com' || host.endsWith('.casatrade.com') ||
    host === 'casatrade.io' || host.endsWith('.casatrade.io');
  if (!trusted) return;

  let lastSentAt = 0;
  window.addEventListener('message', event => {
    const data = event.data;
    if (!data || data.source !== 'ATS_NETWORK_PROBE' || data.type !== 'summary') return;
    const now = Date.now();
    if (now - lastSentAt < 80) return;
    lastSentAt = now;
    chrome.runtime.sendMessage({ type: 'ATS_EMBEDDED_FEED', payload: data.payload || {} }).catch(() => {});
  });
})();
