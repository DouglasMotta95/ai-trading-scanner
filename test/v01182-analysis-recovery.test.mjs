import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');

test('v0.11.116: exact and fallback timing paths stay explicitly separated', () => {
  const policy = read('src/background-decision-policy.js');
  const background = read('src/background.js');
  assert.match(policy, /authoritative: true/);
  assert.match(policy, /authoritative: false/);
  assert.match(policy, /quality: 'fallback'/);
  assert.match(background, /clockQuality: 'fallback'/);
  assert.match(background, /derived-candle-boundary/);
});

test('v0.11.116: fallback timing keeps the live cycle running without claiming exact authority', () => {
  const policy = read('src/background-decision-policy.js');
  assert.match(policy, /function usableCasaTradeTime/);
  assert.match(policy, /quality: 'fallback'/);
  assert.match(policy, /projectedFromLastGood/);
  assert.match(policy, /const time = usableCasaTradeTime\(state\)/);
});

test('v0.11.82: technical score is independent from exact timing presentation', () => {
  const guidance = read('src/sidepanel/signal-guidance-ui.js');
  assert.match(guidance, /function analysisReady\(state = \{\}\) \{[\s\S]*return marketReady\(state\);/);
  assert.doesNotMatch(guidance, /O score só aparece depois de/);
});

test('v0.11.82: direct DOM expiration probe can pair separated visible label and value', () => {
  const control = read('src/background-control.js');
  assert.match(control, /renderedExpirationRows/);
  assert.match(control, /rendered-label-pair/);
  assert.match(control, /const labels = renderedRows\.filter/);
});

test('v0.11.82: fresh non-manual observed expiration is promoted to real authority', () => {
  const controls = read('src/background-platform-controls.js');
  const app = read('src/sidepanel/app-v2.js');
  assert.match(controls, /const observedIsReal/);
  assert.match(controls, /observedSource !== 'user-declared'/);
  assert.match(app, /const observedRealFresh/);
  assert.match(app, /observedSource !== 'user-declared'/);
});

test('v0.11.82: build versions are aligned', () => {
  const manifest = JSON.parse(read('manifest.json'));
  const root = JSON.parse(read('package.json'));
  const backend = JSON.parse(read('backend/package.json'));
  assert.equal(manifest.version, '0.11.82');
  assert.equal(manifest.version_name, '0.11.82-casatrade-analysis-recovery');
  assert.equal(root.version, '0.11.82');
  assert.equal(backend.version, '0.11.82');
  const server = read('backend/src/server.js');
  assert.match(server, /const VERSION = '0\.11\.82'/);
  assert.match(server, /EXTENSION_LATEST_VERSION = String\(process\.env\.EXTENSION_LATEST_VERSION \|\| '0\.11\.82'\)/);
});
