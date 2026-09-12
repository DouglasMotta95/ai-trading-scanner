import { installationId, saveClientToken, clearClientToken } from './telemetry.js';

const LICENSE_KEY = 'atsLicenseKey';
const LAST_VALID_LICENSE_KEY = 'atsLastValidLicense';
const REQUEST_TIMEOUT_MS = 8000;
const REOPEN_CACHE_GRACE_MS = 5 * 60 * 1000;

// Only errors that conclusively invalidate the license itself may erase the last
// known-good local session. Request/protocol errors, temporary quota errors and
// backend outages must never make a previously active license disappear.
const AUTHORITATIVE_LICENSE_ERRORS = new Set([
  'license_not_found',
  'license_inactive',
  'license_expired',
  'device_locked',
  'device_limit_reached'
]);

export const PUBLIC_LICENSE_API = 'https://ats-control-center-v07-production.up.railway.app';

// Commercial builds must never trust an endpoint supplied by local settings.
// This prevents a copied extension from pointing licensing at a fake server.
const base = () => PUBLIC_LICENSE_API;

export const isDevBuild = () => !chrome.runtime.getManifest().update_url;

// Licensing is mandatory for every distributed/sideloaded build.
// Local testing should use an ATS account/trial/test license instead of bypassing validation.
export const licenseRequired = () => true;

export async function savedLicenseKey() {
  const x = await chrome.storage.local.get(LICENSE_KEY);
  return String(x[LICENSE_KEY] || '').trim();
}

export async function saveLicenseKey(key = '') {
  key = String(key || '').trim();
  await chrome.storage.local.set({ [LICENSE_KEY]: key });
  return key;
}

