import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

function clone(value) { return value == null ? value : structuredClone(value); }
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
    async set(items) { for (const [key, value] of Object.entries(items || {})) backing[key] = clone(value); }
  };
  return { backing, local };
}
async function loadAtomic(local, suffix) {
  globalThis.chrome = { storage: { local } };
  const moduleUrl = pathToFileURL(path.join(root, 'src/services/scanner-state-atomic.js')).href;
  return import(`${moduleUrl}?atomic-regression=${suffix}-${Date.now()}-${Math.random()}`);
}

test('scannerState updates are serialized and each mutator reads the latest committed state', async () => {
  const { backing, local } = makeStorage({ scannerState: { asset: 'EUR/USD (OTC)', candles: [{ time: 1, close: 1.1 }], signal: { state: 'WAIT', direction: null }, diagnostics: { seed: true } } });
  const atomic = await loadAtomic(local, 'serialized');
  const firstWrite = atomic.updateScannerState(async current => {
    await new Promise(resolve => setTimeout(resolve, 10));
    return { ...current, candles: [{ time: 2, close: 1.2 }], signal: { state: 'CONFIRM', direction: 'BUY' } };
  });
  const secondWrite = atomic.updateScannerState(current => ({ ...current, diagnostics: { ...current.diagnostics, network: { lastSeen: 2 } } }));
  await Promise.all([firstWrite, secondWrite]);
  assert.deepEqual(backing.scannerState.candles, [{ time: 2, close: 1.2 }]);
  assert.deepEqual(backing.scannerState.signal, { state: 'CONFIRM', direction: 'BUY' });
  assert.deepEqual(backing.scannerState.diagnostics, { seed: true, network: { lastSeen: 2 } });
});

test('explicit state replacement can delete properties without stale patch reconstruction', async () => {
  const { backing, local } = makeStorage({ scannerState: { asset: 'EUR/USD (OTC)', diagnostics: { focusedAsset: { asset: 'EUR/USD (OTC)' }, network: { lastSeen: 1 }, access: { state: 'licensed' } } } });
  const atomic = await loadAtomic(local, 'deletions');
  await atomic.updateScannerState(current => ({ ...current, diagnostics: {} }));
  assert.deepEqual(backing.scannerState.diagnostics, {});
});

test('runtime scannerState writers use the central atomic queue', () => {
  const atomic = read('src/services/scanner-state-atomic.js');
  assert.match(atomic, /let scannerStateWriteQueue = Promise\.resolve\(\)/);
  assert.match(atomic, /export function updateScannerState\(mutator\)/);
  assert.match(atomic, /const task = scannerStateWriteQueue\.then/);
  assert.match(atomic, /const current = await storedScannerState\(\)/);
  assert.doesNotMatch(atomic, /chrome\.storage\.local\.get\s*=/);
  assert.doesNotMatch(atomic, /chrome\.storage\.local\.set\s*=/);

  for (const file of ['src/background-market-session.js', 'src/background-control.js']) {
    const source = read(file);
    assert.match(source, /updateScannerState/);
    assert.doesNotMatch(source, /chrome\.storage\.local\.set\s*\(\s*\{\s*scannerState\b/);
  }
});

test('live market identity keeps OTC distinct from the regular pair', () => {
  const market = read('src/background-market-session.js');
  const focus = read('src/content/focused-asset-v2.js');
  assert.match(market, /\$\{direct\[1\]\}\/\$\{direct\[2\]\}\$\{otc \? ' \(OTC\)' : ''\}/);
  assert.match(market, /const sameMarket = \(a, b\) => !!marketId\(a\) && marketId\(a\) === marketId\(b\)/);
  assert.match(focus, /OTC and regular quotes are different live markets/);
  assert.match(focus, /const identity = value => canonicalAsset\(value\)/);
  assert.doesNotMatch(market, /replace\([^\n]+OTC[^\n]+''\)/);
});

test('single live market session keeps visual chart focus authoritative without generic fallback guessing', () => {
  const manifest = JSON.parse(read('manifest.json'));
  const scripts = manifest.content_scripts.flatMap(row => row.js || []);
  const focus = read('src/content/focused-asset-v2.js');
  const market = read('src/background-market-session.js');
  const bridge = read('src/content/embedded-feed-bridge.js');

  assert.ok(scripts.includes('src/content/focused-asset-v2.js'));
  assert.ok(scripts.includes('src/content/embedded-feed-bridge.js'));
  assert.ok(!scripts.includes('src/content/generic-adapter.js'));
  assert.ok(!scripts.includes('src/content/network-bridge.js'));
  assert.match(focus, /type: 'ATS_VISUAL_FOCUS_V2'/);
  assert.match(focus, /frameRole: 'trader-frame'/);
  assert.match(market, /const focus = state\.diagnostics\?\.focusedAsset/);
  assert.match(market, /const candidate = bestForFocus\(payload, asset\)/);
  assert.match(market, /if \(!candidate\) return/);
  assert.match(market, /session-integrity/);
  assert.match(bridge, /ATS_EMBEDDED_FEED/);
});
