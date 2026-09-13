import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const background = fs.readFileSync(path.join(root, 'src/background.js'), 'utf8');

function between(start, end) {
  const a = background.indexOf(start);
  const b = background.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, `missing section ${start}`);
  return background.slice(a, b);
}

test('only authoritative server errors may change license status in background', () => {
  const setBlock = between('const AUTHORITATIVE_BACKGROUND_LICENSE_ERRORS', 'const EMPTY_MARKET');
  for (const error of ['license_not_found', 'license_inactive', 'license_expired', 'device_limit_reached']) {
    assert.match(setBlock, new RegExp(`['\"]${error}['\"]`));
  }
  assert.doesNotMatch(setBlock, /['\"]device_locked['\"]/);
  assert.doesNotMatch(setBlock, /backend_unreachable|timeout|daily_limit_reached|trial_limit_reached/);

  const errorBlock = between('function licenseError', 'async function syncLicense');
  assert.match(errorBlock, /AUTHORITATIVE_BACKGROUND_LICENSE_ERRORS\.has\(error\)/);
  assert.match(errorBlock, /\.\.\.currentLicense, error, syncPending: true/);
});

test('consume signal failure never routes through licenseError or changes license status', () => {
  const block = between('if (becameConfirm)', 'next = telemetryState');
  assert.doesNotMatch(block, /licenseError\(usage\)/);
  assert.match(block, /if \(!usage\.ok\)[\s\S]*?license,/);
  assert.match(block, /status: license\.status/);
});
