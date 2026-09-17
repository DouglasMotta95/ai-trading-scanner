import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');

test('expiration reader accepts CasaTrade decorated 1 minute label and opaque-frame origin', () => {
  const probe = read('src/content/casatrade-expiration-probe.js');
  const controls = read('src/background-platform-controls.js');
  assert.match(probe, /\[\^0-9\]\{0,36\}/);
  assert.match(probe, /document\.body\?\.innerText/);
  assert.match(controls, /sender\.origin/);
  assert.match(controls, /required:\s*'60s'/);
});

test('asset session preserves real platform controls while changing the visible market', () => {
  const market = read('src/background-market-session.js');
  assert.match(market, /platformControls:\s*state\.platformControls \|\| null/);
});

test('focused asset cannot roll back from a fresh visible chart because an inactive frame keeps publishing', () => {
  const market = read('src/background-market-session.js');
  assert.match(market, /cross-frame-stale-asset/);
  assert.match(market, /assetChanged && frameChanged && oldFresh && !userSelected/);
  assert.match(market, /oldEmbeddedTrader && incomingCasaFrame && !userSelected/);
  assert.match(market, /const traderHandoff/);
});