function licenseStillValid(license = {}) {
  if (license?.status !== 'active') return false;
  if (!license.expiresAt) return true;
  const expiresAt = Date.parse(license.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt > Date.now();
}

function cachedResponse(cached, { syncPending = false, error = null } = {}) {
  if (!cached?.license || !licenseStillValid(cached.license)) return null;
  return {
    ok: true,
    cacheHit: true,
    offlineFallback: !!syncPending,
    error,
    license: {
      ...cached.license,
      status: 'active',
      error,
      syncPending: !!syncPending
    },
    clientTokenExpiresAt: Number(cached.clientTokenExpiresAt) || 0
  };
}

export async function cachedLicenseSession() {
  const x = await chrome.storage.local.get(LAST_VALID_LICENSE_KEY);
  const cached = x[LAST_VALID_LICENSE_KEY];
  if (!cached?.license || !licenseStillValid(cached.license)) {
    if (cached) await chrome.storage.local.remove(LAST_VALID_LICENSE_KEY);
    return null;
  }
  const licenseKey = String(cached.licenseKey || cached.license?.key || '').trim();
  return { ...cached, licenseKey };
}

export async function restoreCachedLicense() {
  const cached = await cachedLicenseSession();
  if (!cached) return null;
  const currentKey = await savedLicenseKey();
  if (!currentKey && cached.licenseKey) await saveLicenseKey(cached.licenseKey);
  return {
    ...cached.license,
    status: 'active',
    error: null,
    syncPending: false
  };
}

async function saveValidLicenseSession(r, licenseKey = '') {
  if (!r?.ok || !licenseStillValid(r.license)) return null;
  const resolvedKey = String(licenseKey || r.license?.key || '').trim();
  const snapshot = {
    license: { ...r.license, error: null, syncPending: false },
    licenseKey: resolvedKey,
    clientTokenExpiresAt: Number(r.clientTokenExpiresAt) || 0,
    validatedAt: Date.now()
  };
  await chrome.storage.local.set({ [LAST_VALID_LICENSE_KEY]: snapshot });
  if (resolvedKey) await saveLicenseKey(resolvedKey);
  return snapshot;
}

async function invalidateCachedLicense(r, licenseKey = '') {
  if (!AUTHORITATIVE_LICENSE_ERRORS.has(String(r?.error || ''))) return false;
  const cached = await cachedLicenseSession();
  const attempted = String(licenseKey || '').trim().toUpperCase();
  const cachedKey = String(cached?.licenseKey || '').trim().toUpperCase();
  if (attempted && cachedKey && attempted !== cachedKey) return false;
  await chrome.storage.local.remove(LAST_VALID_LICENSE_KEY);
  await clearClientToken();
  return true;
}

async function call(_settings, path, payload) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const r = await fetch(`${base()}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    const data = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, ...data };
  } catch {
    return { ok: false, error: 'backend_unreachable' };
  } finally {
    clearTimeout(timeout);
  }
}

async function acceptSession(r, licenseKey = '') {
  if (!r?.ok || !licenseStillValid(r.license)) return r;
  const resolvedKey = String(licenseKey || r.license?.key || '').trim();
  if (r.clientToken) await saveClientToken(r.clientToken, r.clientTokenExpiresAt);
  await saveValidLicenseSession(r, resolvedKey);
  return r;
}

async function withCachedFallback(r, cached = null) {
  if (r?.ok) return r;
  if (AUTHORITATIVE_LICENSE_ERRORS.has(String(r?.error || ''))) return r;
  cached ||= await cachedLicenseSession();
  if (!cached) return r;
  return cachedResponse(cached, { syncPending: true, error: r?.error || 'backend_unreachable' }) || r;
}

export async function activateLicense(settings = {}, key = '') {
  const installationIdValue = await installationId();
  const licenseKey = String(key || '').trim();
  if (!licenseKey) return { ok: false, error: 'license_required' };
  const r = await call(settings, '/v1/license/activate', {
    licenseKey,
    installationId: installationIdValue,
    version: chrome.runtime.getManifest().version
  });
  if (r.ok) return acceptSession(r, licenseKey);
  await invalidateCachedLicense(r, licenseKey);
  return r;
}

export async function validateLicense(settings = {}) {
  // Cache-first is intentional. Reopening the side panel must restore the last
  // valid local session before any network validation is allowed to change UI state.
  const cached = await cachedLicenseSession();
  let licenseKey = await savedLicenseKey();
  if (!licenseKey && cached?.licenseKey) {
    licenseKey = await saveLicenseKey(cached.licenseKey);
  }

  if (!licenseKey) {
    return cached
      ? cachedResponse(cached, { syncPending: true, error: 'license_key_recovered' })
      : { ok: false, error: 'license_required' };
  }

  // A just-validated session is authoritative enough for the reopen path. This
  // prevents close/reopen races from replacing an active UI with activation state.
  const validatedAt = Number(cached?.validatedAt) || 0;
  if (cached && validatedAt > 0 && Date.now() - validatedAt < REOPEN_CACHE_GRACE_MS) {
    return cachedResponse(cached);
  }

  const r = await call(settings, '/v1/license/validate', {
    licenseKey,
    installationId: await installationId(),
    version: chrome.runtime.getManifest().version
  });
  if (r.ok) return acceptSession(r, licenseKey);

  if (AUTHORITATIVE_LICENSE_ERRORS.has(String(r?.error || ''))) {
    await invalidateCachedLicense(r, licenseKey);
    return r;
  }

  // Malformed requests, quota responses and temporary backend/protocol failures
  // do not revoke a license. Keep the last server-validated session visible.
  return withCachedFallback(r, cached);
}

export async function consumeSignal(settings = {}) {
  const cached = await cachedLicenseSession();
  let licenseKey = await savedLicenseKey();
  if (!licenseKey && cached?.licenseKey) licenseKey = await saveLicenseKey(cached.licenseKey);
  if (!licenseKey) return { ok: false, error: 'license_required' };
  const r = await call(settings, '/v1/license/consume', {
    licenseKey,
    installationId: await installationId(),
    type: 'signal',
    version: chrome.runtime.getManifest().version
  });
  if (r.ok && r.license) {
    await saveValidLicenseSession({ ...r, ok: true }, licenseKey);
  }
  return r;
}

export async function clearLicense() {
  await saveLicenseKey('');
  await chrome.storage.local.remove(LAST_VALID_LICENSE_KEY);
  await clearClientToken();
}
