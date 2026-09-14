import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');

test('embedded feed can update market data but only authoritative candle clock can drive decisions', () => {
  const augment = read('src/background-augment.js');
  assert.match(augment, /function authoritativeClock\(/);
  assert.match(augment, /clean\(clock\.role\) !== 'candle-close'/);
  assert.match(augment, /if \(!frameMatchesFocus\) return/);
  assert.match(augment, /if \(!clock\) return base/);
  assert.match(augment, /serverTime: clock \? Date\.now\(\) : null/);
  assert.match(augment, /clockAuthoritative: !!clock/);
  assert.match(augment, /const processed = processSnapshot\(snapshot, base\)/);
});

test('stored network candle history is reused instead of waiting for new live candles after a sparse update', () => {
  const augment = read('src/background-augment.js');
  assert.match(augment, /function historyForState\(/);
  assert.match(augment, /scannerState\.marketHistory/);
  assert.match(augment, /function mergeHistory\(/);
  assert.match(augment, /const candles = mergeHistory\(historyForState\(scannerState, asset\), payloadCandles\)/);
});

test('visible chart has a direct price fallback that cannot choose an asset by itself', () => {
  const reader = read('src/content/chart-frame-market-reader.js');
  const background = read('src/background-chart-market.js');
  const entry = read('src/background-entry.js');
  const manifest = JSON.parse(read('manifest.json'));
  const scripts = manifest.content_scripts.flatMap(row => row.js || []);

  assert.match(reader, /if \(!traderHost\(host\)\) return/);
  assert.match(reader, /state\.diagnostics\?\.focusedAsset/);
  assert.match(reader, /type: 'ATS_CHART_FRAME_MARKET'/);
  assert.match(background, /sameAuthoritativeFrame/);
  assert.match(background, /focus\?\.chartScoped === true/);
  assert.match(background, /focus\?\.embeddedTrader === true/);
  assert.doesNotMatch(background, /processSnapshot\(/);
  assert.match(entry, /background-chart-market\.js/);
  assert.ok(scripts.includes('src/content/chart-frame-market-reader.js'));
});

test('live chart focus scans are debounced instead of rescanning for every chart mutation', () => {
  const focus = read('src/content/focused-asset-v2.js');
  assert.match(focus, /function schedulePublish\(/);
  assert.match(focus, /new MutationObserver\(\(\) => schedulePublish\(120, false\)\)/);
  assert.match(focus, /setInterval\(\(\) => schedulePublish\(0, false\), 450\)/);
  assert.doesNotMatch(focus, /new MutationObserver\(\(\) => publish\(false\)\)/);
});

test('sidepanel never presents a connected tradable state without the authoritative candle-close clock', () => {
  const html = read('src/sidepanel/index.html');
  const guard = read('src/sidepanel/live-integrity-ui.js');
  assert.match(html, /live-integrity-ui\.js/);
  assert.match(guard, /function authoritativeClockReady\(/);
  assert.match(guard, /clean\(clock\.role\) === 'candle-close'/);
  assert.match(guard, /SINCRONIZANDO VELA/);
  assert.match(guard, /AGUARDANDO RELÓGIO DA VELA/);
  assert.match(guard, /prepareBuy'\)\.disabled = true/);
  assert.match(guard, /prepareSell'\)\.disabled = true/);
});

test('approved signal thresholds are unchanged by final live-readiness hardening', () => {
  const analysis = read('src/core/analysis.js');
  assert.match(analysis, /possibleScore:\s*44/);
  assert.match(analysis, /confirmScore:\s*58/);
  assert.match(analysis, /candleStrength:\s*62/);
  assert.match(analysis, /rejectionStrength:\s*50/);
});
