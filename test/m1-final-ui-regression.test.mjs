import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const read = path => readFileSync(resolve(root, path), 'utf8');

test('bankroll stops searching and settles as unavailable when safe data is absent', () => {
  const source = read('src/sidepanel/bankroll-ui.js');
  assert.match(source, /ATS_BANKROLL_READ_GRACE_MS\s*=\s*6000/);
  assert.match(source, /NÃO DISPONÍVEL/);
  assert.doesNotMatch(source, /badge\.textContent\s*=.*PROCURANDO/);
});

test('account refresh preserves an existing saved license key when response omits licenseKey', () => {
  const source = read('src/sidepanel/account-login.js');
  assert.match(source, /previousLicenseKey/);
  assert.match(source, /resolvedLicenseKey\s*=\s*String\(r\.licenseKey\s*\|\|\s*r\.license\?\.key\s*\|\|\s*previousLicenseKey/);
  assert.match(source, /if \(resolvedLicenseKey\) values\[LICENSE_KEY\] = resolvedLicenseKey/);
  assert.doesNotMatch(source, /\[LICENSE_KEY\]:\s*String\(r\.licenseKey\s*\|\|\s*''\)/);
});

test('sidepanel has dark first paint and separates timeframe, expiration and candle countdown', () => {
  const html = read('src/sidepanel/index.html');
  assert.match(html, /background:#06101a/);
  assert.match(html, /TIMEFRAME DO GRÁFICO/);
  assert.match(html, /EXPIRAÇÃO REAL/);
  assert.match(html, /COUNTDOWN DA VELA/);
  assert.match(html, /id="heroExpiration"/);
  assert.ok(html.indexOf('state-restore.js') < html.indexOf('app-v2.js'));
});

test('sidepanel restores cached scannerState before the live refresh catches up', () => {
  const source = read('src/sidepanel/state-restore.js');
  assert.match(source, /chrome\.runtime\.sendMessage\(\{\s*type:\s*'ATS_READ_SCANNER_STATE'\s*\}/);
  assert.match(source, /setText\('heroExpiration'/);
  assert.match(source, /setText\('heroCountdown'/);
  assert.match(source, /setText\('asset'/);
  assert.match(source, /setText\('timeframe'/);
});
