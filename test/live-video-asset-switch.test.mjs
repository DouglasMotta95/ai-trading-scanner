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
  assert.match(market, /message\?\.type === 'ATS_VISUAL_FOCUS_V2'/);
  assert.match(market, /if \(!info\.trusted \|\| message\.chartScoped !== true \|\| message\.reliable !== true/);
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
  assert.match(reset, /resetOrchestrator\(\)/);
});

test('runtime trusts only CasaTrade-owned charts or legacy trader frames under a CasaTrade top tab', () => {
  const market = read('src/background-market-session.js');
  assert.match(market, /const tabOwned = !!sender\.tab\?\.id && casaHost\(topHost\)/);
  assert.match(market, /const embeddedTrader = tabOwned && Number\(sender\.frameId\) !== 0 && traderHost\(frameHost\)/);
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
