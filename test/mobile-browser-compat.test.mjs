import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Regressions captured from the real Quetta/Android CasaTrade test session.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('chrome compat resolves callback-only storage APIs used by Android extension browsers', async () => {
  const backing = { scannerState: { asset: 'EUR/USD (OTC)' } };
  globalThis.chrome = {
    runtime: { lastError: null },
    storage: { local: {
      get(keys, callback) { const out = typeof keys === 'string' ? { [keys]: backing[keys] } : { ...backing }; queueMicrotask(() => callback(out)); return undefined; },
      set(items, callback) { Object.assign(backing, items || {}); queueMicrotask(() => callback()); return undefined; },
      remove(keys, callback) { for (const key of Array.isArray(keys) ? keys : [keys]) delete backing[key]; queueMicrotask(() => callback()); return undefined; }
    } }
  };
  const url = pathToFileURL(path.join(root, 'src/services/chrome-compat.js')).href + `?mobile=${Date.now()}`;
  const compat = await import(url);
  assert.deepEqual(await compat.storageLocalGet('scannerState'), { scannerState: { asset: 'EUR/USD (OTC)' } });
  await compat.storageLocalSet({ sample: 7 });
  assert.equal(backing.sample, 7);
  await compat.storageLocalRemove('sample');
  assert.equal(backing.sample, undefined);
});

test('mobile focus tracker uses the visible CasaTrade chart and reacts immediately to touch selection', () => {
  const focus = read('src/content/focused-asset-v2.js');
  const market = read('src/background-market-session.js');
  const manifest = JSON.parse(read('manifest.json'));
  assert.match(focus, /ariaSelected === 'true'/);
  assert.match(focus, /ariaSelected === 'false'/);
  assert.match(focus, /chartScoped: true/);
  assert.match(focus, /const frameRole = traderHost\(host\) \? 'trader-frame' : 'casa-chart-frame'/);
  assert.match(focus, /document\.addEventListener\('touchend'/);
  assert.match(focus, /invalidateElements\(\)/);
  assert.match(market, /message\?\.type === 'ATS_VISUAL_FOCUS_V2'/);
  assert.match(market, /message\.chartScoped !== true/);
  const focused = manifest.content_scripts.find(row => row.js?.includes('src/content/focused-asset-v2.js'));
  assert.equal(focused.all_frames, true);
  assert.ok(focused.matches.some(value => value.includes('casatrade.com')));
  assert.ok(focused.matches.some(value => value.includes('casatraders.online')));
});

test('sidepanel startup uses message-based scanner reads and callback-compatible atomic storage', () => {
  const app = read('src/sidepanel/app-v2.js');
  const atomic = read('src/services/scanner-state-atomic.js');
  assert.match(app, /chrome\.runtime\.sendMessage\(\{ type: 'ATS_READ_SCANNER_STATE' \}\)/);
  assert.match(app, /requestAnimationFrame/);
  assert.match(app, /IDENTIFICANDO ATIVO/);
  assert.match(atomic, /storageLocalGet\('scannerState'\)/);
  assert.doesNotMatch(atomic, /await originalGet/);
});
