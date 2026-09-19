import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');

test('range regime does not allow generic momentum continuation to bypass local setup quality',()=>{
  const s=read('src/core/orchestrator.js');
  const a=s.indexOf("const setups = regime === 'range'");
  const b=s.indexOf('const matched = setups.find',a);
  const block=s.slice(a,b);
  assert.match(block,/rejeição no range/);
  assert.match(block,/rompimento confirmado no range/);
  assert.doesNotMatch(block,/momentum com tendência/);
});
