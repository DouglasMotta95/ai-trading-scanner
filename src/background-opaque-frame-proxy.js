const casaHost = value => {
  const host = String(value || '').toLowerCase().replace(/\.$/, '');
  return host === 'casatrade.com' || host.endsWith('.casatrade.com') || host === 'casatrade.io' || host.endsWith('.casatrade.io') || host === 'casatraders.online' || host.endsWith('.casatraders.online') || host === 'ivcasatraders.online' || host.endsWith('.ivcasatraders.online');
};

const opaqueUrl = value => /^(?:blob:|about:|data:)/i.test(String(value || ''));
const ALLOWED_TYPES = new Set([
  'ATS_VISUAL_FOCUS_V2',
  'ATS_MARKET_CLOCK_V2',
  'ATS_EMBEDDED_FEED',
  'ATS_CHART_FRAME_MARKET',
  'ATS_DATA_INSPECTOR',
  'ATS_ACCOUNT_METRICS',
  'ATS_PLATFORM_CONTROLS_OBSERVED'
]);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'ATS_OPAQUE_FRAME_PROXY') return false;
  const tabId = sender.tab?.id;
  const frameId = Number(sender.frameId);
  let topHost = '';
  try { topHost = new URL(sender.tab?.url || '').hostname; } catch {}
  const senderUrl = String(sender.url || '');
  const senderOpaque = opaqueUrl(senderUrl) || !senderUrl || String(sender.origin || '') === 'null';
  const payload = message.payload && typeof message.payload === 'object' ? message.payload : null;

  // Some Android Chromium forks report an opaque child frame with frameId 0 or
  // omit sender.url entirely. A normal CasaTrade top frame still has an https URL,
  // so only an opaque/missing sender URL can use this recovery path.
  if (!tabId || !Number.isInteger(frameId) || !casaHost(topHost) || !senderOpaque || !payload || !ALLOWED_TYPES.has(payload.type)) {
    sendResponse({ ok: false, ignored: true });
    return false;
  }

  chrome.tabs.sendMessage(tabId, { type: 'ATS_OPAQUE_FRAME_FORWARD', payload }, { frameId: 0 }, response => {
    try { void chrome.runtime.lastError; } catch {}
    sendResponse(response || { ok: true });
  });
  return true;
});
