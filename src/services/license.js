import { storageLocalGet, storageLocalSet, storageLocalRemove } from './chrome-compat.js';
import { installationId, saveClientToken, clearClientToken } from './telemetry.js';

const LICENSE_KEY = 'atsLicenseKey';
const LAST_VALID_LICENSE_KEY = 'atsLastValidLicense';
const REQUEST_TIMEOUT_MS = 8000;
const REOPEN_CACHE_GRACE_MS = 5 * 60 * 1000;

const AUTHORITATIVE_LICENSE_ERRORS = new Set([
  'license_not_found',
  'license_inactive',
  'license_expired',
  'device_limit_reached'
]);

export const PUBLIC_LICENSE_API = 'https://ats-control-center-v07-production.up.railway.app';
const base = () => PUBLIC_LICENSE_API;
const normalizedError = error => String(error || '');

export const isDevBuild = () => !chrome.runtime.getManifest().update_url;
export const ownerDevMode = (settings = {}) => isDevBuild() && settings?.testLicenseBlock !== true;
export const devOwnerLicense = () => ({
  status: 'active',
  plan: 'OWNER_DEV',
  planLabel: 'DEV OWNER',
  dailyLimit: null, usedToday: 0, remainingToday: null,
  totalLimit: null, usedTotal: 0, remainingTotal: null,
  error: null, syncPending: false, devMode: true
});
export const licenseRequired = (settings = {}) => !ownerDevMode(settings);

export async function savedLicenseKey() {
  const x = await storageLocalGet(LICENSE_KEY);
  return String(x[LICENSE_KEY] || '').trim();
}

export async function saveLicenseKey(key = '') {
  key = String(key || '').trim();
  await storageLocalSet({ [LICENSE_KEY]: key });
  return key;
}

