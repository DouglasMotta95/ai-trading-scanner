import { updateScannerState } from './services/scanner-state-atomic.js';

const ownerDev = !chrome.runtime.getManifest().update_url;
const DEV_LICENSE = Object.freeze({
  status: 'active',
  plan: 'OWNER_DEV',
  planLabel: 'DEV OWNER',
  dailyLimit: null,
  usedToday: 0,
  remainingToday: null,
  totalLimit: null,
  usedTotal: 0,
  remainingTotal: null,
  error: null,
  syncPending: false,
  devMode: true
});

let applying = false;
async function ensureOwnerDev() {
  if (!ownerDev || applying) return;
  applying = true;
  try {
    await updateScannerState(state => {
      const active = ['active', 'valid'].includes(String(state?.license?.status || '').toLowerCase());
      const alreadyOwner = active && (state.license?.devMode === true || state.license?.plan === 'OWNER_DEV');
      if (alreadyOwner && state.diagnostics?.access?.state === 'owner_dev') return state;
      return {
        ...state,
        license: { ...DEV_LICENSE },
        diagnostics: {
          ...(state.diagnostics || {}),
          access: { state: 'owner_dev', ownerDev: true, at: Date.now() }
        }
      };
    });
  } finally {
    applying = false;
  }
}

if (ownerDev) {
  ensureOwnerDev().catch(() => {});
  chrome.storage?.onChanged?.addListener?.((changes, area) => {
    if (area !== 'local' || !changes.scannerState?.newValue) return;
    const state = changes.scannerState.newValue || {};
    const active = ['active', 'valid'].includes(String(state?.license?.status || '').toLowerCase());
    if (!active || (state.license?.devMode !== true && state.license?.plan !== 'OWNER_DEV')) {
      ensureOwnerDev().catch(() => {});
    }
  });
}
