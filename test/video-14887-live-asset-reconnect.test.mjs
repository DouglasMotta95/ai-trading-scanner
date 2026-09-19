import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');

test('video 14887: healthy injection does not become OFFLINE at first handshake timeout', () => {
  const control = read('src/background-control.js');
  const start = control.indexOf('function scheduleConnectionTimeout');
  const end = control.indexOf('\nfunction platformFromUrl', start);
  const block = control.slice(start, end);
  assert.match(block, /runtimeInjectionHealthy\(current\)/);
  assert.match(block, /connection: 'connecting'/);
  assert.match(block, /stage: 'recovering_live_asset'/);
  assert.match(block, /recoverFocusedAsset\(tabId\)/);
  assert.match(block, /setTimeout\(\(\) => finalConnectionCheck/);
});

test('video 14887: direct recovery reads the live focused asset already detected in content frame', () => {
  const control = read('src/background-control.js');
  assert.match(control, /__ATS_FOCUSED_ASSET_META__/);
  assert.match(control, /__ATS_FOCUSED_ASSET_VALUE__/);
  assert.match(control, /directFocusedAssetProbe/);
  assert.match(control, /applyMarketFocus/);
});

test('video 14887: connect and retry both attempt focus recovery', () => {
  const control = read('src/background-control.js');
  const refreshStart = control.indexOf('async function refreshTargetTab');
  const refreshEnd = control.indexOf('\nasync function connectActiveTab', refreshStart);
  const connectStart = refreshEnd;
  const connectEnd = control.indexOf('\nasync function activate', connectStart);
  assert.match(control.slice(refreshStart, refreshEnd), /recoverFocusedAsset\(tabId\)/);
  assert.match(control.slice(connectStart, connectEnd), /recoverFocusedAsset\(tab\.id\)/);
});

test('video 14887: live shell understands M5 plus 300 second expiration', () => {
  const shell = read('src/sidepanel/ui-shell-v2.js');
  assert.match(shell, /tf === 'M5' \? '300s' : '60s'/);
  assert.match(shell, /finalWindowSeconds/);
  assert.match(shell, /\$\{finalWindowSeconds\(state\)\}s/);
});

test('video 14887: final timeout identifies asset-confirmation failure instead of generic connect failure', () => {
  const control = read('src/background-control.js');
  assert.match(control, /Falha ao confirmar o ativo ao vivo/);
  assert.match(control, /Os leitores entraram, mas o ativo ao vivo não foi confirmado/);
});
