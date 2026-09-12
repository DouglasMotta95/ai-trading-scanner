import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

const future = () => new Date(Date.now() + 86400000).toISOString();

function storageMock(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    api: {
      async get(keys) {
        if (keys == null) return Object.fromEntries(data);
        const list = Array.isArray(keys) ? keys : [keys];
        return Object.fromEntries(list.filter(k => data.has(k)).map(k => [k, data.get(k)]));
      },
      async set(values) {
        for (const [k, v] of Object.entries(values || {})) data.set(k, v);
      },
      async remove(keys) {
        for (const k of Array.isArray(keys) ? keys : [keys]) data.delete(k);
      }
    }
  };
}

async function loadLicenseModule(storage, fetchImpl) {
  globalThis.crypto ||= webcrypto;
  globalThis.chrome = {
    storage: { local: storage.api },
    runtime: { getManifest: () => ({ version: '0.10.1' }) }
  };
  globalThis.fetch = fetchImpl;
  const url = new URL(`../src/services/license.js?test=${Date.now()}-${Math.random()}`, import.meta.url);
  return import(url.href);
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; }
  };
}

test('manual activation persists key and last valid license even if backend omits client token', async () => {
  const storage = storageMock({ atsInstallationId: 'install-1' });
  const license = { key: 'ATS-ABC-123', status: 'active', plan: 'starter', planLabel: 'Starter', expiresAt: future() };
  const mod = await loadLicenseModule(storage, async () => jsonResponse({ ok: true, license }));

  const result = await mod.activateLicense({}, license.key);
  assert.equal(result.ok, true);
  assert.equal(storage.data.get('atsLicenseKey'), license.key);
  assert.equal(storage.data.get('atsLastValidLicense')?.license?.status, 'active');
  assert.equal(storage.data.get('atsLastValidLicense')?.licenseKey, license.key);
});

test('reopening extension restores active license from chrome.storage.local before backend validation', async () => {
  const license = { key: 'ATS-PERSIST-001', status: 'active', plan: 'pro', planLabel: 'Pro', expiresAt: future() };
  const storage = storageMock({
    atsInstallationId: 'install-2',
    atsLicenseKey: license.key,
    atsLastValidLicense: { license, licenseKey: license.key, validatedAt: Date.now() }
  });

  const mod = await loadLicenseModule(storage, async () => { throw new Error('offline'); });
  const cached = await mod.restoreCachedLicense();
  assert.equal(cached?.status, 'active');
  assert.equal(cached?.plan, 'pro');

  const result = await mod.validateLicense({});
  assert.equal(result.ok, true);
  assert.equal(result.offlineFallback, true);
  assert.equal(result.license.status, 'active');
  assert.equal(result.license.syncPending, true);
});

test('cache repairs a missing atsLicenseKey on reopen and validation continues normally', async () => {
  const license = { key: 'ATS-RECOVER-002', status: 'active', plan: 'starter', planLabel: 'Starter', expiresAt: future() };
  const storage = storageMock({
    atsInstallationId: 'install-3',
    atsLastValidLicense: { license, licenseKey: license.key, validatedAt: Date.now() }
  });
  let requestedKey = null;
  const mod = await loadLicenseModule(storage, async (_url, options) => {
    requestedKey = JSON.parse(options.body).licenseKey;
    return jsonResponse({ ok: true, license, clientToken: 'client-token', clientTokenExpiresAt: Date.now() + 60000 });
  });

  const result = await mod.validateLicense({});
  assert.equal(result.ok, true);
  assert.equal(requestedKey, license.key);
  assert.equal(storage.data.get('atsLicenseKey'), license.key);
  assert.equal(storage.data.get('atsLastValidLicense')?.license?.status, 'active');
});
