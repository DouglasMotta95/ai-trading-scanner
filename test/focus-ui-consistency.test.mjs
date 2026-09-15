import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');

test('0.11.10 loads standalone instrument focus and feed fallbacks for normal and recovery injection', () => {
  const manifest = JSON.parse(read('manifest.json'));
  const injector = read('src/background-modern-injector.js');
  const bridge = read('src/content/focused-asset-alias-bridge.js');
  const probe = read('src/content/standalone-instrument-probe.js');
  assert.equal(manifest.version, '0.11.10');
  assert.ok(manifest.content_scripts.some(row => Array.isArray(row.js) && row.js.includes('src/content/focused-asset-alias-bridge.js')));
  assert.ok(manifest.content_scripts.some(row => Array.isArray(row.js) && row.js.includes('src/content/standalone-instrument-probe.js') && row.world === 'MAIN'));
  assert.ok(manifest.content_scripts.some(row => Array.isArray(row.js) && row.js.includes('src/content/opaque-frame-recovery.js') && row.match_origin_as_fallback === true));
  assert.match(injector, /focused-asset-alias-bridge\.js/);
  assert.match(injector, /standalone-instrument-probe\.js/);
  assert.match(injector, /opaque-frame-recovery\.js/);
  assert.match(bridge, /\['TRON', 'TRX\/USD'\]/);
  assert.match(bridge, /\['EURO', 'EUR\/USD'\]/);
  assert.match(bridge, /user-selected-alias/);
  assert.match(bridge, /ATS_VISUAL_FOCUS_V2/);
  assert.match(probe, /\['TRON', 'TRX\/USD'\]/);
  assert.match(probe, /recentCandles/);
  assert.match(probe, /standalone-\$\{transport\}/);
  assert.match(probe, /hookWebSocket/);
  assert.match(probe, /hookWorker\('Worker'\)/);
  assert.match(probe, /hookFetch/);
  assert.match(probe, /hookXhr/);
});

test('focused asset is not duplicated by radar and stale quality is not presented as live', () => {
  const radar = read('src/sidepanel/radar-ui.js');
  const quality = read('src/sidepanel/asset-quality-ui.js');
  assert.match(radar, /filter\(row => row\?\.focused !== true\)/);
  assert.match(quality, /liveCurrentMarket/);
  assert.match(quality, /AGUARDANDO ATIVO AO VIVO/);
});

test('empty validation is hidden and current-market card no longer repeats next-candle decision', () => {
  const html = read('src/sidepanel/index.html');
  const validation = read('src/sidepanel/validation-ui.js');
  assert.match(html, /id="validationCard"[^>]*hidden/);
  assert.match(validation, /card\.hidden = resolved === 0/);
  assert.match(html, /GRÁFICO ATUAL/);
  assert.doesNotMatch(html, /id="analysisTitle"/);
  assert.doesNotMatch(html, /id="analyzingNow"/);
});

test('bankroll false zero values are rejected and stale metrics are cleared on build change', () => {
  const observer = read('src/content/account-metrics-observer.js');
  const background = read('src/background-account-metrics.js');
  const buildGuard = read('src/background-build-guard.js');
  assert.match(observer, /parsed\.value <= 0/);
  assert.match(observer, /value == null \|\| value <= 0/);
  assert.match(background, /positiveRequired && value <= 0/);
  assert.match(background, /currentStake > 0/);
  assert.match(buildGuard, /accountMetrics: null/);
});
