(() => {
  if (globalThis.__ATS_OPAQUE_FRAME_TOP_BRIDGE__) return;
  globalThis.__ATS_OPAQUE_FRAME_TOP_BRIDGE__ = true;
  if (window !== window.top) return;

  const host = String(location.hostname || '').toLowerCase().replace(/\.$/, '');
  const casaHost = value => value === 'casatrade.com' || value.endsWith('.casatrade.com') || value === 'casatrade.io' || value.endsWith('.casatrade.io');
  if (!casaHost(host)) return;
  const sendMessage = globalThis.__ATS_SEND_MESSAGE__;
  if (typeof sendMessage !== 'function') return;

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== 'ATS_OPAQUE_FRAME_FORWARD' || !message.payload || typeof message.payload !== 'object') return false;
    sendMessage(message.payload).then(response => sendResponse(response || { ok: true })).catch(() => sendResponse({ ok: false }));
    return true;
  });
})();
