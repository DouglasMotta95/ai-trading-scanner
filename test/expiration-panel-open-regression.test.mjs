import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');

test('expiration parser still understands custom-control attributes and clock formats', () => {
  const probe = read('src/content/casatrade-expiration-probe.js');
  assert.match(probe, /aria-valuenow/);
  assert.match(probe, /data-value/);
  assert.match(probe, /aria-valuetext/);
  assert.match(probe, /function rawValues\(el\)/);
  assert.match(probe, /function parseExpiration\(raw = ''\)/);
});

test('network probe keeps expiration metadata separate from market candidates', () => {
  const network = read('src/content/network-probe.js');
  assert.match(network, /controlExpiration: null/);
  assert.match(network, /recordControlExpiration/);
  assert.match(network, /CONTROL_EXP_KEY/);
  assert.match(network, /controls: stats\.controlExpiration/);
});

test('fresh platform control data can replace stale expiration cache without erasing a newer value', () => {
  const source = read('src/background-platform-controls.js');
  const start = source.indexOf('function mergeObserved(');
  const end = source.indexOf('\nfunction analystPrefs', start);
  assert.ok(start >= 0 && end > start);
  const mergeSource = source.slice(start, end);
  const now = Date.now();

  const forward = {
    previous: {
      expiration: '5s',
      source: 'old-cache',
      observedAt: { expiration: now - 8000 },
      confidence: { expiration: 99 }
    },
    incoming: {
      expiration: '60s',
      source: 'casatrade-network-control',
      observedAt: { expiration: now },
      confidence: { expiration: 84 }
    },
    result: null,
    Date
  };
  vm.runInNewContext(mergeSource + '\nresult = mergeObserved(previous, incoming);', forward);
  assert.equal(forward.result.expiration, '60s');

  const backward = {
    previous: forward.result,
    incoming: {
      expiration: '5s',
      source: 'stale-network',
      observedAt: { expiration: now - 4000 },
      confidence: { expiration: 97 }
    },
    result: null,
    Date
  };
  vm.runInNewContext(mergeSource + '\nresult = mergeObserved(previous, incoming);', backward);
  assert.equal(backward.result.expiration, '60s');
});

test('panel retry refreshes the registered target tab and recovers focused asset without reconnecting active-tab identity', () => {
  const control = read('src/background-control.js');
  const start = control.indexOf('async function refreshTargetTab');
  const end = control.indexOf('\nasync function connectActiveTab', start);
  const block = control.slice(start, end);
  assert.match(block, /const tabId = Number\(state\.targetTabId \|\| 0\)/);
  assert.match(block, /injectModern\(tabId\)/);
  assert.match(block, /forceLiveControlRead\(tabId\)/);
  assert.match(block, /recoverFocusedAsset\(tabId\)/);
  assert.match(control, /type === 'ATS_REFRESH_TARGET_TAB'/);
});

test('manual entry readiness depends on confirmed central signal and focused asset, not live expiration probing', () => {
  const control = read('src/background-control.js');
  const start = control.indexOf('function exactTradeReady');
  const end = control.indexOf('\nasync function manualIntent', start);
  const block = control.slice(start, end);
  assert.match(block, /ENTER_BUY/);
  assert.match(block, /ENTER_SELL/);
  assert.match(block, /sameAsset\(focus\.asset, state\.asset\)/);
  assert.doesNotMatch(block, /expiration|expirationCheckedAt/);
});

test('manual intent uses selected operation plan for timeframe and expiration', () => {
  const control = read('src/background-control.js');
  const start = control.indexOf('async function manualIntent');
  const end = control.indexOf('\nfunction normalizeOperatingTimeframe', start);
  const block = control.slice(start, end);
  assert.match(block, /operatingTimeframe/);
  assert.match(block, /expirationForOperatingTimeframe\(operatingTimeframe\)/);
  assert.match(block, /mode: 'manual-only'/);
});

test('generic network duration still requires trade-expiration semantics', () => {
  const network = read('src/content/network-probe.js');
  assert.match(network, /GENERIC_DURATION_KEY/);
  assert.match(network, /CONTROL_EXP_KEY/);
  assert.match(network, /recordControlExpiration/);
  assert.match(network, /parentKey/);
});

test('connection handshake requires focused live market plus candle-close clock, not expiration', () => {
  const control = read('src/background-control.js');
  const start = control.indexOf('function handshakeReady(');
  const end = control.indexOf('\nfunction scheduleConnectionTimeout', start);
  const block = control.slice(start, end);
  assert.match(block, /marketDataConnected\(state\)/);
  assert.match(block, /clock\.role === 'candle-close'/);
  assert.match(block, /clock\.secondsRemaining/);
  assert.doesNotMatch(block, /expiration/);
});

test('healthy injection stays in recovery before final connection failure', () => {
  const control = read('src/background-control.js');
  const start = control.indexOf('function scheduleConnectionTimeout');
  const end = control.indexOf('\nfunction platformFromUrl', start);
  const block = control.slice(start, end);
  assert.match(block, /runtimeInjectionHealthy\(current\)/);
  assert.match(block, /stage: 'recovering_live_asset'/);
  assert.match(block, /recoverFocusedAsset\(tabId\)/);
  assert.match(block, /finalConnectionCheck/);
});

test('sidepanel displays selected M1/M5 expiration plan without treating it as technical confirmation', () => {
  const app = read('src/sidepanel/app-v2.js');
  const html = read('src/sidepanel/index.html');
  assert.match(app, /requiredExpirationForTimeframe/);
  assert.match(app, /'60s' : '300s'/);
  assert.match(html, /M1 • expiração 1 min/);
  assert.match(html, /M5 • expiração 5 min/);
});
