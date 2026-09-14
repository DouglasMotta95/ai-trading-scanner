import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

test('installationId is a random UUID persisted once per installation and migrates the legacy runtime id', () => {
  const source = read('src/sidepanel/account-login.js');
  assert.match(source, /randomInstallId = \(\) => `ats-install-\$\{crypto\.randomUUID\(\)\}`/);
  assert.match(source, /let installIdPromise = null/);
  assert.match(source, /const existing = String\(x\[INSTALL_KEY\] \|\| ''\)\.trim\(\)/);
  assert.match(source, /if \(existing && existing !== legacyId\) return existing/);
  assert.match(source, /await chrome\.storage\.local\.set\(\{ \[INSTALL_KEY\]: id \}\)/);
  assert.match(source, /const persisted = await chrome\.storage\.local\.get\(INSTALL_KEY\)/);
  assert.doesNotMatch(source, /stableInstallId/);
  assert.doesNotMatch(source, /return runtimeId \? `ats-\$\{runtimeId\}` : crypto\.randomUUID\(\)/);
});
