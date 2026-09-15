import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');

test('visible trader chart is the authoritative asset source', () => {
  const focused = read('src/content/focused-asset-v2.js');
  const market = read('src/background-market-session.js');
  assert.match(focused, /frameRole: 'trader-frame'/);
  assert.match(focused, /chartScoped: true/);
  assert.match(focused, /reliable: true/);
  assert.match(focused, /pointerup/);
  assert.match(focused, /touchend/);
  assert.match(market, /message\.type === 'ATS_VISUAL_FOCUS_V2'/);
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

test('runtime trusts only embedded trader frames under a CasaTrade top tab', () => {
  const market = read('src/background-market-session.js');
  assert.match(market, /sender\.frameId !== 0/);
  assert.match(market, /traderHost\(frameHost\)/);
  assert.match(market, /casaHost\(topHost\)/);
  assert.match(market, /trusted:/);
});

test('overlay never draws analysis for another market, including OTC versus regular', () => {
  const overlay = read('src/content/analysis-visual-overlay-v2.js');
  assert.match(overlay, /const sameMarket = \(a, b\) => !!marketId\(a\) && marketId\(a\) === marketId\(b\)/);
  assert.match(overlay, /if \(!sameMarket\(focus\?\.asset, state\.asset\)\) return false/);
  assert.match(overlay, /if \(!sameMarket\(session\?\.asset, state\.asset\)\) return false/);
  assert.match(overlay, /if \(!sameMarket\(clock\?\.asset, state\.asset\)\) return false/);
  assert.doesNotMatch(overlay, /replace\([^\n]+OTC[^\n]+''\)/);
});
