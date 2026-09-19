import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');

test('current policy uses the single A+ signal authority instead of legacy NORMAL scoring',()=>{
  const p=read('src/background-decision-policy.js');
  assert.match(p,/mode: 'A_PLUS'/);
  assert.match(p,/Single authority rule/);
  assert.doesNotMatch(p,/mode: 'NORMAL'/);
});

test('A+ candidate and final gates are explicit in the orchestrator',()=>{
  const o=read('src/core/orchestrator.js');
  assert.match(o,/stableAPlusCandidateAllowed/);
  assert.match(o,/aPlus\.finalAllowed/);
});
