import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');

test('visible CasaTrade chart remains the authoritative asset source on owned or legacy trader documents', () => {
  const focused = read('src/content/focused-asset-v2.js');
  const market = read('src/background-market-session.js');
  assert.match(focused, /const frameRole = traderHost\(host\) \? 'trader-frame' : 'casa-chart-frame'/);
  assert.match(focused, /if \(!traderHost\(host\) && !casaHost\(host\)\) return/);
  assert.match(focused, /chartScoped: true/);
  assert.match(focused, /reliable: true/);
  assert.match(focused, /pointerup/);
  assert.match(focused, /touchend/);
  assert.match(focused, /schedulePublish\(260, false\)/);
  assert.match(focused, /setInterval\(\(\) => schedulePublish\(0, false\), 450\)/);
  assert.match(focused, /setTimeout\(\(\) => \{ invalidateElements\(\); publish\(true\); \}, 80\)/);
  assert.match(market, /message\?\.type === 'ATS_VISUAL_FOCUS_V2'/);
  assert.match(market, /const accepted = trustedChartFrame/);
  assert.match(market, /message\.chartScoped === true/);
  assert.match(market, /message\.reliable === true/);
  assert.match(market, /message\.visualAuthority !== false/);
});

test('panel boot never paints a pre-boot asset snapshot while fresh visual focus is pending', () => {
  const panel = read('src/sidepanel/app-v2.js');
  assert.match(panel, /function focusConfirmedThisPanel\(state = \{\}\)/);
  assert.match(panel, /at >= PANEL_OPENED_AT/);
  assert.match(panel, /bootAwaitingFocus/);
  assert.match(panel, /ATS_REFRESH_MARKET/);
  assert.match(panel, /ATUALIZANDO…/);
});

test('asset or timeframe switch clears every operational field that could leak the previous market', () => {
  const market = read('src/background-market-session.js');
  const start = market.indexOf('function resetForSession');
  const end = market.indexOf('\nfunction clockRecord', start);
  const reset = market.slice(start, end);
  for (const field of ['price: null','candles: []','currentCandle: null','marketHistory: {}','signal: null','lastConfirmed: null','tradeIntent: null','lastSeen: null']) {
    assert.ok(reset.includes(field), `missing reset field: ${field}`);
  }
  assert.match(reset, /marketClock: null/);
  assert.doesNotMatch(reset, /resetOrchestrator\(\)/);

  const central = read('src/background.js');
  assert.match(central, /Single owner of technical analysis/);
  assert.match(central, /const analysisContextChanged = !!lastMarketKey && lastMarketKey !== marketKey/);
  assert.match(central, /if \(analysisContextChanged\) resetOrchestrator\(\)/);
  assert.match(central, /decisionCycle: null/);
  assert.match(central, /professionalDecision: null/);
});

test('runtime trusts only CasaTrade-owned charts or legacy trader frames under a CasaTrade top tab', () => {
  const market = read('src/background-market-session.js');
  assert.match(market, /const tabOwned = !!sender\.tab\?\.id && \(casaHost\(topHost\) \|\| traderHost\(topHost\)\)/);
  assert.match(market, /const embeddedTrader = tabOwned && traderHost\(frameHost\)/);
  assert.match(market, /const casaOwnedChart = tabOwned && casaHost\(frameHost\)/);
  assert.match(market, /trusted: embeddedTrader \|\| casaOwnedChart/);
  assert.match(market, /\['trader-frame', 'casa-chart-frame'\]\.includes\(role\)/);
});

test('overlay never draws analysis for another market, including OTC versus regular', () => {
  const overlay = read('src/content/analysis-visual-overlay-v2.js');
  assert.match(overlay, /const sameMarket = \(a, b\) => !!marketId\(a\) && marketId\(a\) === marketId\(b\)/);
  assert.match(overlay, /if \(!sameMarket\(focus\?\.asset, state\.asset\)\) return false/);
  assert.match(overlay, /if \(!sameMarket\(session\?\.asset, state\.asset\)\) return false/);
  assert.match(overlay, /if \(!sameMarket\(clock\?\.asset, state\.asset\)\) return false/);
  assert.doesNotMatch(overlay, /replace\([^\n]+OTC[^\n]+''\)/);
});
