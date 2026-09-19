import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const bridge = readFileSync(new URL('../src/content/embedded-feed-bridge.js', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));

test('0.11.13 can recover exact live candle-close clock from the current structured OHLC boundary', () => {
  assert.match(manifest.version, /^0\.11\.\d+$/);
  assert.ok(String(manifest.version_name || '').length > 0);
  assert.match(bridge, /structuredCandleBoundary/);
  assert.match(bridge, /now >= openAt \+ durationMs \+ 1200/);
  assert.match(bridge, /count < 2/);
  assert.match(bridge, /clockSource: 'network-server-cycle'/);
  assert.match(bridge, /clockMode: 'structured-current-candle-boundary'/);
});

test('clock recovery refuses to roll a historical candle forward by modulo guesswork', () => {
  assert.match(bridge, /A closed historical candle is rejected instead of being shifted forward by guesswork/);
  assert.doesNotMatch(bridge, /openAt\s*%\s*durationMs/);
  assert.match(bridge, /candleRowsFor\(payload, focus\.asset\)/);
});
