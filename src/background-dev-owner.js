import { updateScannerState } from './services/scanner-state-atomic.js';
import { storageLocalGet } from './services/chrome-compat.js';

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
const EMPTY_LICENSE = Object.freeze({
  status: 'unconfigured',
  plan: null,
  planLabel: null,
  dailyLimit: null,
  usedToday: 0,
  remainingToday: null,
  totalLimit: null,
  usedTotal: 0,
  remainingTotal: null,
  error: 'license_required',
  syncPending: false,
  devMode: false
});

let applying = false;

async function ownerDevEnabled() {
  const { settings = {} } = await storageLocalGet('settings').catch(() => ({}));
  return settings?.ownerDevMode === true && settings?.testLicenseBlock !== true;
}

async function reconcileOwnerDev() {
  if (applying) return;
  applying = true;
  try {
    const enabled = await ownerDevEnabled();
    await updateScannerState(state => {
      const access = state.diagnostics?.access || {};
      const isOwner = state.license?.devMode === true || String(state.license?.plan || '').toUpperCase() === 'OWNER_DEV';
      const activeReal = ['active', 'valid'].includes(String(state.license?.status || '').toLowerCase()) && !isOwner;

      if (enabled) {
        if (isOwner && access.ownerDev === true && access.state === 'owner_dev') return state;
        return {
          ...state,
          license: { ...DEV_LICENSE },
          diagnostics: {
            ...(state.diagnostics || {}),
            access: { state: 'owner_dev', ownerDev: true, at: Date.now() }
          }
        };
      }

      if (!isOwner && access.ownerDev !== true && access.state !== 'owner_dev') return state;
      return {
        ...state,
        license: isOwner ? { ...EMPTY_LICENSE } : state.license,
        diagnostics: {
          ...(state.diagnostics || {}),
          access: {
            ...access,
            state: activeReal ? 'licensed' : 'license_required',
            ownerDev: false,
            at: Date.now()
          }
        }
      };
    });
  } finally {
    applying = false;
  }
}

reconcileOwnerDev().catch(() => {});
chrome.storage?.onChanged?.addListener?.((changes, area) => {
  if (area !== 'local') return;
  if (changes.settings || changes.scannerState) reconcileOwnerDev().catch(() => {});
});
