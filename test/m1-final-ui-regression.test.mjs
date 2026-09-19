import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');

test('sidepanel has dark first paint and separates real TF, candle countdown and expiration plan',()=>{
  const h=read('src/sidepanel/index.html');
  assert.match(h,/color-scheme:dark/);
  assert.match(h,/TF REAL/);
  assert.match(h,/id="heroCountdown"/);
  assert.match(h,/id="heroExpirationPlan"/);
});
