import test from 'node:test';
import assert from 'node:assert/strict';

const store = new Map();
let manifest = { version: '0.11.13' };

globalThis.chrome = {
  runtime: { getManifest: () => manifest },
  storage: {
    local: {
      get: async keys => {
        const list = Array.isArray(keys) ? keys : [keys];
        const out = {};
        for (const key of list) if (store.has(key)) out[key] = store.get(key);
        return out;
      },
      set: async values => { for (const [key, value] of Object.entries(values || {})) store.set(key, value); },
      remove: async keys => { for (const key of (Array.isArray(keys) ? keys : [keys])) store.delete(key); }
    }
  }
};

const license = await import('../src/services/license.js?dev-owner-license-mode');

test('unpacked diagnostic build grants owner dev access without a customer key', async () => {
  manifest = { version: '0.11.13' };
  store.clear();
  assert.equal(license.isDevBuild(), true);
  assert.equal(license.licenseRequired({}), false);
  const result = await license.validateLicense({});
  assert.equal(result.ok, true);
  assert.equal(result.devMode, true);
  assert.equal(result.license?.status, 'active');
  assert.equal(result.license?.plan, 'OWNER_DEV');
  assert.equal(result.license?.planLabel, 'DEV OWNER');
});

test('customer/release build still requires a real license', async () => {
  manifest = { version: '0.11.13', update_url: 'https://clients2.google.com/service/update2/crx' };
  store.clear();
  assert.equal(license.isDevBuild(), false);
  assert.equal(license.licenseRequired({}), true);
  const result = await license.validateLicense({});
  assert.equal(result.ok, false);
  assert.equal(result.error, 'license_required');
});

test('owner can explicitly test the license gate even in an unpacked build', async () => {
  manifest = { version: '0.11.13' };
  store.clear();
  assert.equal(license.licenseRequired({ testLicenseBlock: true }), true);
  const result = await license.validateLicense({ testLicenseBlock: true });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'license_required');
});
