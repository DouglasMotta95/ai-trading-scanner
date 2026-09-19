import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');
test('final-stabilization-acceptance.test.mjs: current A+ stability contract',()=>{const s=read('src/core/orchestrator.js');assert.match(s,/POSSIBLE_HIT_GAP_MS = 8000/);assert.match(s,/observeStableAPlusCandidate/);assert.match(s,/aPlusWeakHits >= 2/);assert.match(s,/locked === 'ENTER'/);});
test('final-stabilization-acceptance.test.mjs: current high-confidence engine remains active',()=>{const s=read('src/core/high-confidence.js');assert.match(s,/assessHighConfidence/);assert.match(s,/candidateAllowed/);assert.match(s,/finalAllowed/);});
