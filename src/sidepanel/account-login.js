import { installationId } from '../services/telemetry.js';
import { storageLocalGet, storageLocalSet, storageLocalRemove, runtimeSendMessage } from '../services/chrome-compat.js';

(() => {
  if (globalThis.__ATS_ACCOUNT_LOGIN__) return;
  globalThis.__ATS_ACCOUNT_LOGIN__ = true;

  const PUBLIC_API = 'https://ats-control-center-v07-production.up.railway.app';
  const ACCOUNT_TOKEN_KEY = 'atsAccountToken';
  const ACCOUNT_EXP_KEY = 'atsAccountTokenExpiresAt';
  const LICENSE_KEY = 'atsLicenseKey';
  const LAST_VALID_LICENSE_KEY = 'atsLastValidLicense';
  const CLIENT_TOKEN_KEY = 'atsClientToken';
  const CLIENT_EXP_KEY = 'atsClientTokenExpiresAt';

  const base = () => PUBLIC_API;

  async function clearAccountSession() {
    await storageLocalRemove([ACCOUNT_TOKEN_KEY, ACCOUNT_EXP_KEY]);
  }

  async function saveSession(r) {
    const previous = await storageLocalGet([LICENSE_KEY, LAST_VALID_LICENSE_KEY]);
    const previousLicenseKey = String(previous[LICENSE_KEY] || previous[LAST_VALID_LICENSE_KEY]?.licenseKey || '').trim();
    const resolvedLicenseKey = String(r.licenseKey || r.license?.key || previousLicenseKey || '').trim();
    const values = {
      [CLIENT_TOKEN_KEY]: String(r.clientToken || ''),
      [CLIENT_EXP_KEY]: Number(r.clientTokenExpiresAt) || 0,
      [ACCOUNT_TOKEN_KEY]: String(r.accountToken || ''),
      [ACCOUNT_EXP_KEY]: Number(r.accountTokenExpiresAt) || 0
    };
    if (resolvedLicenseKey) values[LICENSE_KEY] = resolvedLicenseKey;
    if (r.license?.status === 'active') {
      values[LAST_VALID_LICENSE_KEY] = {
        license: { ...r.license, error: null, syncPending: false },
        licenseKey: resolvedLicenseKey,
        clientTokenExpiresAt: Number(r.clientTokenExpiresAt) || 0,
        validatedAt: Date.now()
      };
    }
    await storageLocalSet(values);
    await runtimeSendMessage({ type: 'ATS_VALIDATE_LICENSE' }).catch(() => {});
    return r;
  }

  async function refresh() {
    const x = await storageLocalGet([ACCOUNT_TOKEN_KEY, ACCOUNT_EXP_KEY]);
    const token = String(x[ACCOUNT_TOKEN_KEY] || '').trim();
    const expiresAt = Number(x[ACCOUNT_EXP_KEY] || 0);

    // The normal customer flow is license-key based. Do not contact the account
    // service every minute when the device is already linked. Refresh only when
    // an existing account session is actually close to expiry.
    if (!token) return false;
    if (expiresAt && expiresAt - Date.now() > 5 * 60 * 1000) return true;
    if (expiresAt && expiresAt <= Date.now()) {
      await clearAccountSession();
      return false;
    }

    try {
      const r = await fetch(`${base()}/v1/customer/extension/refresh`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`
        },
        body: JSON.stringify({
          installationId: await installationId(),
          version: chrome.runtime.getManifest().version
        })
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        if (r.status === 401 || d?.error === 'account_token_invalid') await clearAccountSession();
        return false;
      }
      await saveSession({
        ...d,
        accountToken: d.accountToken || token,
        accountTokenExpiresAt: d.accountTokenExpiresAt || expiresAt
      });
      return true;
    } catch {
      return false;
    }
  }

  // License activation is intentionally handled by the main license card in
  // app.js. The first install therefore asks for the key directly, and after
  // activation the persisted installation ID keeps the same device binding.
  refresh().catch(() => {});
})();
