import { storageLocalGet, storageLocalSet } from './services/chrome-compat.js';
import { updateScannerState } from './services/scanner-state-atomic.js';

const BUILD_KEY = 'atsLoadedBuildVersion';

(async () => {
  const version = chrome.runtime.getManifest().version;
  const stored = await storageLocalGet(BUILD_KEY).catch(() => ({}));
  const previousVersion = String(stored?.[BUILD_KEY] || '');
  if (previousVersion === version) return;

  await updateScannerState(state => ({
    ...state,
    connection: 'offline',
    platformId: null,
    platformName: null,
    targetTabId: null,
    asset: null,
    price: null,
    candles: [],
    currentCandle: null,
    signal: null,
    lastConfirmed: null,
    tradeIntent: null,
    lastSeen: null,
    timeframe: null,
    analysisTimeframe: null,
    expiration: null,
    targetExpiration: null,
    platformControls: null,
    accountMetrics: null,
    diagnostics: {
      build: { version, previousVersion: previousVersion || null, changedAt: Date.now() }
    }
  }));
  await storageLocalSet({ [BUILD_KEY]: version }).catch(() => {});
})();
