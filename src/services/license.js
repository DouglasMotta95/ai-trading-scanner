import { installationId, saveClientToken, clearClientToken } from './telemetry.js';

const LICENSE_KEY = 'atsLicenseKey';
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

async function call(_settings, path, payload) {
  try {
    const r = await fetch(`${base()}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, ...data };
  } catch {
    return { ok: false, error: 'backend_unreachable' };
  }
}

async function acceptSession(r, licenseKey = '') {
  if (r?.ok && r.clientToken) {
    await saveClientToken(r.clientToken, r.clientTokenExpiresAt);
    if (licenseKey) await saveLicenseKey(licenseKey);
  }
  return r;
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
  return acceptSession(r, licenseKey);
}

export async function validateLicense(settings = {}) {
  const licenseKey = await savedLicenseKey();
  if (!licenseKey) return { ok: false, error: 'license_required' };
  const r = await call(settings, '/v1/license/validate', {
    licenseKey,
    installationId: await installationId(),
    version: chrome.runtime.getManifest().version
  });
  return acceptSession(r, licenseKey);
}

export async function consumeSignal(settings = {}) {
  const licenseKey = await savedLicenseKey();
  if (!licenseKey) return { ok: false, error: 'license_required' };
  return call(settings, '/v1/license/consume', {
    licenseKey,
    installationId: await installationId(),
    type: 'signal',
    version: chrome.runtime.getManifest().version
  });
}

export async function clearLicense() {
  await saveLicenseKey('');
  await clearClientToken();
}
