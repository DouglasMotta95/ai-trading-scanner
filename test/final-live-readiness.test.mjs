import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');

test('embedded feed updates market data while exact candle clock remains the decision authority', () => {
  const market = read('src/background-market-session.js');
  assert.match(market, /function exactClock\(state = \{\}, info = null\)/);
  assert.match(market, /clean\(clock\.role\) !== 'candle-close'/);
  assert.match(market, /const candidate = bestForFocus\(payload, asset\)/);
  assert.match(market, /const clock = exactClock\(state, info\)/);
  assert.match(market, /if \(clock\) processed = processSnapshot/);
  assert.match(market, /function evaluateAtClock\(/);
  assert.match(market, /return evaluateAtClock\(clockState, focus, record\)/);
});

test('stored candle history is reused for the exact live market instead of waiting for new candles', () => {
  const market = read('src/background-market-session.js');
  assert.match(market, /function stateHistory\(state = \{\}, asset = ''\)/);
  assert.match(market, /state\.marketHistory/);
  assert.match(market, /function mergeRows\(/);
  assert.match(market, /const mergedHistory = mergeRows\(previousHistory, incomingHistory\)/);
  assert.match(market, /\[asset\]: mergedHistory/);
});

test('visible chart has a direct price fallback that cannot choose an asset by itself', () => {
  const reader = read('src/content/chart-frame-market-reader.js');
  const market = read('src/background-market-session.js');
  const entry = read('src/background-entry.js');
  const manifest = JSON.parse(read('manifest.json'));
  const scripts = manifest.content_scripts.flatMap(row => row.js || []);

  assert.match(reader, /if \(!traderHost\(host\)\) return/);
  assert.match(reader, /state\.diagnostics\?\.focusedAsset/);
  assert.match(reader, /type: 'ATS_CHART_FRAME_MARKET'/);
  assert.match(market, /async function applyChartPrice/);
  assert.match(market, /const focus = state\.diagnostics\?\.focusedAsset/);
  assert.match(market, /if \(message\.asset && !sameMarket\(message\.asset, focus\.asset\)\) return/);
  assert.doesNotMatch(market.slice(market.indexOf('async function applyChartPrice'), market.indexOf('async function applyInspector')), /processSnapshot\(/);
  assert.match(entry, /background-market-session\.js/);
  assert.ok(scripts.includes('src/content/chart-frame-market-reader.js'));
});

test('live chart focus scans are coalesced and user interaction still forces a fresh scan', () => {
  const focus = read('src/content/focused-asset-v2.js');
  assert.match(focus, /function schedulePublish\(/);
  assert.match(focus, /new MutationObserver\(\(\) => schedulePublish\(160, false\)\)/);
  assert.match(focus, /setInterval\(\(\) => schedulePublish\(0, false\), 800\)/);
  assert.match(focus, /invalidateElements\(\)/);
  assert.match(focus, /touchend/);
  assert.doesNotMatch(focus, /new MutationObserver\(\(\) => publish\(false\)\)/);
});

test('sidepanel never presents a live tradable state without authoritative candle-close clock', () => {
  const html = read('src/sidepanel/index.html');
  const panel = read('src/sidepanel/app-v2.js');
  assert.match(html, /app-v2\.js/);
  assert.match(panel, /function exactClockReady\(state = \{\}\)/);
  assert.match(panel, /clock\.role === 'candle-close'/);
  assert.match(panel, /SINCRONIZANDO VELA/);
  assert.match(panel, /Aguardando o fechamento exato da vela da CasaTrade/);
  assert.match(panel, /prepareBuy'\)\.disabled = model\.key !== 'ENTER_BUY'/);
  assert.match(panel, /prepareSell'\)\.disabled = model\.key !== 'ENTER_SELL'/);
});

test('approved signal thresholds are unchanged by final live-readiness hardening', () => {
  const analysis = read('src/core/analysis.js');
  assert.match(analysis, /possibleScore:\s*44/);
  assert.match(analysis, /confirmScore:\s*58/);
  assert.match(analysis, /candleStrength:\s*62/);
  assert.match(analysis, /rejectionStrength:\s*50/);
});
