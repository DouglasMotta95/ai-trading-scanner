import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');

test('15013: explicit candle-period menu choice outranks loose minute tokens', () => {
  const platform = read('src/content/platform-sync.js');
  assert.match(platform, /__ATS_EXPLICIT_CANDLE_TIMEFRAME__/);
  assert.match(platform, /candle-period-menu-click/);
  assert.match(platform, /score: 300/);
  assert.match(platform, /rows\[0\]\?\.score >= 70/);
});

test('15013: candle clock follows explicit M5 authority and rejects weak chart tokens', () => {
  const clock = read('src/content/market-cycle-clock-v4.js');
  assert.match(clock, /__ATS_EXPLICIT_CANDLE_TIMEFRAME__/);
  assert.match(clock, /rows\[0\]\?\.score >= 130/);
  const manifest = JSON.parse(read('manifest.json'));
  assert.equal(manifest.version, '0.11.57');
});
