import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const workerProbeUrl = new URL('../src/content/worker-probe.js', import.meta.url);

async function runProbeWithPayload(payload) {
  const source = await readFile(workerProbeUrl, 'utf8');
  const posted = [];
  let messageHandler = null;

  const window = {
    addEventListener(type, handler) {
      if (type === 'message') messageHandler = handler;
    },
    postMessage(message) {
      posted.push(message);
    }
  };
  window.window = window;

  const context = vm.createContext({
    window,
    navigator: { serviceWorker: null },
    Blob,
    ArrayBuffer,
    TextDecoder,
    Uint8Array,
    setTimeout,
    clearTimeout,
    console
  });

  vm.runInContext(source, context, { filename: 'worker-probe.js' });
  assert.equal(typeof messageHandler, 'function', 'worker probe should register its message listener');

  messageHandler({ data: payload });
  await new Promise(resolve => setTimeout(resolve, 130));

  return posted.find(message => message?.source === 'ATS_NETWORK_PROBE' && message?.type === 'summary');
}

test('nested generic price cannot overwrite the stronger root market quote', async () => {
  const rootPrice = 1.08765;
  const nestedGenericPrice = 999.99;
  const summary = await runProbeWithPayload({
    asset: 'EUR/USD',
    active_id: 1,
    price: rootPrice,
    timestamp: Date.now(),
    metadata: {
      price: nestedGenericPrice
    }
  });

  assert.ok(summary, 'worker probe should publish a market summary');
  const eurUsd = summary.payload.candidates.find(candidate => candidate.asset === 'EUR/USD');
  assert.ok(eurUsd, 'root EUR/USD quote should remain available');
  assert.equal(eurUsd.price, rootPrice, 'generic nested price must not replace the validated root quote');
  assert.equal(eurUsd.confidence, 92, 'root active-id quote should keep its own confidence');
});

test('an equal-confidence legitimate quote may replace the previous price', async () => {
  const source = await readFile(workerProbeUrl, 'utf8');
  const posted = [];
  let messageHandler = null;

  const window = {
    addEventListener(type, handler) {
      if (type === 'message') messageHandler = handler;
    },
    postMessage(message) {
      posted.push(message);
    }
  };
  window.window = window;

  const context = vm.createContext({
    window,
    navigator: { serviceWorker: null },
    Blob,
    ArrayBuffer,
    TextDecoder,
    Uint8Array,
    setTimeout,
    clearTimeout,
    console
  });

  vm.runInContext(source, context, { filename: 'worker-probe.js' });
  messageHandler({ data: { asset: 'EUR/USD', active_id: 1, price: 1.08765 } });
  await new Promise(resolve => setTimeout(resolve, 120));
  posted.length = 0;
  messageHandler({ data: { asset: 'EUR/USD', active_id: 1, price: 1.08780 } });
  await new Promise(resolve => setTimeout(resolve, 130));

  const summary = posted.find(message => message?.source === 'ATS_NETWORK_PROBE' && message?.type === 'summary');
  const eurUsd = summary?.payload?.candidates?.find(candidate => candidate.asset === 'EUR/USD');
  assert.ok(eurUsd);
  assert.equal(eurUsd.price, 1.08780, 'equal-confidence legitimate quote should update the market price');
  assert.equal(eurUsd.confidence, 92);
});
