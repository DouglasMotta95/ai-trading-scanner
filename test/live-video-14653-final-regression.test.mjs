import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');

test('cached asset cannot survive a real market-session switch',()=>{
  const session=read('src/background-market-session.js');
  assert.match(session,/asset: null/);
  assert.match(session,/marketHistory: \{\}/);
  assert.match(session,/signal: null/);
  assert.match(session,/lastConfirmed: null/);
});

test('expiration observation remains separate from candle-close clock',()=>{
  const control=read('src/background-control.js');
  const clock=read('src/content/market-cycle-clock-v4.js');
  assert.match(control,/directExpirationProbe/);
  assert.match(clock,/candle-close/);
});
