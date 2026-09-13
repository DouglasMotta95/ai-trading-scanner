(() => {
  if (globalThis.__ATS_EMBEDDED_FEED_BRIDGE__) return;
  globalThis.__ATS_EMBEDDED_FEED_BRIDGE__ = true;

  const host = String(location.hostname || '').toLowerCase().replace(/\.$/, '');
  const trusted = host === 'casatraders.online' || host.endsWith('.casatraders.online') ||
    host === 'ivcasatraders.online' || host.endsWith('.ivcasatraders.online');
  if (!trusted) return;

  let lastSentAt = 0;

  function send(type, payload = {}) {
    const now = Date.now();
    if (type === 'ATS_EMBEDDED_FEED' && now - lastSentAt < 80) return;
    if (type === 'ATS_EMBEDDED_FEED') lastSentAt = now;
    chrome.runtime.sendMessage({ type, payload }).catch(() => {});
  }

  window.addEventListener('message', event => {
    const data = event.data;
    if (!data || data.source !== 'ATS_NETWORK_PROBE') return;
    if (data.type === 'summary') send('ATS_EMBEDDED_FEED', data.payload || {});
    if (data.type === 'ready') send('ATS_EMBEDDED_FEED_READY', { at: Date.now() });
  });
})();
