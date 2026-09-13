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

test('scannerState writes are serialized patches and stale writers cannot erase newer candles/signal', async () => {
  const { backing, local } = makeStorage({
    scannerState: {
      asset: 'EUR/USD (OTC)',
      candles: [{ time: 1, close: 1.1 }],
      signal: { state: 'WAIT', direction: null },
      diagnostics: { seed: true }
    }
  });

  await loadAtomic(local, 'serialized');

  const first = (await chrome.storage.local.get('scannerState')).scannerState;
  const stale = (await chrome.storage.local.get('scannerState')).scannerState;

  const firstWrite = chrome.storage.local.set({
    scannerState: {
      ...first,
      candles: [{ time: 2, close: 1.2 }],
      signal: { state: 'CONFIRM', direction: 'BUY' }
    }
  });

  const staleWrite = chrome.storage.local.set({
    scannerState: {
      ...stale,
      diagnostics: { ...stale.diagnostics, network: { lastSeen: 2 } }
    }
  });

  await Promise.all([firstWrite, staleWrite]);

  assert.deepEqual(backing.scannerState.candles, [{ time: 2, close: 1.2 }]);
  assert.deepEqual(backing.scannerState.signal, { state: 'CONFIRM', direction: 'BUY' });
  assert.deepEqual(backing.scannerState.diagnostics, { seed: true, network: { lastSeen: 2 } });
});

test('atomic patches preserve explicit property deletions from stale reads', async () => {
  const { backing, local } = makeStorage({
    scannerState: {
      asset: 'EUR/USD (OTC)',
      candles: [{ time: 1, close: 1.1 }],
      signal: { state: 'WAIT', direction: null },
      diagnostics: {
        focusedAsset: { asset: 'EUR/USD (OTC)' },
        network: { lastSeen: 1 },
        access: { state: 'licensed' }
      }
    }
  });

  await loadAtomic(local, 'deletions');
  const base = (await chrome.storage.local.get('scannerState')).scannerState;

  await chrome.storage.local.set({
    scannerState: {
      ...base,
      diagnostics: {}
    }
  });

  assert.deepEqual(backing.scannerState.diagnostics, {});
  assert.equal(Object.prototype.hasOwnProperty.call(backing.scannerState.diagnostics, 'focusedAsset'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(backing.scannerState.diagnostics, 'network'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(backing.scannerState.diagnostics, 'access'), false);
});

test('atomic store always couples candles and signal in the same patch', () => {
  const source = read('src/services/scanner-state-atomic.js');
  assert.match(source, /let writeQueue = Promise\.resolve\(\)/);
  assert.match(source, /const task = writeQueue\.then/);
  assert.match(source, /const pairTouched = Object\.prototype\.hasOwnProperty\.call\(patch, 'candles'\)[\s\S]*?'signal'/);
  assert.match(source, /candles: clone\(cleanProposed\.candles \?\? \[\]\),[\s\S]*?signal: clone\(cleanProposed\.signal \?\? null\)/);
  assert.match(source, /const DELETE = Symbol\('atsScannerStateDelete'\)/);
  assert.match(source, /if \(!Object\.prototype\.hasOwnProperty\.call\(next, key\)\)[\s\S]*?patch\[key\] = DELETE/);
  assert.match(source, /if \(value === DELETE\)[\s\S]*?delete next\[key\]/);

  const entry = read('src/background-entry.js');
  assert.equal(entry.trim().split('\n')[0], "import './services/scanner-state-atomic.js';");
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

test('every snapshot publisher is gated by the focused asset', () => {
  const network = read('src/content/network-bridge.js');
  const generic = read('src/content/generic-adapter.js');
  const augment = read('src/background-augment.js');

  assert.match(network, /function focusedAsset\(\)/);
  assert.match(network, /const focus = focusedAsset\(\);\s*if \(!focus\) return;/);
  assert.match(network, /!sameAsset\(cleanAsset, focus\)/);
  assert.match(network, /const candidate = bestCandidate\(payload, focus\)/);

  assert.match(generic, /const explicitFocus = canonicalAsset\(globalThis\.__ATS_FOCUSED_ASSET_VALUE__ \|\| ''\);\s*if \(!explicitFocus\) return;/);
  assert.match(generic, /rows\.filter\(r => r\.asset && sameAsset\(r\.asset, explicitFocus\)\)/);
  assert.match(generic, /const net = bestNetworkQuote\(explicitFocus\)/);
  assert.match(generic, /const asset = explicitFocus/);

  assert.match(augment, /const focusedAsset = focusedAssetFor\(sender\.tab\.id, scannerState\)/);
  assert.match(augment, /const candidate = chooseCandidate\(payload, focusedAsset\)/);
  assert.match(augment, /if \(!sameAsset\(focusMeta\?\.asset, focusedAsset\)\) return/);
});
