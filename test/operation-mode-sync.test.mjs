import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  operationModeForExpiration,
  trustedModeFromObservedControls
} from '../src/core/operation-mode-sync.js';

const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');

test('maps 5-minute expiry to M5 and 1-minute expiry to M1', () => {
  assert.deepEqual(operationModeForExpiration('5 min'), { timeframe: 'M5', expiration: '300s', durationSeconds: 300 });
  assert.deepEqual(operationModeForExpiration('300s'), { timeframe: 'M5', expiration: '300s', durationSeconds: 300 });
  assert.deepEqual(operationModeForExpiration('1 min'), { timeframe: 'M1', expiration: '60s', durationSeconds: 60 });
  assert.deepEqual(operationModeForExpiration('60s'), { timeframe: 'M1', expiration: '60s', durationSeconds: 60 });
});

test('does not silently map short OTC expirations to M1/M5', () => {
  assert.equal(operationModeForExpiration('5s'), null);
  assert.equal(operationModeForExpiration('15s'), null);
  assert.equal(operationModeForExpiration('30s'), null);
  assert.equal(operationModeForExpiration(''), null);
});

test('only follows a fresh, high-confidence CasaTrade expiration probe', () => {
  const now = 1_000_000;
  const observation = {
    source: 'casatrade-expiration-probe-v3',
    expiration: '300s',
    observedAt: { expiration: now - 100, timeframe: now - 100 },
    confidence: { expiration: 120, timeframe: 80 }
  };
  assert.deepEqual(trustedModeFromObservedControls(observation, now), { timeframe: 'M5', expiration: '300s', durationSeconds: 300 });
  assert.equal(trustedModeFromObservedControls({ ...observation, source: 'casatrade-platform-sync-live' }, now), null);
  assert.equal(trustedModeFromObservedControls({ ...observation, confidence: { expiration: 70 } }, now), null);
  assert.equal(trustedModeFromObservedControls({ ...observation, observedAt: { expiration: now - 20_000 } }, now), null);
  assert.equal(trustedModeFromObservedControls({ ...observation, expiration: '15s' }, now), null);
});

test('background mode sync maps the manual 5-minute declaration and applies verified controls', () => {
  const source = read('src/background-platform-controls.js');
  const platform = read('src/content/platform-sync.js');
  assert.match(source, /const mappedMode = operationModeForExpiration\(declared\)/);
  assert.match(source, /analystPreferences: analystPrefs\(base, \{ operationMode: nextMode\.timeframe \}\)/);
  assert.match(source, /applyCasaTradeMode\(state, selectedMode, 'user-expiration-selection'\)/);
  assert.match(source, /for \(const field of \['timeframe', 'expiration'\]\)/);
  assert.match(source, /Sincronização parcial: timeframe=/);
  assert.match(source, /trustedModeFromObservedControls\(incoming, Date\.now\(\)\)/);
  assert.match(source, /persistUiOperationMode\(selectedMode\)/);
  assert.match(platform, /message\?\.type === 'ATS_PLATFORM_APPLY'/);
  assert.match(platform, /timeframe: !!desired\.timeframe && after\.timeframe === desired\.timeframe/);
  assert.match(platform, /expiration: !!desired\.expiration && after\.expiration === desired\.expiration/);
});
