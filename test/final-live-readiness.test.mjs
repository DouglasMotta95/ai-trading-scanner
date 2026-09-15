import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');

test('embedded feed can keep observation moving while the professional decision keeps exact time authority', () => {
  const market = read('src/background-market-session.js');
  const policy = read('src/background-decision-policy.js');
  assert.match(market, /function usableClock\(state = \{\}, info = null\)/);
  assert.match(market, /const candidate = bestForFocus\(payload, asset\)/);
  assert.match(market, /if \(clock\) processed = processLiveSnapshot/);
  assert.match(market, /function evaluateAtClock\(/);
  assert.match(policy, /EXACT_CLOCK_SOURCES/);
  assert.match(policy, /clock\.verified !== true/);
  assert.match(policy, /uiState: 'WAIT'/);
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

  assert.match(reader, /if \(!traderHost\(host\) && !casaHost\(host\)\) return/);
  assert.match(reader, /focus\.trustedChartFrame !== true/);
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

test('sidepanel never presents a tradable state without exact CasaTrade clock and observed expiration', () => {
  const html = read('src/sidepanel/index.html');
  const panel = read('src/sidepanel/app-v2.js');
  const control = read('src/background-control.js');
  assert.match(html, /app-v2\.js/);
  assert.match(panel, /function exactClockReady\(state = \{\}\)/);
  assert.match(panel, /clock\.role === 'candle-close'/);
  assert.match(panel, /function entryTimeReady\(state = \{\}\)/);
  assert.match(panel, /actualExpiration/);
  assert.match(panel, /ESTIMADO • BLOQUEADO/);
  assert.match(panel, /model\.actionable && model\.direction === 'BUY' && timeReady/);
  assert.match(panel, /model\.actionable && model\.direction === 'SELL' && timeReady/);
  assert.match(control, /function exactTradeReady\(state = \{\}\)/);
  assert.match(control, /error: 'time_not_synchronized'/);
});

test('approved base signal thresholds remain unchanged by the professional policy layer', () => {
  const analysis = read('src/core/analysis.js');
  assert.match(analysis, /possibleScore:\s*44/);
  assert.match(analysis, /confirmScore:\s*58/);
  assert.match(analysis, /candleStrength:\s*62/);
  assert.match(analysis, /rejectionStrength:\s*50/);
});
