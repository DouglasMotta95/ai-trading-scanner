import { updateScannerState } from './services/scanner-state-atomic.js';

// Security migration: older builds could mint OWNER_DEV from local storage.
// Customer ZIPs are unpacked and user-modifiable, so owner access is never
// granted locally. Testing/owner access must come from a server-issued license.
async function removeLegacyOwnerBypass() {
  await updateScannerState(state => {
    const access = state.diagnostics?.access || {};
    const legacyOwner = state.license?.devMode === true
      || String(state.license?.plan || '').toUpperCase() === 'OWNER_DEV'
      || access.ownerDev === true
      || access.state === 'owner_dev';
    if (!legacyOwner) return state;
    return {
      ...state,
      license: {
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
      },
      diagnostics: {
        ...(state.diagnostics || {}),
        access: { ...access, state: 'license_required', ownerDev: false, at: Date.now() }
      }
    };
  });
}

removeLegacyOwnerBypass().catch(() => {});
