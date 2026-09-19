import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');

test('background central analyzer accepts only consolidated CasaTrade market state',()=>{
  const b=read('src/background.js');
  assert.match(b,/consolidatedSnapshot/);
  assert.match(b,/sameMarket\(focus\.asset, asset\)/);
  assert.match(b,/ALLOWED_CLOCK_SOURCES/);
});

test('manual trade flow never auto-executes a CasaTrade order',()=>{
  const c=read('src/background-control.js');
  assert.match(c,/ATS_PREPARE_TRADE/);
  assert.doesNotMatch(c,/ATS_EXECUTE_TRADE/);
});
