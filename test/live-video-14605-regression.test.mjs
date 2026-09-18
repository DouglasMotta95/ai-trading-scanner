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

test('M1 UI no longer offers contradictory 30s 2m or 5m expiration preferences', () => {
  const html = read('src/sidepanel/index.html');
  const guard = read('src/sidepanel/expiration-guard-ui.js');
  assert.match(html, /Expiração da estratégia M1/);
  assert.match(html, /option value="60s">1 min/);
  assert.doesNotMatch(html, /option value="300s"/);
  assert.doesNotMatch(html, /option value="120s"/);
  assert.doesNotMatch(html, /option value="30s"/);
  assert.match(guard, /requested === '60s' \? '60s' : null/);
});

test('existing CasaTrade clock and market-session core stay byte-for-byte on the previous live-fix baseline', () => {
  const clock = read('src/content/market-cycle-clock-v4.js');
  const market = read('src/background-market-session.js');
  assert.doesNotMatch(clock, /function orderExpirationFromDom/);
  assert.doesNotMatch(market, /casatrade-clock-frame/);
});
