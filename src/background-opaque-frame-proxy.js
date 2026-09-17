const casaHost = value => {
  const host = String(value || '').toLowerCase().replace(/\.$/, '');
  return host === 'casatrade.com' || host.endsWith('.casatrade.com') || host === 'casatrade.io' || host.endsWith('.casatrade.io');
};

const opaqueUrl = value => /^(?:blob:|about:|data:)/i.test(String(value || ''));
const ALLOWED_TYPES = new Set([
  'ATS_VISUAL_FOCUS_V2',
  'ATS_MARKET_CLOCK_V2',
  'ATS_EMBEDDED_FEED',
  'ATS_PLATFORM_CONTROLS_OBSERVED',
  'ATS_CHART_FRAME_MARKET',
  'ATS_DATA_INSPECTOR',
  'ATS_ACCOUNT_METRICS'
]);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const wrapped = message?.type === 'ATS_OPAQUE_FRAME_PROXY';
  const payload = wrapped
    ? (message.payload && typeof message.payload === 'object' ? message.payload : null)
    : (message && typeof message === 'object' && ALLOWED_TYPES.has(message.type) ? message : null);
  if (!payload || !ALLOWED_TYPES.has(payload.type)) return false;

  const tabId = sender.tab?.id;
  const frameId = Number(sender.frameId);
  let topHost = '';
  try { topHost = new URL(sender.tab?.url || '').hostname; } catch {}
  const senderUrl = String(sender.url || '');
  const senderOpaque = opaqueUrl(senderUrl) || !senderUrl || String(sender.origin || '') === 'null';

  if (!tabId || !Number.isInteger(frameId) || !casaHost(topHost) || !senderOpaque) {
    if (wrapped) sendResponse({ ok: false, ignored: true });
    return false;
  }

  chrome.tabs.sendMessage(tabId, { type: 'ATS_OPAQUE_FRAME_FORWARD', payload }, { frameId: 0 }, response => {
    try { void chrome.runtime.lastError; } catch {}
    sendResponse(response || { ok: true, proxied: true });
  });
  return true;
});
