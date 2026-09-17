const isCasaTradeUrl = value => {
  try {
    const host = new URL(value || '').hostname.toLowerCase().replace(/\.$/, '');
    return host === 'casatrade.com' || host.endsWith('.casatrade.com') || host === 'casatrade.io' || host.endsWith('.casatrade.io');
  } catch { return false; }
};

async function inject(tabId) {
  if (!tabId) return;
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    files: ['src/content/frame-feed-relay.js'],
    world: 'ISOLATED'
  }).catch(() => {});
}

async function injectOpenCasaTradeTabs() {
  const tabs = await chrome.tabs.query({}).catch(() => []);
  await Promise.all((tabs || []).filter(tab => tab?.id && isCasaTradeUrl(tab.url)).map(tab => inject(tab.id)));
}

injectOpenCasaTradeTabs().catch(() => {});
chrome.runtime.onInstalled.addListener(() => injectOpenCasaTradeTabs().catch(() => {}));
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if ((changeInfo.status === 'complete' || changeInfo.url) && isCasaTradeUrl(tab?.url || changeInfo.url)) inject(tabId).catch(() => {});
});
