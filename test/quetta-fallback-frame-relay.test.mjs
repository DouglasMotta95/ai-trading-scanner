import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = path => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('reconnect injects secure opaque recovery before ordinary live readers', () => {
  const injector = read('src/background-modern-injector.js');
  const runtimeIndex = injector.indexOf("'src/content/runtime-message-compat.js'");
  const topIndex = injector.indexOf("'src/content/opaque-frame-top-bridge.js'");
  const recoveryIndex = injector.indexOf("'src/content/opaque-frame-recovery.js'");
  const focusIndex = injector.indexOf("'src/content/focused-asset-v2.js'");
  assert.ok(runtimeIndex >= 0);
  assert.ok(topIndex > runtimeIndex);
  assert.ok(recoveryIndex > topIndex);
  assert.ok(focusIndex > recoveryIndex);
});

test('opaque recovery covers the exact empty-host failure seen on Quetta internal chart frames', () => {
  const recovery = read('src/content/opaque-frame-recovery.js');
  const proxy = read('src/background-opaque-frame-proxy.js');
  const top = read('src/content/opaque-frame-top-bridge.js');
  assert.match(recovery, /\['blob:', 'about:', 'data:'\]/);
  assert.match(recovery, /ATS_OPAQUE_FRAME_PROXY/);
  assert.match(recovery, /ATS_VISUAL_FOCUS_V2/);
  assert.match(recovery, /ATS_EMBEDDED_FEED/);
  assert.match(recovery, /ATS_CHART_FRAME_MARKET/);
  assert.match(recovery, /ATS_MARKET_CLOCK_V2/);
  assert.match(recovery, /ATS_DATA_INSPECTOR/);
  assert.match(recovery, /ATS_ACCOUNT_METRICS/);
  assert.match(proxy, /sender\.tab\?\.url/);
  assert.match(proxy, /frameId === 0/);
  assert.match(proxy, /opaqueUrl\(sender\.url\)/);
  assert.match(top, /window !== window\.top/);
  assert.match(top, /ATS_OPAQUE_FRAME_FORWARD/);
});

test('opaque recovery recognizes standalone instruments without inventing a new signal engine', () => {
  const recovery = read('src/content/opaque-frame-recovery.js');
  const background = read('src/background-entry.js');
  assert.match(recovery, /\['TRON','TRX\/USD'\]/);
  assert.match(recovery, /\['EURO','EUR\/USD'\]/);
  assert.match(recovery, /opaque-frame-recovery/);
  assert.match(recovery, /network-server-cycle/);
  assert.match(background, /background-opaque-frame-proxy\.js/);
  assert.match(background, /background-market-session\.js/);
  assert.doesNotMatch(recovery, /processSnapshot|possibleScore|confirmScore|candleStrength|rejectionStrength/);
});
