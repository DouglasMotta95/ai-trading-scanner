import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = path => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('reconnect injects Quetta fallback relay before ordinary live readers', () => {
  const injector = read('src/background-modern-injector.js');
  const runtimeIndex = injector.indexOf("'src/content/runtime-message-compat.js'");
  const relayIndex = injector.indexOf("'src/content/quetta-fallback-frame-bridge.js'");
  const focusIndex = injector.indexOf("'src/content/focused-asset-v2.js'");
  assert.ok(runtimeIndex >= 0);
  assert.ok(relayIndex > runtimeIndex);
  assert.ok(focusIndex > relayIndex);
});

test('fallback relay covers the exact empty-host failure seen on Quetta internal chart frames', () => {
  const bridge = read('src/content/quetta-fallback-frame-bridge.js');
  assert.match(bridge, /\['blob:', 'about:', 'data:'\]/);
  assert.match(bridge, /document\.referrer/);
  assert.match(bridge, /location\.origin/);
  assert.match(bridge, /window\.top\.postMessage/);
  assert.match(bridge, /ATS_QUETTA_FALLBACK_FRAME_RELAY/);
  assert.match(bridge, /ATS_VISUAL_FOCUS_V2/);
  assert.match(bridge, /ATS_EMBEDDED_FEED/);
  assert.match(bridge, /ATS_CHART_FRAME_MARKET/);
  assert.match(bridge, /ATS_MARKET_CLOCK_V2/);
  assert.match(bridge, /ATS_DATA_INSPECTOR/);
  assert.match(bridge, /ATS_ACCOUNT_METRICS/);
});

test('fallback relay recognizes standalone instruments without inventing a new signal engine', () => {
  const bridge = read('src/content/quetta-fallback-frame-bridge.js');
  assert.match(bridge, /\['TRON', 'TRX\/USD'\]/);
  assert.match(bridge, /\['EURO', 'EUR\/USD'\]/);
  assert.match(bridge, /fallback-frame-user/);
  assert.match(bridge, /network-server-cycle/);
  assert.doesNotMatch(bridge, /processSnapshot|possibleScore|confirmScore|candleStrength|rejectionStrength/);
});
