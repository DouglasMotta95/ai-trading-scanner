import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');

test('mobile-throttled observations have an 8 second candidate continuity window',()=>{
  const s=read('src/core/orchestrator.js');
  assert.match(s,/POSSIBLE_HIT_GAP_MS = 8000/);
  assert.match(s,/at - Number\(cycle\.lastCandidateAt\) <= POSSIBLE_HIT_GAP_MS/);
});

test('temporary weak A+ evidence needs two observations before hiding POSSIBLE',()=>{
  const s=read('src/core/orchestrator.js');
  assert.match(s,/observeStableAPlusCandidate/);
  assert.match(s,/cycle\.aPlusWeakHits >= 2/);
});
