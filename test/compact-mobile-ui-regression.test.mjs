import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = path => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('primary scanner view keeps connect, live market, decision and manual directions above advanced sections', () => {
  const html = read('src/sidepanel/index.html');
  const connect = html.indexOf('id="connectScanner"');
  const market = html.indexOf('class="market-hero');
  const decision = html.indexOf('id="decisionCard"');
  const buy = html.indexOf('id="prepareBuy"');
  const sell = html.indexOf('id="prepareSell"');
  const live = html.indexOf('compact-live-card');
  const advanced = html.indexOf('<details class="advanced-panel"');

  for (const value of [connect, market, decision, buy, sell, live, advanced]) assert.ok(value >= 0);
  assert.ok(connect < market);
  assert.ok(market < decision);
  assert.ok(decision < buy && buy < live);
  assert.ok(decision < sell && sell < live);
  assert.ok(live < advanced);
  assert.match(html, /compact-live\.css/);
});

test('compact sidepanel does not load nonessential polling panels or duplicate diagnostics', () => {
  const html = read('src/sidepanel/index.html');
  for (const script of [
    'radar-ui.js',
    'validation-ui.js',
    'manual-trade-ui.js',
    'bankroll-ui.js',
    'expiration-guard-ui.js',
    'diagnostics-live-extra.js'
  ]) assert.doesNotMatch(html, new RegExp(script.replace('.', '\\.')));

  assert.match(html, /diagnostics-export\.js/);
  assert.doesNotMatch(html, /id="assetRadarList"/);
  assert.doesNotMatch(html, /id="validationCard"/);
});

test('compact profile exposes only the current A+ M1/M5 operation selector', () => {
  const html = read('src/sidepanel/index.html');
  const app = read('src/sidepanel/app-v2.js');

  for (const id of ['analystMode','holdSeconds','desiredExpiration','overlayToggle']) {
    assert.doesNotMatch(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /id="operatingTimeframe"/);
  assert.match(html, /M1 • expiração 1 min/);
  assert.match(html, /M5 • expiração 5 min/);
  assert.match(app, /analystMode: 'A_PLUS'/);
  assert.match(app, /holdSeconds: 3/);
  assert.match(app, /requiredExpirationForTimeframe/);
});

test('decision policy and entry gates share the same authoritative clock sources', () => {
  const policy = read('src/background-decision-policy.js');
  const control = read('src/background-control.js');
  const app = read('src/sidepanel/app-v2.js');

  for (const source of ['trader-dom-countdown','network-server-cycle']) {
    assert.match(policy, new RegExp(source));
    assert.match(control, new RegExp(source));
    assert.match(app, new RegExp(source));
  }
  assert.doesNotMatch(policy, /structured-candle-boundary/);
});
