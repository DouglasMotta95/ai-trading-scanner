import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

const future = () => new Date(Date.now() + 86400000).toISOString();
const past = () => new Date(Date.now() - 60000).toISOString();

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
    runtime: { id: 'stable-test-extension-id', getManifest: () => ({ version: '0.10.1' }) }
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
});

test('numeric epoch expiration remains cacheable inside reopen grace without backend request', async () => {
  const storage = storageMock({ atsInstallationId: 'install-epoch' });
  const license = { key: 'ATS-EPOCH-001', status: 'active', plan: 'pro', expiresAt: Date.now() + 86400000 };
  const mod = await loadLicenseModule(storage, async () => jsonResponse({ ok: true, license }));
  const activated = await mod.activateLicense({}, license.key);
  assert.equal(activated.ok, true);
  assert.equal(storage.data.get('atsLastValidLicense')?.license?.status, 'active');
  let requests = 0;
  globalThis.fetch = async () => { requests++; throw new Error('should not validate during reopen grace'); };
  const reopened = await mod.validateLicense({});
  assert.equal(reopened.ok, true);
  assert.equal(reopened.cacheHit, true);
  assert.equal(requests, 0);
});

test('reopening inside five-minute grace restores active license before backend validation', async () => {
  const license = { key: 'ATS-PERSIST-001', status: 'active', plan: 'pro', planLabel: 'Pro', expiresAt: future() };
  const storage = storageMock({
    atsInstallationId: 'install-2',
    atsLicenseKey: license.key,
    atsLastValidLicense: { license, licenseKey: license.key, validatedAt: Date.now() - 2 * 60 * 1000 }
  });
  let requests = 0;
  const mod = await loadLicenseModule(storage, async () => { requests++; throw new Error('offline'); });
  const result = await mod.validateLicense({});
  assert.equal(result.ok, true);
  assert.equal(result.cacheHit, true);
  assert.equal(result.license.status, 'active');
  assert.equal(requests, 0);
});

test('stale valid cache repairs missing key and revalidates once after grace expires', async () => {
  const license = { key: 'ATS-RECOVER-002', status: 'active', plan: 'starter', expiresAt: future() };
  const storage = storageMock({
    atsInstallationId: 'install-3',
    atsLastValidLicense: { license, licenseKey: license.key, validatedAt: Date.now() - 12 * 60 * 60 * 1000 }
  });
  let requests = 0;
  const mod = await loadLicenseModule(storage, async () => {
    requests++;
    return jsonResponse({ ok: true, license });
  });
  const result = await mod.validateLicense({});
  assert.equal(result.ok, true);
  assert.equal(result.license.status, 'active');
  assert.equal(storage.data.get('atsLicenseKey'), license.key);
  assert.equal(requests, 1);
  assert.ok(Number(storage.data.get('atsLastValidLicense')?.validatedAt) > Date.now() - 5000);
});

test('device_locked after reopen grace never invalidates a valid cached license', async () => {
  const license = { key: 'ATS-SAFE-003', status: 'active', plan: 'pro', expiresAt: future() };
  const storage = storageMock({
    atsInstallationId: 'install-4',
    atsLicenseKey: license.key,
    atsLastValidLicense: { license, licenseKey: license.key, validatedAt: Date.now() - 24 * 60 * 60 * 1000 }
  });
  let requests = 0;
  const mod = await loadLicenseModule(storage, async () => {
    requests++;
    return jsonResponse({ ok: false, error: 'device_locked' }, 403);
  });
  const result = await mod.validateLicense({});
  assert.equal(result.ok, true);
  assert.equal(result.cacheHit, true);
  assert.equal(result.offlineFallback, true);
  assert.equal(result.error, 'device_locked');
  assert.equal(result.license.status, 'active');
  assert.equal(storage.data.get('atsLastValidLicense')?.licenseKey, license.key);
  assert.equal(requests, 1);
});

test('manual activation device_locked response also preserves previous valid cache', async () => {
  const license = { key: 'ATS-LOCK-SAFE', status: 'active', plan: 'pro', expiresAt: future() };
  const storage = storageMock({
    atsInstallationId: 'install-locked',
    atsLicenseKey: license.key,
    atsLastValidLicense: { license, licenseKey: license.key, validatedAt: Date.now() }
  });
  const mod = await loadLicenseModule(storage, async () => jsonResponse({ ok: false, error: 'device_locked' }, 403));
  const result = await mod.activateLicense({}, license.key);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'device_locked');
  assert.equal(storage.data.get('atsLastValidLicense')?.license?.status, 'active');
});

test('stale valid cache survives backend timeout and returns temporary warning', async () => {
  const license = { key: 'ATS-OFFLINE-005', status: 'active', plan: 'starter', expiresAt: future() };
  const storage = storageMock({
    atsInstallationId: 'install-offline',
    atsLicenseKey: license.key,
    atsLastValidLicense: { license, licenseKey: license.key, validatedAt: Date.now() - 30 * 60 * 1000 }
  });
  let requests = 0;
  const mod = await loadLicenseModule(storage, async () => {
    requests++;
    throw new Error('offline');
  });
  const result = await mod.validateLicense({});
  assert.equal(requests, 1);
  assert.equal(result.ok, true);
  assert.equal(result.cacheHit, true);
  assert.equal(result.offlineFallback, true);
  assert.equal(result.error, 'backend_unreachable');
  assert.equal(result.license.status, 'active');
  assert.equal(storage.data.get('atsLastValidLicense')?.licenseKey, license.key);
});

test('expired cache falls back to backend and authoritative revocation clears cached session', async () => {
  const license = { key: 'ATS-REVOKED-004', status: 'active', plan: 'starter', expiresAt: past() };
  const storage = storageMock({
    atsInstallationId: 'install-5',
    atsLicenseKey: license.key,
    atsLastValidLicense: { license, licenseKey: license.key, validatedAt: Date.now() - 24 * 60 * 60 * 1000 },
    atsClientToken: 'token',
    atsClientTokenExpiresAt: Date.now() + 60000
  });
  const mod = await loadLicenseModule(storage, async () => jsonResponse({ ok: false, error: 'license_inactive' }, 403));
  const result = await mod.validateLicense({});
  assert.equal(result.ok, false);
  assert.equal(storage.data.has('atsLastValidLicense'), false);
  assert.equal(storage.data.has('atsClientToken'), false);
});

test('device_limit_reached remains authoritative and clears stale cached session', async () => {
  const license = { key: 'ATS-LIMIT-006', status: 'active', plan: 'starter', expiresAt: future() };
  const storage = storageMock({
    atsInstallationId: 'install-limit',
    atsLicenseKey: license.key,
    atsLastValidLicense: { license, licenseKey: license.key, validatedAt: Date.now() - 20 * 60 * 1000 },
    atsClientToken: 'token',
    atsClientTokenExpiresAt: Date.now() + 60000
  });
  const mod = await loadLicenseModule(storage, async () => jsonResponse({ ok: false, error: 'device_limit_reached' }, 403));
  const result = await mod.validateLicense({});
  assert.equal(result.ok, false);
  assert.equal(result.error, 'device_limit_reached');
  assert.equal(storage.data.has('atsLastValidLicense'), false);
  assert.equal(storage.data.has('atsClientToken'), false);
});
