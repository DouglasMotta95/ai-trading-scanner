import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');

test('sidepanel exposes one dominant next-candle decision and real market surface',()=>{
  const h=read('src/sidepanel/index.html');
  assert.equal((h.match(/id="decisionCard"/g)||[]).length,1);
  assert.match(h,/id="asset"/);
  assert.match(h,/id="timeframe"/);
  assert.match(h,/id="heroCountdown"/);
});

test('advanced preferences match current A+ M1/M5 product',()=>{
  const h=read('src/sidepanel/index.html');
  assert.match(h,/Scanner A\+ M1 \/ M5/);
  assert.match(h,/id="operatingTimeframe"/);
});
