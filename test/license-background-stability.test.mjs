import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('license authority is owned by the current license service/control path', () => {
  const license = read('src/services/license.js');
  const control = read('src/background-control.js');
  assert.match(license, /AUTHORITATIVE_LICENSE_ERRORS/);
  assert.match(license, /license_not_found/);
  assert.match(license, /license_inactive/);
  assert.match(license, /license_expired/);
  assert.match(license, /device_limit_reached/);
  assert.doesNotMatch(license.match(/const AUTHORITATIVE_LICENSE_ERRORS[\s\S]*?\]\);/)?.[0] || '', /device_locked/);
  assert.match(control, /restoreCachedLicense/);
});

test('usage failures do not introduce a second license authority in the analysis owner', () => {
  const background = read('src/background.js');
  assert.doesNotMatch(background, /AUTHORITATIVE_BACKGROUND_LICENSE_ERRORS/);
  assert.doesNotMatch(background, /function licenseError/);
});
