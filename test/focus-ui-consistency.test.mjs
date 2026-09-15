import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');

test('0.11.7 loads standalone instrument focus fallback for normal and recovery injection', () => {
  const manifest = JSON.parse(read('manifest.json'));
  const injector = read('src/background-modern-injector.js');
  const bridge = read('src/content/focused-asset-alias-bridge.js');
  assert.equal(manifest.version, '0.11.7');
  assert.ok(manifest.content_scripts.some(row => Array.isArray(row.js) && row.js.includes('src/content/focused-asset-alias-bridge.js')));
  assert.match(injector, /focused-asset-alias-bridge\.js/);
  assert.match(bridge, /\['TRON', 'TRX\/USD'\]/);
  assert.match(bridge, /\['EURO', 'EUR\/USD'\]/);
  assert.match(bridge, /user-selected-alias/);
  assert.match(bridge, /ATS_VISUAL_FOCUS_V2/);
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

test('bankroll false zero values are rejected instead of displayed as real metrics', () => {
  const observer = read('src/content/account-metrics-observer.js');
  const background = read('src/background-account-metrics.js');
  assert.match(observer, /parsed\.value <= 0/);
  assert.match(observer, /value == null \|\| value <= 0/);
  assert.match(background, /positiveRequired && value <= 0/);
  assert.match(background, /currentStake > 0/);
});
