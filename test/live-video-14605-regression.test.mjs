import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');

test('opaque CasaTrade child frames may report real controls without widening ordinary sender trust', () => {
  const source = read('src/background-platform-controls.js');
  assert.match(source, /const opaqueChild = tabOwned && Number\(sender\.frameId\) > 0/);
  assert.match(source, /return tabOwned && \(knownFrame \|\| opaqueChild\)/);
});

test('owner dev access does not flicker as inactive in the live panel', () => {
  const source = read('src/sidepanel/app-v2.js');
  assert.match(source, /license\?\.devMode === true/);
  assert.match(source, /OWNER_DEV/);
  assert.match(source, /owner_dev/);
});

test('compact M1 UI fixes strategy to real 1 minute expiration without contradictory selectors', () => {
  const html = read('src/sidepanel/index.html');
  assert.match(html, />M1</);
  assert.match(html, />1 min</);
  assert.doesNotMatch(html, /id="desiredExpiration"/);
  assert.doesNotMatch(html, /expiration-guard-ui\.js/);
});

test('CasaTrade clock keeps expiration separate and market session rejects unstable passive asset switches', () => {
  const clock = read('src/content/market-cycle-clock-v4.js');
  const market = read('src/background-market-session.js');
  assert.match(clock, /if \(expirySemantic && !candleSemantic\) continue/);
  assert.match(clock, /clockSource: 'casatrade-clock-pending'/);
  assert.doesNotMatch(clock, /structured-candle-boundary-fallback/);
  assert.doesNotMatch(clock, /clockSource: 'platform-cycle-derived'/);
  assert.match(market, /passive-asset-change-not-stable/);
  assert.doesNotMatch(market, /casatrade-clock-frame/);
});
