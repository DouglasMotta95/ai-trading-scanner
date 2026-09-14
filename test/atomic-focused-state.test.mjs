import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');

function methodBlock(source, start, end) {
  const a = source.indexOf(start);
  const b = source.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, `missing block ${start}`);
  return source.slice(a, b);
}

test('scannerState updates are serialized and each mutator reads the latest committed state', () => {
  const atomic = read('src/services/scanner-state-atomic.js');
  assert.match(atomic, /let scannerStateWriteQueue = Promise\.resolve\(\)/);
  assert.match(atomic, /export function updateScannerState\(mutator\)/);
  assert.match(atomic, /scannerStateWriteQueue = scannerStateWriteQueue\.catch\(\(\) => \{\}\)\.then\(async \(\) => \{/);
  assert.match(atomic, /const current = await readScannerState\(\)/);
  assert.match(atomic, /await storageLocalSet\(\{ scannerState: next \}\)/);

  for (const file of ['src/background.js', 'src/background-augment.js']) {
    const source = read(file);
    assert.doesNotMatch(source, /storageLocalSet\(\{ scannerState:/, `${file} bypasses scanner state queue`);
  }
});

test('explicit state replacement can delete properties without stale patch reconstruction', async () => {
  const source = read('src/services/scanner-state-atomic.js');
  assert.match(source, /const next = typeof mutator === 'function' \? await mutator\(current\) : mutator/);
  assert.match(source, /if \(!next \|\| next === current\) return current/);
  assert.doesNotMatch(source, /\{ \.\.\.current, \.\.\.next \}/);
});

test('all scannerState writers use one explicit central queue without monkey-patching storage', () => {
  const atomic = read('src/services/scanner-state-atomic.js');
  const background = read('src/background.js');
  const augment = read('src/background-augment.js');
  assert.match(atomic, /export function updateScannerState/);
  assert.match(background, /updateScannerState/);
  assert.match(augment, /updateScannerState/);
  for (const source of [atomic, background, augment]) {
    assert.doesNotMatch(source, /chrome\.storage\.local\.set\s*=/);
    assert.doesNotMatch(source, /storage\.local\.set\s*=\s*function/);
  }
});

test('asset identity ignores OTC label only, preserving display labels and rejecting other pairs', () => {
  const augment = read('src/background-augment.js');
  assert.match(augment, /const assetIdentity = value => normAsset\(value\)\.replace/);
  assert.match(augment, /const sameAsset = \(a, b\) =>/);

  const background = read('src/background.js');
  assert.match(background, /const left = assetIdentity\(a\), right = assetIdentity\(b\)/);
  assert.match(background, /return !!left && !!right && left === right/);

  const normalizeForIdentity = value => String(value || '').trim().toUpperCase()
    .replace(/\s+/g, ' ')
    .replace(/\s*\(\s*OTC\s*\)\s*$/, '');
  assert.equal(normalizeForIdentity('EUR/USD'), normalizeForIdentity('EUR/USD (OTC)'));
  assert.notEqual(normalizeForIdentity('EUR/USD (OTC)'), normalizeForIdentity('GBP/USD'));
});

test('snapshot publishers keep visual chart focus authoritative without mixing pairs', () => {
  const network = read('src/content/network-bridge.js');
  const generic = read('src/content/generic-adapter.js');
  const augment = read('src/background-augment.js');
  const evidence = read('src/core/market-evidence.js');

  assert.match(network, /function focusedAsset\(\)/);
  assert.match(network, /!sameAsset\(cleanAsset, focus\)/);
  assert.match(network, /const candidate = bestCandidate\(payload, focus\)/);

  assert.match(generic, /const domChoice = bestDomAsset\(rows\)/);
  assert.match(generic, /const anyNetwork = bestNetworkQuote\(''\)/);
  assert.match(generic, /const focusSupported = focusFresh/);
  assert.doesNotMatch(generic, /if \(!explicitFocus\) return;/);

  assert.match(augment, /return updateScannerState\(scannerState =>/);
  assert.match(augment, /const focus = focusedAssetFor\(sender\.tab\.id, scannerState\)/);
  assert.match(augment, /const frameMatchesFocus =/);
  assert.match(augment, /if \(!frameMatchesFocus\) return/);
  assert.match(augment, /const candidate = chooseCandidate\(payload, focus\)/);
  assert.match(augment, /if \(!candidate \|\| !sameAsset\(candidate\.asset, focus\)\) return/);
  assert.match(augment, /lastConfirmed: switchedAsset \? null/);
  assert.match(augment, /tradeIntent: switchedAsset \? null/);

  assert.match(evidence, /export function resolveMarketEvidence/);
  assert.match(evidence, /focusAuthoritative/);
  assert.match(evidence, /price: null/);
});
