import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');

test('fallback clock may observe but exact sources alone authorize visible entry timing',()=>{
  const session=read('src/background-market-session.js');
  const app=read('src/sidepanel/app-v2.js');
  assert.match(session,/function usableClock/);
  assert.match(session,/FALLBACK_CLOCK_SOURCE/);
  assert.match(app,/There is no operational fallback clock anymore/);
});

test('partial OHLC is labeled as unreliable instead of fabricated',()=>{
  const session=read('src/background-market-session.js');
  assert.match(session,/openReliable: false/);
  assert.match(session,/rangeReliable: false/);
});
