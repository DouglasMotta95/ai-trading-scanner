import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read = path => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('child-frame relay is injected into every frame of every open CasaTrade tab', () => {
  const bootstrap = read('src/background-frame-relay-bootstrap.js');
  assert.match(bootstrap, /chrome\.tabs\.query\(\{\}\)/);
  assert.match(bootstrap, /allFrames: true/);
  assert.match(bootstrap, /frame-feed-relay\.js/);
});

test('child frame evidence is relayed through top CasaTrade frame as normal scanner messages', () => {
  const relay = read('src/content/frame-feed-relay.js');
  assert.match(relay, /window\.top\.postMessage/);
  assert.match(relay, /ATS_PLATFORM_SNAPSHOT/);
  assert.match(relay, /ATS_NETWORK_DIAGNOSTIC/);
  assert.match(relay, /ATS_FOCUSED_ASSET/);
  assert.match(relay, /selected\?85:65/);
});

test('DOM fallback only reaches confirmation grade with selected-market evidence', () => {
  const relay = read('src/content/frame-feed-relay.js');
  assert.match(relay, /feedQuality:selected\?85:65/);
  assert.match(relay, /aria-selected=\"true\"/);
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
