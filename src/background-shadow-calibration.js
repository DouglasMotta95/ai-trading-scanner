import { storageLocalGet, storageLocalSet } from './services/chrome-compat.js';
import { shadowRecordFromState, mergeShadowRecord, resolveShadowRows, shadowMetrics } from './core/shadow-calibration.js';

const KEY = 'atsShadowCalibrationV1';
let busy = false;
let queuedState = null;

async function processState(state = {}) {
  const stored = await storageLocalGet(KEY);
  const previous = stored[KEY] && typeof stored[KEY] === 'object' ? stored[KEY] : { rows: [], metrics: {} };
  let rows = Array.isArray(previous.rows) ? previous.rows : [];
  const record = shadowRecordFromState(state);
  if (record) rows = mergeShadowRecord(rows, record, 500);
  const resolution = resolveShadowRows(rows, state);
  rows = resolution.rows.slice(-500);
  const metrics = shadowMetrics(rows);
  const next = { rows, metrics, updatedAt: Date.now() };
  const changed = JSON.stringify(previous.rows || []) !== JSON.stringify(rows)
    || JSON.stringify(previous.metrics || {}) !== JSON.stringify(metrics);
  if (changed) await storageLocalSet({ [KEY]: next });
}

async function drain() {
  if (busy) return;
  busy = true;
  try {
    while (queuedState) {
      const state = queuedState;
      queuedState = null;
      await processState(state).catch(() => {});
    }
  } finally { busy = false; }
}

chrome.storage.onChanged.addListener(changes => {
  if (!changes.scannerState) return;
  queuedState = changes.scannerState.newValue || {};
  setTimeout(() => drain().catch(() => {}), 0);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'ATS_GET_SHADOW_CALIBRATION') return false;
  storageLocalGet(KEY).then(stored => {
    const data = stored[KEY] || { rows: [], metrics: shadowMetrics([]) };
    sendResponse({ ok: true, metrics: data.metrics || shadowMetrics(data.rows || []), rows: Array.isArray(data.rows) ? data.rows.slice(-100) : [] });
  }).catch(error => sendResponse({ ok: false, error: String(error?.message || error) }));
  return true;
});
