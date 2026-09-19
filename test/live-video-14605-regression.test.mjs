import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');

test('current compact UI exposes one explicit M1/M5 operating selector without contradictory profiles',()=>{
  const h=read('src/sidepanel/index.html');
  assert.equal((h.match(/id="operatingTimeframe"/g)||[]).length,1);
  assert.match(h,/M1 • expiração 1 min/);
  assert.match(h,/M5 • expiração 5 min/);
  assert.doesNotMatch(h,/Conservador|Agressivo/);
});
