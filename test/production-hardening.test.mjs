import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import os from 'node:os';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const PLACEHOLDER = 'COLOQUE_AQUI_UM_SEGREDO_UNICO_GERADO';

test('production rejects the checked-in SESSION_SECRET placeholder explicitly', () => {
  const envExample = read('backend/.env.example');
  const server = read('backend/src/server.js');
  assert.match(envExample, /NUNCA USE ESTE VALOR EM PRODUÇÃO/);
  assert.match(envExample, new RegExp(`SESSION_SECRET=${PLACEHOLDER}`));
  assert.match(server, /SESSION_SECRET_PLACEHOLDERS/);
  assert.match(server, new RegExp(PLACEHOLDER));
  assert.match(server, /SESSION_SECRET_PLACEHOLDERS\.has\(SESSION_SECRET\)/);

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ats-secret-test-'));
  const result = spawnSync(process.execPath, ['backend/src/server.js'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 5000,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      SESSION_SECRET: PLACEHOLDER,
      ATS_DATA_DIR: dataDir,
      PORT: '0'
    }
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /SESSION_SECRET must be a unique non-example secret/);
});

function storageMock(initial = {}) {
  const values = { ...initial };
  return {
    values,
    api: {
      async get(keys) {
        if (Array.isArray(keys)) return Object.fromEntries(keys.map(key => [key, values[key]]));
        if (typeof keys === 'string') return { [keys]: values[keys] };
        return { ...values };
      },
      async set(patch) { Object.assign(values, patch); },
      async remove(keys) {
        for (const key of (Array.isArray(keys) ? keys : [keys])) delete values[key];
      }
    }
  };
}

async function withInstallationGlobals({ initial = {}, uuid }, run) {
  const hadChrome = Object.prototype.hasOwnProperty.call(globalThis, 'chrome');
  const previousChrome = globalThis.chrome;
  const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  const mock = storageMock(initial);
  let uuidCalls = 0;
  globalThis.chrome = {
    runtime: {
      id: 'shared-extension-runtime-id',
      getManifest: () => ({ version: 'test' })
    },
    storage: { local: mock.api }
  };
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    value: { randomUUID: () => { uuidCalls += 1; return uuid; } }
  });
  try {
    const url = pathToFileURL(path.join(root, 'src/services/telemetry.js')).href;
    const telemetry = await import(`${url}?test=${Date.now()}-${Math.random()}`);
    return await run({ telemetry, values: mock.values, uuidCalls: () => uuidCalls });
  } finally {
    if (hadChrome) globalThis.chrome = previousChrome;
    else delete globalThis.chrome;
    if (cryptoDescriptor) Object.defineProperty(globalThis, 'crypto', cryptoDescriptor);
    else delete globalThis.crypto;
  }
}

test('telemetry installationId generates one UUID and reuses it across concurrent calls', async () => {
  await withInstallationGlobals({
    uuid: '11111111-1111-4111-8111-111111111111'
  }, async ({ telemetry, values, uuidCalls }) => {
    const ids = await Promise.all([
      telemetry.installationId(),
      telemetry.installationId(),
      telemetry.installationId()
    ]);
    const expected = 'ats-install-11111111-1111-4111-8111-111111111111';
    assert.deepEqual(ids, [expected, expected, expected]);
    assert.equal(values.atsInstallationId, expected);
    assert.equal(uuidCalls(), 1);
    assert.notEqual(expected, 'ats-shared-extension-runtime-id');
  });
});

test('telemetry installationId migrates the legacy chrome.runtime.id based value', async () => {
  await withInstallationGlobals({
    initial: { atsInstallationId: 'ats-shared-extension-runtime-id' },
    uuid: '22222222-2222-4222-8222-222222222222'
  }, async ({ telemetry, values, uuidCalls }) => {
    const id = await telemetry.installationId();
    const expected = 'ats-install-22222222-2222-4222-8222-222222222222';
    assert.equal(id, expected);
    assert.equal(values.atsInstallationId, expected);
    assert.equal(uuidCalls(), 1);
  });
});

test('account login imports the shared telemetry installationId instead of duplicating it', () => {
  const account = read('src/sidepanel/account-login.js');
  const index = read('src/sidepanel/index.html');
  assert.match(account, /import \{ installationId \} from '\.\.\/services\/telemetry\.js';/);
  assert.match(account, /installationId: await installationId\(\)/);
  assert.doesNotMatch(account, /randomInstallId|legacyRuntimeInstallId|installIdPromise|stableInstallId/);
  assert.match(index, /<script type="module" src="account-login\.js"><\/script>/);
});
