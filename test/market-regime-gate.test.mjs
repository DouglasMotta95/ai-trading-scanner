import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');

test('range regime only allows rejection or confirmed breakout quality',()=>{
  const s=read('src/core/orchestrator.js');
  const start=s.indexOf("const setups = regime === 'range'");
  const end=s.indexOf("    : [",start);
  const rangeBlock=s.slice(start,end);
  assert.match(rangeBlock,/rejeição no range/);
  assert.match(rangeBlock,/rompimento confirmado no range/);
  assert.match(rangeBlock,/strongBreakout/);
  assert.match(rangeBlock,/breakoutMargin >= \.18/);
  assert.doesNotMatch(rangeBlock,/continuação com tendência|momentum com tendência/);
});
