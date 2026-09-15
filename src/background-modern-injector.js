const casaHost = value => value === 'casatrade.com' || value.endsWith('.casatrade.com') || value === 'casatrade.io' || value.endsWith('.casatrade.io');

async function inject(tabId) {
  if (!tabId || !chrome.scripting?.executeScript) return;
  const isolated = [
    'src/content/device-anchor.js',
    'src/content/focused-asset-protocol.js',
    'src/content/focused-asset-v2.js',
    'src/content/chart-frame-market-reader.js',
    'src/content/embedded-feed-bridge.js',
    'src/content/platform-sync.js',
    'src/content/market-cycle-clock-v4.js',
    'src/content/casatrade-data-inspector.js',
    'src/content/analysis-visual-overlay-v2.js'
  ];
  const mainWorld = [
    'src/content/worker-probe.js',
    'src/content/canvas-probe.js',
    'src/content/network-probe.js'
  ];
  for (const file of isolated) {
    try { await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: [file], world: 'ISOLATED' }); } catch {}
  }
  for (const file of mainWorld) {
    try { await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: [file], world: 'MAIN' }); } catch {}
  }
}

function maybe(tab) {
  if (!tab?.id || !tab.url) return;
  try {
    const host = new URL(tab.url).hostname.toLowerCase();
    if (casaHost(host)) inject(tab.id).catch(() => {});
  } catch {}
}

chrome.tabs?.onActivated?.addListener(async info => {
  try { maybe(await chrome.tabs.get(info.tabId)); } catch {}
});
chrome.tabs?.onUpdated?.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' || changeInfo.url) maybe({ ...tab, id: tabId });
});
try {
  chrome.tabs?.query?.({ active: true, currentWindow: true }, tabs => maybe(tabs?.[0]));
} catch {}

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type !== 'ATS_CONNECT_ACTIVE_TAB') return false;
  const tabId = sender?.tab?.id;
  if (tabId) inject(tabId).catch(() => {});
  else {
    try { chrome.tabs?.query?.({ active: true, currentWindow: true }, tabs => maybe(tabs?.[0])); } catch {}
  }
  return false;
});
