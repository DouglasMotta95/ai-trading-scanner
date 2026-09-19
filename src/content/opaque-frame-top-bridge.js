(() => {
  if (globalThis.__ATS_OPAQUE_FRAME_TOP_BRIDGE__) return;
  globalThis.__ATS_OPAQUE_FRAME_TOP_BRIDGE__ = true;
  if (window !== window.top) return;

  const host = String(location.hostname || '').toLowerCase().replace(/\.$/, '');
  const casaHost = value => value === 'casatrade.com' || value.endsWith('.casatrade.com') || value === 'casatrade.io' || value.endsWith('.casatrade.io') || value === 'casatraders.online' || value.endsWith('.casatraders.online') || value === 'ivcasatraders.online' || value.endsWith('.ivcasatraders.online');
  if (!casaHost(host)) return;
  const sendMessage = globalThis.__ATS_SEND_MESSAGE__;
  if (typeof sendMessage !== 'function') return;

  const CHILD_RELAY_SOURCE = 'ATS_OPAQUE_CHILD_RELAY_V2';
  const ALLOWED_CHILD_TYPES = new Set([
    'ATS_VISUAL_FOCUS_V2','ATS_MARKET_CLOCK_V2','ATS_EMBEDDED_FEED',
    'ATS_CHART_FRAME_MARKET','ATS_DATA_INSPECTOR','ATS_ACCOUNT_METRICS',
    'ATS_PLATFORM_CONTROLS_OBSERVED'
  ]);

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== 'ATS_OPAQUE_FRAME_FORWARD' || !message.payload || typeof message.payload !== 'object') return false;
    sendMessage(message.payload).then(response => sendResponse(response || { ok: true })).catch(() => sendResponse({ ok: false }));
    return true;
  });

  window.addEventListener('message', event => {
    const data = event.data;
    const payload = data?.source === CHILD_RELAY_SOURCE && data.payload && typeof data.payload === 'object' ? data.payload : null;
    if (!payload?.type || !ALLOWED_CHILD_TYPES.has(payload.type)) return;
    // The top-frame content script becomes the authenticated runtime sender,
    // avoiding Android forks that omit sender.tab for opaque child frames.
    sendMessage(payload).catch(() => {});
  });
})();
