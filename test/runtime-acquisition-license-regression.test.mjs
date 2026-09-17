import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = path => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('focused asset and frame relay run in all CasaTrade frames including origin fallback', () => {
  const manifest = JSON.parse(read('manifest.json'));
  const row = manifest.content_scripts.find(x => x.js?.includes('src/content/frame-feed-relay.js'));
  assert.ok(row);
  assert.equal(row.all_frames, true);
  assert.equal(row.match_origin_as_fallback, true);
  assert.ok(row.js.includes('src/content/focused-asset.js'));
});

test('child frame feed is relayed through top CasaTrade frame as a normal platform snapshot', () => {
  const relay = read('src/content/frame-feed-relay.js');
  assert.match(relay, /window\.top\.postMessage/);
  assert.match(relay, /ATS_PLATFORM_SNAPSHOT/);
  assert.match(relay, /ATS_NETWORK_DIAGNOSTIC/);
  assert.match(relay, /ATS_FOCUSED_ASSET/);
  assert.match(relay, /feedQuality: selected \? 85 : 65/);
});

test('already-open CasaTrade tabs receive frame relay without requiring reinstall or tab focus', () => {
  const bootstrap = read('src/background-frame-relay-bootstrap.js');
  assert.match(bootstrap, /chrome\.tabs\.query\(\{\}\)/);
  assert.match(bootstrap, /allFrames: true/);
  assert.match(bootstrap, /frame-feed-relay\.js/);
});

test('installation identity is deterministic from fixed extension runtime id', () => {
  const telemetry = read('src/services/telemetry.js');
  assert.match(telemetry, /stableRuntimeInstallationId/);
  assert.match(telemetry, /`ats-\$\{runtimeId\}`/);
  assert.match(telemetry, /const id = stableId \|\| existing \|\| randomInstallationId\(\)/);
});

test('license guard restores a key erased by an incomplete refresh response', () => {
  const guard = read('src/background-license-guard.js');
  assert.match(guard, /lastNonEmptyKey/);
  assert.match(guard, /keyWasErased/);
  assert.match(guard, /cacheLostKey/);
  assert.match(guard, /\[LICENSE_KEY\]: lastNonEmptyKey/);
});
