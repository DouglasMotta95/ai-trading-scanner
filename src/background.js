const DEFAULT_STATE = {
  connection: 'offline',
  scanner: 'idle',
  platform: null,
  asset: null,
  timeframe: null,
  price: null,
  lastSeen: null
};

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.storage.local.set({ scannerState: DEFAULT_STATE });
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'ATS_PLATFORM_SNAPSHOT') {
    const snapshot = message.payload || {};
    chrome.storage.local.get('scannerState').then(({ scannerState }) => {
      const next = {
        ...DEFAULT_STATE,
        ...scannerState,
        ...snapshot,
        connection: 'online',
        platform: 'CasaTrade',
        lastSeen: Date.now()
      };
      return chrome.storage.local.set({ scannerState: next });
    }).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message?.type === 'ATS_GET_STATE') {
    chrome.storage.local.get('scannerState').then(({ scannerState }) => {
      sendResponse(scannerState || DEFAULT_STATE);
    });
    return true;
  }

  if (message?.type === 'ATS_SET_SCANNER') {
    chrome.storage.local.get('scannerState').then(({ scannerState }) => {
      const next = { ...DEFAULT_STATE, ...scannerState, scanner: message.enabled ? 'scanning' : 'idle' };
      return chrome.storage.local.set({ scannerState: next }).then(() => sendResponse(next));
    });
    return true;
  }
});
