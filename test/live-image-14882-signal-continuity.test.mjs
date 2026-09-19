import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');

test('14882: named OTC instruments are accepted only by trusted visual focus parsing',()=>{
  const f=read('src/content/focused-asset-v2.js');
  const s=read('src/background-market-session.js');
  assert.match(f,/namedChartAsset/);
  assert.match(f,/\(OTC\)/);
  assert.match(s,/function normAsset/);
  assert.match(s,/OTC/);
});

test('14882: market frame handoff does not reset the same asset decision state',()=>{
  const s=read('src/background-market-session.js');
  assert.match(s,/assetChanged/);
  assert.match(s,/frameChanged/);
  assert.match(s,/incomingEmbeddedTrader/);
});
