import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');

test('expiration parser still understands CasaTrade visible duration controls', () => {
  const probe = read('src/content/casatrade-expiration-probe.js');
  assert.match(probe, /function parseExpiration\(raw = ''\)/);
  assert.match(probe, /minuto/);
  assert.match(probe, /aria-valuetext/);
  assert.match(probe, /data-value/);
  assert.doesNotMatch(probe, /expiration:\s*['"]60s['"]/);
});

test('timeframe reader requires candle semantics and rejects generic chart range labels', () => {
  const probe = read('src/content/casatrade-expiration-probe.js');
  const start = probe.indexOf('function selectedTimeframe');
  const end = probe.indexOf('\n  const EXPIRATION_TRANSIENT_CACHE_MS', start);
  const block = probe.slice(start, end);
  assert.match(block, /candleSemantic/);
  assert.match(block, /chartRangeOnly/);
  assert.match(block, /periodo da vela|candle period|candle interval/);
});

test('confirmed platform expiration remains sticky when a dirty recheck has no replacement value', () => {
  const background = read('src/background-platform-controls.js');
  const start = background.indexOf('function mergeObserved');
  const end = background.indexOf('\nfunction analystPrefs', start);
  const block = background.slice(start, end);
  assert.match(block, /expirationRecheckPendingAt/);
  assert.doesNotMatch(block, /expirationDirty[^\n]*[\s\S]{0,220}expiration\s*=\s*null/);
});

test('direct expiration probe remains diagnostic-capable but retry no longer depends on it', () => {
  const control = read('src/background-control.js');
  assert.match(control, /async function directExpirationProbe\(tabId\)/);
  assert.match(control, /function executeScriptCompat\(details\)/);
  const start = control.indexOf('async function refreshTargetTab');
  const end = control.indexOf('\nasync function connectActiveTab', start);
  const block = control.slice(start, end);
  assert.match(block, /injectModern\(tabId\)/);
  assert.match(block, /forceLiveControlRead\(tabId\)/);
  assert.match(block, /recoverFocusedAsset\(tabId\)/);
  assert.doesNotMatch(block, /readAndCommitDirectExpiration/);
});

test('sidepanel displays planned expiration from selected operating timeframe instead of using it as a signal gate', () => {
  const app = read('src/sidepanel/app-v2.js');
  const html = read('src/sidepanel/index.html');
  assert.match(app, /requiredExpirationForTimeframe/);
  assert.match(app, /return normalizeOperatingTimeframe\(value\) === 'M1' \? '60s' : '300s'/);
  assert.match(app, /heroExpirationPlan/);
  assert.match(html, /id="heroExpirationPlan"/);
  const decisionStart = app.indexOf('function decisionModel');
  const decisionEnd = app.indexOf('\nfunction setText', decisionStart);
  assert.doesNotMatch(app.slice(decisionStart, decisionEnd), /expiration/);
});

test('structured candle boundary fallback supports the whole operating bucket', () => {
  const clock = read('src/content/market-cycle-clock-v4.js');
  assert.match(clock, /function currentStateBoundary/);
  assert.match(clock, /const currentBucket = Math\.floor\(now \/ durationMs\) \* durationMs/);
  assert.match(clock, /const bucketRows = normalized\.filter/);
  assert.match(clock, /const openAt = currentBucket/);
  assert.match(clock, /openAt \+ durationMs - now/);
  assert.match(clock, /clockMode: 'structured-current-candle-boundary'/);
});

test('Android scripting fallback supports callback and Promise Chrome APIs', () => {
  const control = read('src/background-control.js');
  assert.match(control, /function executeScriptCompat\(details\)/);
  assert.match(control, /chrome\.scripting\.executeScript\(details, callback\)/);
  assert.match(control, /returned && typeof returned\.then === 'function'/);
});

test('mobile visible-text diagnostic probe preserves line breaks and accepts decorated minute values', () => {
  const control = read('src/background-control.js');
  const start = control.indexOf('async function directExpirationProbe');
  const end = control.indexOf('\nasync function commitDirectExpiration', start);
  const block = control.slice(start, end);
  assert.match(block, /String\(document\.body\?\.innerText \|\| ''\)\.normalize\('NFKC'\)/);
  assert.match(block, /visible-lines-after-expiration-label/);
  assert.match(block, /s\.length <= 48/);
});
