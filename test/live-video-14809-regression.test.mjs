import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');

test('video 14809: rendered Expiração 1 min is promoted into platform controls', () => {
  const canvas = read('src/content/canvas-probe.js');
  const bridge = read('src/content/embedded-feed-bridge.js');
  assert.match(canvas, /controls: expiration \? \{/);
  assert.match(canvas, /confidence: 96/);
  assert.match(canvas, /sourceKey: 'rendered-expiration-control'/);
  assert.match(bridge, /const networkExpiration = normalizeExp\(payload\.controls\?\.expiration\)/);
  assert.match(bridge, /type: 'ATS_PLATFORM_CONTROLS_OBSERVED'/);
});

test('video 14809: stale protocol-selected old asset cannot rollback an active visible market switch', () => {
  const session = read('src/background-market-session.js');
  assert.match(session, /const incomingProtocolOnly = message\.visual === false \|\| clean\(message\.source\) === 'protocol-selected'/);
  assert.match(session, /const transitionProtectsCurrentFocus = session\.transitioning === true/);
  assert.match(session, /protocol-rollback-during-visible-transition/);
  assert.match(session, /protocol-rollback-after-user-selection/);
  assert.match(session, /protocol-rollback-visual-selection-lock/);
  assert.match(session, /visualSelectionLock: authoritativeVisual/);
  assert.match(session, /protocolContradictsSelectionLock/);
});

test('video 14809: asset switch reset clears old price OHLC candles and signal before new market is confirmed', () => {
  const session = read('src/background-market-session.js');
  const start = session.indexOf('function resetForSession(');
  const end = session.indexOf('\nfunction clockRecord', start);
  assert.ok(start >= 0 && end > start);
  const reset = session.slice(start, end);
  assert.match(reset, /asset: null/);
  assert.match(reset, /price: null/);
  assert.match(reset, /candles: \[\]/);
  assert.match(reset, /currentCandle: null/);
  assert.match(reset, /marketHistory: \{\}/);
  assert.match(reset, /signal: null/);
  assert.match(reset, /professionalDecision: null/);
  assert.match(reset, /confirmedAsset: null/);
  assert.match(reset, /transitioning: true/);
});

test('video 14809: exact countdown survives a brief DOM gap at next-candle rollover', () => {
  const clock = read('src/content/market-cycle-clock-v4.js');
  assert.match(clock, /Date\.now\(\) - Number\(domProbe\.observedAt \|\| domProbe\.at \|\| 0\) >= 9000/);
  assert.match(clock, /delta > 200/);
  assert.match(clock, /delta < 6500/);
  assert.match(clock, /delta < 9000/);
  assert.match(clock, /Number\(previous\.seconds\) <= 2/);
  assert.match(clock, /Number\(candidate\.seconds\) >= duration - 8/);
  assert.match(clock, /candidate\.chartScoped === true \|\| candidate\.colonOnly === true/);
  assert.match(clock, /localDelta > 150 && localDelta < 9000/);
});

test('video 14809: platform stays connected while selected asset is resynchronizing', () => {
  const shell = read('src/sidepanel/ui-shell-v2.js');
  assert.match(shell, /const dataConnected = baseHandshake\(state\)/);
  assert.match(shell, /const connected = dataConnected \|\| switching/);
  assert.match(shell, /connectScannerText'\)\.textContent = connected \? 'CONECTADO' : 'DESCONECTADO'/);
  assert.match(shell, /ATUALIZANDO PARA \$\{pendingAsset\}/);
});

test('video 14809: build version is unique so 0.11.26 cache cannot be reused', () => {
  const manifest = JSON.parse(read('manifest.json'));
  assert.equal(manifest.version, '0.11.41');
  assert.equal(manifest.version_name, '0.11.41-stable-signal-state-machine');
});

test('video 14809: central technical analysis owner remains single', () => {
  const central = read('src/background.js');
  assert.equal((central.match(/processSnapshot\(/g) || []).length, 1);
  for (const path of ['src/background-augment.js','src/background-integrity.js','src/background-market-session.js']) {
    assert.doesNotMatch(read(path), /processSnapshot\(/);
  }
});
