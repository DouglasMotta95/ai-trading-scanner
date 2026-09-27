import { storageLocalGet, storageLocalSet } from './services/chrome-compat.js';
import { shadowRecordFromState, mergeShadowRecord, resolveShadowRows, shadowMetrics } from './core/shadow-calibration.js';

const KEY = 'atsShadowCalibrationV1';
const PROCESS_DELAY_MS = 500;
let busy = false;
let queuedState = null;
let timer = null;
let cacheLoaded = false;
let cached = { rows: [], metrics: shadowMetrics([]), updatedAt: 0 };

async function ensureCache() {
  if (cacheLoaded) return cached;
  const stored = await storageLocalGet(KEY).catch(() => ({}));
  const value = stored?.[KEY];
  if (value && typeof value === 'object') {
    cached = {
      rows: Array.isArray(value.rows) ? value.rows.slice(-500) : [],
      metrics: value.metrics || shadowMetrics(value.rows || []),
      updatedAt: Number(value.updatedAt || 0)
    };
  }
  cacheLoaded = true;
  return cached;
}

async function processState(state = {}) {
  const previous = await ensureCache();
  let rows = Array.isArray(previous.rows) ? previous.rows : [];
  const record = shadowRecordFromState(state);
  if (record) rows = mergeShadowRecord(rows, record, 500);
  rows = resolveShadowRows(rows, state).rows.slice(-500);
  const metrics = shadowMetrics(rows);
  const changed = JSON.stringify(previous.rows || []) !== JSON.stringify(rows)
    || JSON.stringify(previous.metrics || {}) !== JSON.stringify(metrics);
  if (!changed) return;
  cached = { rows, metrics, updatedAt: Date.now() };
  await storageLocalSet({ [KEY]: cached });
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

function schedule(state) {
  queuedState = state || {};
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    drain().catch(() => {});
  }, PROCESS_DELAY_MS);
}

chrome.storage.onChanged.addListener(changes => {
  if (changes[KEY]) {
    const value = changes[KEY].newValue;
    if (value && typeof value === 'object') {
      cached = {
        rows: Array.isArray(value.rows) ? value.rows.slice(-500) : [],
        metrics: value.metrics || shadowMetrics(value.rows || []),
        updatedAt: Number(value.updatedAt || 0)
      };
      cacheLoaded = true;
    }
  }
  if (changes.scannerState) schedule(changes.scannerState.newValue || {});
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'ATS_GET_SHADOW_CALIBRATION') return false;
  ensureCache().then(data => {
    sendResponse({
      ok: true,
      metrics: data.metrics || shadowMetrics(data.rows || []),
      rows: Array.isArray(data.rows) ? data.rows.slice(-100) : []
    });
  }).catch(error => sendResponse({ ok: false, error: String(error?.message || error) }));
  return true;
});
