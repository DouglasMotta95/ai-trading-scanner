import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');

test('callback-only Android runtime resolves extension messages through the shared bridge', async () => {
  const source = read('src/content/runtime-message-compat.js');
  const chrome = {
    runtime: {
      lastError: null,
      sendMessage(message, callback) {
        queueMicrotask(() => callback({ ok: true, echoedType: message.type }));
        return undefined;
      }
    }
  };
  const context = vm.createContext({ chrome, Promise, queueMicrotask });
  vm.runInContext(source, context);
  assert.equal(typeof context.__ATS_SEND_MESSAGE__, 'function');
  const response = await context.__ATS_SEND_MESSAGE__({ type: 'PING' });
  assert.equal(response.ok, true);
  assert.equal(response.echoedType, 'PING');
});

test('Android runtime bridge loads before every isolated live reader, including recovery injection', () => {
  const manifest = JSON.parse(read('manifest.json'));
  const relevantGroups = manifest.content_scripts.filter(row => (row.js || []).some(file => [
    'src/content/focused-asset-v2.js',
    'src/content/embedded-feed-bridge.js',
    'src/content/platform-sync.js',
    'src/content/market-cycle-clock-v4.js',
    'src/content/account-metrics-observer.js',
    'src/content/analysis-visual-overlay-v2.js'
  ].includes(file)));
  assert.ok(relevantGroups.length >= 2);
  for (const group of relevantGroups) {
    assert.equal(group.js[0], 'src/content/runtime-message-compat.js');
    assert.equal(group.world, undefined);
  }

  const injector = read('src/background-modern-injector.js');
  const compat = injector.indexOf("'src/content/runtime-message-compat.js'");
  for (const file of ['focused-asset-v2.js','embedded-feed-bridge.js','platform-sync.js','market-cycle-clock-v4.js','account-metrics-observer.js','analysis-visual-overlay-v2.js']) {
    assert.ok(injector.indexOf(file) > compat, `${file} must load after runtime compatibility`);
  }
});

test('critical Quetta live readers do not assume chrome.runtime.sendMessage returns a Promise', () => {
  for (const file of [
    'src/content/chart-frame-market-reader.js',
    'src/content/embedded-feed-bridge.js',
    'src/content/platform-sync.js',
    'src/content/market-cycle-clock-v4.js',
    'src/content/account-metrics-observer.js',
    'src/content/analysis-visual-overlay-v2.js'
  ]) {
    const source = read(file);
    assert.match(source, /globalThis\.__ATS_SEND_MESSAGE__/);
    assert.doesNotMatch(source, /chrome\.runtime\.sendMessage\([^\n]+\)\.catch/);
  }
});
