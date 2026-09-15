import { storageLocalGet, storageLocalSet } from './services/chrome-compat.js';
import { mergeRadarSnapshot, topRadarRows, marketId } from './core/asset-radar.js';

const KEY = 'atsAssetRadarV1';
let cached = { rows: [], updatedAt: 0 };
let loaded = false;
let writeChain = Promise.resolve();

async function ensureLoaded() {
  if (loaded) return cached;
  const stored = await storageLocalGet(KEY).catch(() => ({}));
  const value = stored?.[KEY];
  if (value && typeof value === 'object') cached = { rows: Array.isArray(value.rows) ? value.rows : [], updatedAt: Number(value.updatedAt || 0), note: value.note || '' };
  loaded = true;
  return cached;
}

async function focusedAsset() {
  const stored = await storageLocalGet('scannerState').catch(() => ({}));
  return stored?.scannerState?.diagnostics?.focusedAsset?.asset || stored?.scannerState?.asset || '';
}

async function ingest(payload = {}) {
  const previous = await ensureLoaded();
  const focus = await focusedAsset();
  const next = mergeRadarSnapshot(previous, payload, focus, Date.now());
  cached = next;
  await storageLocalSet({ [KEY]: next });
}

function schedule(payload = {}) {
  writeChain = writeChain.then(() => ingest(payload)).catch(() => {});
}

chrome.storage.onChanged.addListener(changes => {
  if (changes[KEY]?.newValue) {
    const value = changes[KEY].newValue;
    cached = { rows: Array.isArray(value.rows) ? value.rows : [], updatedAt: Number(value.updatedAt || 0), note: value.note || '' };
    loaded = true;
  }
  if (!changes.scannerState) return;
  const state = changes.scannerState.newValue || {};
  const focus = state.diagnostics?.focusedAsset?.asset || state.asset || '';
  if (!focus || !loaded) return;
  const focusId = marketId(focus);
  const rows = (cached.rows || []).map(row => ({ ...row, focused: !!focusId && marketId(row.asset) === focusId }));
  if (JSON.stringify(rows.map(row => [row.asset, row.focused])) === JSON.stringify((cached.rows || []).map(row => [row.asset, row.focused]))) return;
  cached = { ...cached, rows, updatedAt: Date.now() };
  storageLocalSet({ [KEY]: cached }).catch(() => {});
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'ATS_EMBEDDED_FEED') {
    schedule(message.payload || {});
    return false;
  }
  if (message?.type !== 'ATS_GET_ASSET_RADAR') return false;
  ensureLoaded().then(snapshot => sendResponse({ ok: true, snapshot: { ...snapshot, rows: topRadarRows(snapshot, 8) } }))
    .catch(error => sendResponse({ ok: false, error: String(error?.message || error) }));
  return true;
});
