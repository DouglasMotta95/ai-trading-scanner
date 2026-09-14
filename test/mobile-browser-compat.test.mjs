import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('chrome compat resolves callback-only storage APIs used by Android extension browsers', async () => {
  const backing = { scannerState: { asset: 'EUR/USD (OTC)' } };
  globalThis.chrome = {
    runtime: { lastError: null },
    storage: {
      local: {
        get(keys, callback) {
          const out = typeof keys === 'string' ? { [keys]: backing[keys] } : { ...backing };
          queueMicrotask(() => callback(out));
          return undefined;
        },
        set(items, callback) {
          Object.assign(backing, items || {});
          queueMicrotask(() => callback());
          return undefined;
        },
        remove(keys, callback) {
          for (const key of Array.isArray(keys) ? keys : [keys]) delete backing[key];
          queueMicrotask(() => callback());
          return undefined;
        }
      }
    }
  };
  const url = pathToFileURL(path.join(root, 'src/services/chrome-compat.js')).href + `?mobile=${Date.now()}`;
  const compat = await import(url);
  assert.deepEqual(await compat.storageLocalGet('scannerState'), { scannerState: { asset: 'EUR/USD (OTC)' } });
  await compat.storageLocalSet({ sample: 7 });
  assert.equal(backing.sample, 7);
  await compat.storageLocalRemove('sample');
  assert.equal(backing.sample, undefined);
});

test('mobile focus tracker keeps the user-selected asset authoritative and listens to touch events', () => {
  const focus = read('src/content/focused-asset.js');
  const augment = read('src/background-augment.js');
  const manifest = JSON.parse(read('manifest.json'));
  assert.doesNotMatch(focus, /USER_SELECTION_MS/);
  assert.match(focus, /if \(userSelection\)/);
  assert.match(focus, /!scanned\.explicit/);
  assert.match(focus, /event\.composedPath/);
  assert.match(focus, /addEventListener\('touchend'/);
  assert.match(focus, /explicit: candidate\.explicit === true/);
  assert.match(augment, /previousProtected/);
  assert.match(augment, /trustedEmbeddedVisual/);
  const focused = manifest.content_scripts.find(row => row.js?.includes('src/content/focused-asset.js'));
  assert.equal(focused.all_frames, true);
  assert.ok(focused.matches.some(value => value.includes('casatraders.online')));
});

test('sidepanel no longer depends on Promise-returning chrome APIs for startup', () => {
  const app = read('src/sidepanel/app.js');
  const atomic = read('src/services/scanner-state-atomic.js');
  assert.match(app, /function uiChromeCall/);
  assert.match(app, /uiStorageGet\(LAST_VALID_LICENSE_KEY\)/);
  assert.match(app, /uiSendMessage\(\{ type: 'ATS_READ_SCANNER_STATE' \}\)/);
  assert.match(app, /IDENTIFICANDO ATIVO ABERTO/);
  assert.match(atomic, /storageLocalGet\('scannerState'\)/);
  assert.doesNotMatch(atomic, /await originalGet/);
});
