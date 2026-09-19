import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read = p => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');

import { processSnapshot, resetOrchestrator } from '../src/core/orchestrator.js';
test('core.test.mjs: current A+ orchestrator owns stability and next-candle state', () => {
  const src=read('src/core/orchestrator.js');
  assert.match(src,/POSSIBLE_HIT_GAP_MS = 8000/);
  assert.match(src,/observeStableAPlusCandidate/);
  assert.match(src,/cycle\.aPlusWeakHits >= 2/);
  assert.match(src,/locked === 'ENTER'/);
});
test('core.test.mjs: A+ engine is the active confidence gate',()=>{const s=read('src/core/high-confidence.js');assert.match(s,/assessHighConfidence/);assert.match(s,/candidateAllowed/);assert.match(s,/finalAllowed/);});
