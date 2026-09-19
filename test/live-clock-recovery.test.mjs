import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');

test('current clock pipeline preserves exact CasaTrade authorities and structured fallback observation',()=>{
  const c=read('src/content/market-cycle-clock-v4.js');
  assert.match(c,/trader-dom-countdown/);
  assert.match(c,/network-server-cycle/);
  assert.match(c,/structured-current-candle-boundary/);
  assert.match(c,/operational: true/);
});
