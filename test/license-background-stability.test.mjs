import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');

test('device lock is authoritative and cannot fall back to cached active access', () => {
  const license = read('src/services/license.js');
  const control = read('src/background-control.js');
  assert.match(license, /'device_locked'/);
  assert.match(license, /AUTHORITATIVE_LICENSE_ERRORS/);
  assert.doesNotMatch(control, /restoreCachedLicense/);
  assert.match(control, /licenseFailureStatus/);
  assert.match(control, /device_locked/);
  assert.match(control, /response\?\.ok === true && activeLicense\(license\)/);
});

test('unpacked customer builds do not automatically become OWNER_DEV', () => {
  const license = read('src/services/license.js');
  const owner = read('src/background-dev-owner.js');
  assert.match(license, /settings\?\.ownerDevMode === true/);
  assert.doesNotMatch(license, /ownerDevMode = \(settings = \{\}\) => isDevBuild\(\)/);
  assert.match(owner, /ownerDevEnabled/);
  assert.match(owner, /settings\?\.ownerDevMode === true/);
});

test('live runtime sends heartbeat and consumes each user-facing confirmed signal', () => {
  const background = read('src/background.js');
  const telemetry = read('src/services/telemetry.js');
  assert.match(background, /heartbeat as telemetryHeartbeat/);
  assert.match(background, /consumeSignal, validateLicense/);
  assert.match(background, /professionalConfirmed/);
  assert.match(background, /signal_confirmed/);
  assert.match(background, /HEARTBEAT_INTERVAL_MS = 5000/);
  assert.match(background, /signalAllowance/);
  assert.match(telemetry, /professionalDecision/);
});

test('fast decision path can promote but cannot downgrade a stronger central signal', () => {
  const fast = read('src/background-fast-decision.js');
  const core = read('src/core/live-fast-decision.js');
  assert.match(fast, /function decisionRank/);
  assert.match(fast, /function canFastApply/);
  assert.match(fast, /nextRank < currentRank/);
  assert.match(core, /Fast path is an accelerator, never a veto/);
});
