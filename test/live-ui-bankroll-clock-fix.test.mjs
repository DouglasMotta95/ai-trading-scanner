import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = path => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('CasaTrade-owned chart focus can become live and render overlay without legacy iframe flag', () => {
  const app = read('src/sidepanel/app-v2.js');
  const overlay = read('src/content/analysis-visual-overlay-v2.js');
  assert.match(app, /focus\.embeddedTrader === true \|\| focus\.casaTradeFrame === true/);
  assert.match(app, /focus\.trustedChartFrame === true/);
  assert.doesNotMatch(app, /focus\.embeddedTrader === true\s*&&\s*sameMarket/);
  assert.match(overlay, /focus\?\.embeddedTrader !== true && focus\?\.casaTradeFrame !== true/);
  assert.match(overlay, /focus\?\.trustedChartFrame !== true/);
  assert.doesNotMatch(overlay, /if \(!inTraderFrame\) return null/);
});

test('reconnect refuses to paint a stale same-tab asset as current market', () => {
  const control = read('src/background-control.js');
  assert.match(control, /const preserveLive = sameTab && current\.connection === 'online' && focusFresh && dataFresh/);
  assert.match(control, /Date\.now\(\) - Number\(focus\.at\) < 2500/);
  assert.match(control, /delete diagnostics\.focusedAsset/);
  assert.match(control, /asset: null, price: null, timeframe: null, analysisTimeframe: null/);
});

test('bankroll reader covers unlabeled top balance plus CasaTrade Invest and Lucro labels', () => {
  const observer = read('src/content/account-metrics-observer.js');
  assert.match(observer, /function topBarBalanceCandidate\(\)/);
  assert.match(observer, /rect\.top >= 0 && rect\.top <= Math\.max\(220, innerHeight \* \.20\)/);
  assert.match(observer, /deposit\|depositar\|withdraw\|sacar/);
  assert.match(observer, /STAKE_RE = .*invest/);
  assert.match(observer, /PAYOUT_RE = .*lucro\|profit/);
  assert.match(observer, /if \(el\.shadowRoot\) roots\.push\(el\.shadowRoot\)/);
});

test('network candle clock needs advancing near-real server timestamps and never overrides healthy DOM clock', () => {
  const bridge = read('src/content/embedded-feed-bridge.js');
  assert.match(bridge, /currentClock\?\.source === 'trader-dom-countdown'/);
  assert.match(bridge, /Math\.abs\(now - serverTime\) > 7000/);
  assert.match(bridge, /serverDelta > 0 && serverDelta <= 5000/);
  assert.match(bridge, /Math\.abs\(serverDelta - localDelta\) <= 1800/);
  assert.match(bridge, /if \(count < 2/);
  assert.match(bridge, /clockSource: 'network-server-cycle'/);
  assert.match(bridge, /clockMode: 'structured-server-time'/);
});
