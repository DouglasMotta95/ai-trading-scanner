import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');

test('background directly probes CasaTrade expiration across all frames', () => {
  const source = read('src/background-control.js');
  assert.match(source, /function inspectCasaTradeControlsDirect/);
  assert.match(source, /target: \{ tabId: Number\(tabId\), allFrames: true \}/);
  assert.match(source, /ATS_PROBE_PLATFORM_CONTROLS/);
  assert.match(source, /background-direct-dom/);
  assert.match(source, /expirationCheckedAt/);
});

test('visible expiration values are normalized directly from labels', () => {
  const source = read('src/background-control.js');
  assert.match(source, /expira\(\?:ção\|cao\)\?/i);
  assert.match(source, /minuto\|minutos/);
  assert.match(source, /segundo\|segundos/);
  assert.match(source, /\$\{Number\(m\[1\]\) \* 60\}s/);
});

test('expiration acceptance matches the proven v0.11.27 behavior', () => {
  const source = read('src/background-platform-controls.js');
  assert.match(source, /const actualExpiration = expirationFresh \? observed\.expiration \|\| null : null/);
  assert.doesNotMatch(source, /reliableExpiration/);
  assert.match(source, /actual: actualExpiration/);
});

test('side panel automatically probes controls and does not require retry for expiration', () => {
  const shell = read('src/sidepanel/ui-shell-v2.js');
  const app = read('src/sidepanel/app-v2.js');
  assert.match(shell, /ATS_PROBE_PLATFORM_CONTROLS/);
  assert.match(shell, /probePlatformControls/);
  assert.match(shell, /retry\.hidden = !\(marketPending \|\| failure\)/);
  assert.doesNotMatch(app, /expirationTimedOut/);
});

test('direct timeframe probe never treats expiration duration as candle timeframe', () => {
  const source = read('src/background-control.js');
  assert.match(source, /if \(tf && !\/expira\|expiry\|expiration\|duracao\|duration\//);
});
