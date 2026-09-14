import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function makeStorage(initial) {
  const backing = clone(initial);
  const local = {
    async get(keys) {
      if (keys == null) return clone(backing);
      if (typeof keys === 'string') return { [keys]: clone(backing[keys]) };
      if (Array.isArray(keys)) return Object.fromEntries(keys.map(key => [key, clone(backing[key])]));
      if (typeof keys === 'object') {
        const out = {};
        for (const [key, fallback] of Object.entries(keys)) out[key] = key in backing ? clone(backing[key]) : clone(fallback);
        return out;
      }
      return {};
    },
    async set(items) {
      for (const [key, value] of Object.entries(items || {})) backing[key] = clone(value);
    }
  };
  return { backing, local };
}

async function loadAtomic(local, suffix) {
  globalThis.chrome = { storage: { local } };
  const moduleUrl = pathToFileURL(path.join(root, 'src/services/scanner-state-atomic.js')).href;
  return import(`${moduleUrl}?atomic-regression=${suffix}-${Date.now()}-${Math.random()}`);
}

test('scannerState updates are serialized and each mutator reads the latest committed state', async () => {
  const { backing, local } = makeStorage({
    scannerState: {
      asset: 'EUR/USD (OTC)',
      candles: [{ time: 1, close: 1.1 }],
      signal: { state: 'WAIT', direction: null },
      diagnostics: { seed: true }
    }
  });

  const atomic = await loadAtomic(local, 'serialized');
  const firstWrite = atomic.updateScannerState(async current => {
    await new Promise(resolve => setTimeout(resolve, 10));
    return {
      ...current,
      candles: [{ time: 2, close: 1.2 }],
      signal: { state: 'CONFIRM', direction: 'BUY' }
    };
  });
  const secondWrite = atomic.updateScannerState(current => ({
    ...current,
    diagnostics: { ...current.diagnostics, network: { lastSeen: 2 } }
  }));

  await Promise.all([firstWrite, secondWrite]);
  assert.deepEqual(backing.scannerState.candles, [{ time: 2, close: 1.2 }]);
  assert.deepEqual(backing.scannerState.signal, { state: 'CONFIRM', direction: 'BUY' });
  assert.deepEqual(backing.scannerState.diagnostics, { seed: true, network: { lastSeen: 2 } });
});

test('explicit state replacement can delete properties without stale patch reconstruction', async () => {
  const { backing, local } = makeStorage({
    scannerState: {
      asset: 'EUR/USD (OTC)',
      diagnostics: {
        focusedAsset: { asset: 'EUR/USD (OTC)' },
        network: { lastSeen: 1 },
        access: { state: 'licensed' }
      }
    }
  });
  const atomic = await loadAtomic(local, 'deletions');
  await atomic.updateScannerState(current => ({ ...current, diagnostics: {} }));
  assert.deepEqual(backing.scannerState.diagnostics, {});
});

test('all scannerState writers use one explicit central queue without monkey-patching storage', () => {
  const atomic = read('src/services/scanner-state-atomic.js');
  assert.match(atomic, /let scannerStateWriteQueue = Promise\.resolve\(\)/);
  assert.match(atomic, /export function updateScannerState\(mutator\)/);
  assert.match(atomic, /const task = scannerStateWriteQueue\.then/);
  assert.match(atomic, /const current = await storedScannerState\(\)/);
  assert.match(atomic, /const proposed = await mutator\(clone\(current\)\)/);
  assert.doesNotMatch(atomic, /chrome\.storage\.local\.get\s*=/);
  assert.doesNotMatch(atomic, /chrome\.storage\.local\.set\s*=/);

  for (const file of ['src/background.js', 'src/background-augment.js']) {
    const source = read(file);
    assert.match(source, /updateScannerState/);
    assert.doesNotMatch(source, /chrome\.storage\.local\.set\s*\(\s*\{\s*scannerState\b/);
    assert.doesNotMatch(source, /updates\.scannerState\s*=/);
  }

  const augment = read('src/background-augment.js');
  for (const fn of ['keepRealFeedContext', 'setFocusedAsset', 'applyEmbeddedFeed']) {
    const start = augment.indexOf(`async function ${fn}`);
    assert.ok(start >= 0);
    const end = augment.indexOf('\nasync function ', start + 1) >= 0
      ? augment.indexOf('\nasync function ', start + 1)
      : augment.indexOf('\nchrome.runtime.onMessage', start + 1);
    assert.match(augment.slice(start, end), /updateScannerState\(scannerState =>/);
  }
});

test('asset identity ignores OTC label only, preserving display labels and rejecting other pairs', () => {
  for (const file of ['src/background.js', 'src/background-augment.js', 'src/content/generic-adapter.js']) {
    const source = read(file);
    assert.match(source, /assetIdentity\s*=\s*value\s*=>[\s\S]*?replace\(\/\\s\*\\\(OTC\\\)\\s\*\$\/, ''\)/);
  }

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
