import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');

test('expiration reader accepts decorated minute labels and trusted frame sender metadata', () => {
  const probe = read('src/content/casatrade-expiration-probe.js');
  const controls = read('src/background-platform-controls.js');
  assert.match(probe, /minuto|minute|min/);
  assert.match(probe, /document\.body\?\.innerText/);
  assert.match(controls, /sender\.origin|sender\.url|sender\.tab/);
});

test('asset session preserves real platform controls while changing the visible market', () => {
  const market = read('src/background-market-session.js');
  assert.match(market, /platformControls:\s*state\.platformControls \|\| null/);
  assert.match(market, /Only a REAL asset change may reset market\/session analysis state/);
});

test('focused asset cannot roll back from a fresh visible chart because an inactive frame keeps publishing', () => {
  const market = read('src/background-market-session.js');
  assert.match(market, /cross-frame-stale-asset/);
  assert.match(market, /const chartHeaderAuthoritative/);
  assert.match(market, /const authoritativeVisual = userSelected \|\| chartHeaderAuthoritative/);
  assert.match(market, /assetChanged && frameChanged && oldFresh && !authoritativeVisual/);
  assert.match(market, /const traderHandoff/);
  assert.match(market, /same-market-trader-handoff/);
});
