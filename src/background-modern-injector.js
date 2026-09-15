async function inject(tabId) {
  if (!tabId || !chrome.scripting?.executeScript) return false;
  const isolated = [
    'src/content/runtime-message-compat.js',
    'src/content/device-anchor.js',
    'src/content/focused-asset-protocol.js',
    'src/content/focused-asset-v2.js',
    'src/content/chart-frame-market-reader.js',
    'src/content/embedded-feed-bridge.js',
    'src/content/platform-sync.js',
    'src/content/market-cycle-clock-v4.js',
    'src/content/casatrade-data-inspector.js',
    'src/content/analysis-visual-overlay-v2.js',
    'src/content/manual-trade-observer.js',
    'src/content/account-metrics-observer.js',
    'src/content/trade-handoff-v2.js'
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
  return true;
}

// Manifest content scripts own normal page-load injection. This hook exists only so
// background-control can hydrate an already-open CasaTrade tab after an extension
// reload without registering a second set of tab/message listeners.
globalThis.__ATS_INJECT_MODERN_PIPELINE__ = inject;