function expiryMs(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number' || /^\d+(?:\.\d+)?$/.test(String(value).trim())) {
    let n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return null;
    if (n < 1e12) n *= 1000;
    return n;
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeActiveLicense(license = {}) {
  const status = String(license?.status || '').toLowerCase();
  return { ...license, status: status === 'active' || status === 'valid' ? 'active' : license?.status };
}

function licenseStillValid(license = {}) {
  const normalized = normalizeActiveLicense(license);
  if (normalized?.status !== 'active') return false;
  if (!normalized.expiresAt) return true;
  const expiresAt = expiryMs(normalized.expiresAt);
  return expiresAt != null && expiresAt > Date.now();
}

function cacheInsideReopenGrace(cached = null) {
  const validatedAt = Number(cached?.validatedAt);
  if (!Number.isFinite(validatedAt) || validatedAt <= 0) return false;
  const age = Date.now() - validatedAt;
  return age >= 0 && age <= REOPEN_CACHE_GRACE_MS;
}

function cachedResponse(cached, { syncPending = false, error = null } = {}) {
  if (!cached?.license || !licenseStillValid(cached.license)) return null;
  const normalized = normalizedError(error);
  return {
    ok: true, cacheHit: true, offlineFallback: !!syncPending, error: normalized || null,
    license: { ...normalizeActiveLicense(cached.license), status: 'active', error: normalized || null, syncPending: !!syncPending },
    clientTokenExpiresAt: Number(cached.clientTokenExpiresAt) || 0
  };
}

export async function cachedLicenseSession() {
  const x = await storageLocalGet(LAST_VALID_LICENSE_KEY);
  const cached = x[LAST_VALID_LICENSE_KEY];
  if (!cached?.license || !licenseStillValid(cached.license)) {
    if (cached) await storageLocalRemove(LAST_VALID_LICENSE_KEY);
    return null;
  }
  const licenseKey = String(cached.licenseKey || cached.license?.key || '').trim();
  return { ...cached, license: normalizeActiveLicense(cached.license), licenseKey };
}

export async function restoreCachedLicense() {
  const cached = await cachedLicenseSession();
  if (!cached) return null;
  const currentKey = await savedLicenseKey();
  if (!currentKey && cached.licenseKey) await storageLocalSet({ [LICENSE_KEY]: cached.licenseKey });
  return { ...cached.license, status: 'active', error: null, syncPending: false };
}

async function saveValidLicenseSession(r, licenseKey = '') {
  if (!r?.ok) return null;
  const license = normalizeActiveLicense(r.license || {});
  if (!licenseStillValid(license)) return null;
  const resolvedKey = String(licenseKey || license?.key || '').trim();
  const snapshot = {
    license: { ...license, status: 'active', error: null, syncPending: false },
    licenseKey: resolvedKey,
    clientTokenExpiresAt: Number(r.clientTokenExpiresAt) || 0,
    validatedAt: Date.now()
  };
  const values = { [LAST_VALID_LICENSE_KEY]: snapshot };
  if (resolvedKey) values[LICENSE_KEY] = resolvedKey;
  await storageLocalSet(values);
  return snapshot;
}

async function invalidateCachedLicense(r, licenseKey = '') {
  const error = normalizedError(r?.error);
  if (!AUTHORITATIVE_LICENSE_ERRORS.has(error)) return false;
  const cached = await cachedLicenseSession();
  const attempted = String(licenseKey || '').trim().toUpperCase();
  const cachedKey = String(cached?.licenseKey || '').trim().toUpperCase();
  if (attempted && cachedKey && attempted !== cachedKey) return false;
  await storageLocalRemove(LAST_VALID_LICENSE_KEY);
  await clearClientToken();
  return true;
}

async function call(_settings, path, payload) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const r = await fetch(`${base()}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: controller.signal
    });
    const data = await r.json().catch(() => ({}));
    const error = normalizedError(data?.error);
    return { ok: r.ok, status: r.status, ...data, ...(error ? { error } : {}) };
  } catch {
    return { ok: false, error: 'backend_unreachable' };
  } finally {
    clearTimeout(timeout);
  }
}

async function acceptSession(r, licenseKey = '') {
  if (!r?.ok) return r;
  const normalized = { ...r, license: normalizeActiveLicense(r.license || {}) };
  if (!licenseStillValid(normalized.license)) return normalized;
  const resolvedKey = String(licenseKey || normalized.license?.key || '').trim();
  if (normalized.clientToken) await saveClientToken(normalized.clientToken, normalized.clientTokenExpiresAt);
  await saveValidLicenseSession(normalized, resolvedKey);
  return normalized;
}

async function withCachedFallback(r, cached = null) {
  if (r?.ok) return r;
  const error = normalizedError(r?.error);
  if (AUTHORITATIVE_LICENSE_ERRORS.has(error)) return { ...r, error };
  if (!cached) cached = await cachedLicenseSession();
  if (!cached) return r;
  return cachedResponse(cached, { syncPending: true, error: error || 'backend_unreachable' }) || r;
}

export async function activateLicense(settings = {}, key = '') {
  const installationIdValue = await installationId();
  const licenseKey = String(key || '').trim();
  if (!licenseKey) return { ok: false, error: 'license_required' };
  const r = await call(settings, '/v1/license/activate', {
    licenseKey, installationId: installationIdValue, version: chrome.runtime.getManifest().version
  });
  if (r.ok) return acceptSession(r, licenseKey);
  await invalidateCachedLicense(r, licenseKey);
  return r;
}

export async function validateLicense(settings = {}) {
  // Unpacked diagnostic/development builds are the owner's workbench.
  // Customer/release builds still require the normal server-backed license.
  if (ownerDevMode(settings)) return { ok: true, devMode: true, license: devOwnerLicense() };

  const cached = await cachedLicenseSession();
  let licenseKey = await savedLicenseKey();
  if (!licenseKey && cached?.licenseKey) licenseKey = await saveLicenseKey(cached.licenseKey);
  if (cached && cacheInsideReopenGrace(cached)) return cachedResponse(cached);
  if (!licenseKey) return { ok: false, error: 'license_required' };

  const r = await call(settings, '/v1/license/validate', {
    licenseKey, installationId: await installationId(), version: chrome.runtime.getManifest().version
  });
  if (r.ok) return acceptSession(r, licenseKey);

  const error = normalizedError(r?.error);
  if (AUTHORITATIVE_LICENSE_ERRORS.has(error)) {
    await invalidateCachedLicense({ ...r, error }, licenseKey);
    return { ...r, error };
  }
  return withCachedFallback(r, cached);
}

export async function consumeSignal(settings = {}) {
  const cached = await cachedLicenseSession();
  let licenseKey = await savedLicenseKey();
  if (!licenseKey && cached?.licenseKey) licenseKey = await saveLicenseKey(cached.licenseKey);
  if (!licenseKey) return { ok: false, error: 'license_required' };
  const r = await call(settings, '/v1/license/consume', {
    licenseKey, installationId: await installationId(), type: 'signal', version: chrome.runtime.getManifest().version
  });
  if (r.ok && r.license) await saveValidLicenseSession({ ...r, ok: true, license: normalizeActiveLicense(r.license) }, licenseKey);
  return r;
}

export async function clearLicense() {
  await storageLocalRemove([LICENSE_KEY, LAST_VALID_LICENSE_KEY]);
  await clearClientToken();
}