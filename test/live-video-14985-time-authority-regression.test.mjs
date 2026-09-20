import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');

test('explicit CasaTrade expiration card is promoted above reliability threshold', () => {
  const source = read('src/content/casatrade-ui-observer-v2.js');
  assert.match(source, /explicit-expiration-card/);
  assert.match(source, /score: strong \? 96 : 68/);
  assert.match(source, /expira\(\?:cao\|ção\)\?\|expiry\|expiration/);
});

test('plain MM:SS candle timer is not rejected because a broad parent contains expiration text', () => {
  const source = read('src/content/market-cycle-clock-v4.js');
  assert.match(source, /const colonOnly = \^\\d\{1,3\}/);
  assert.match(source, /const expirySemantic = \/expira\|expiry\|expiration\/\.test\(localContext\)/);
  assert.match(source, /!colonOnly && \/expira\|expiry\|expiration\/\.test\(parentContext\)/);
});

test('primary UI hides possible signal and setup until authoritative M1 timing is ready', () => {
  const source = read('src/sidepanel/app-v2.js');
  assert.match(source, /function liveTimingReady/);
  assert.match(source, /if \(!timingReady\)/);
  assert.match(source, /score: 0/);
  assert.match(source, /const setupLabel = liveTimingReady\(state\)/);
});

test('technical score requires confirmed market plus exact M1 clock and 60s expiration', () => {
  const source = read('src/sidepanel/signal-guidance-ui.js');
  assert.match(source, /function analysisReady/);
  assert.match(source, /return marketReady\(state\) && timingReady\(state\)/);
  assert.match(source, /AGUARDANDO TEMPO CASATRADE/);
  assert.match(source, /expiration === '60s'/);
  assert.match(source, /\['trader-dom-countdown','network-server-cycle'\]/);
});
