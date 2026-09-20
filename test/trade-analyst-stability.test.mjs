import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { processSnapshot, resetOrchestrator } from '../src/core/orchestrator.js';
import { minute, m1Snapshot, lockedCycle } from './helpers/current-fixtures.mjs';
const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');

test('one observation is not enough to publish a new POSSIBLE direction',()=>{
  const s=read('src/core/orchestrator.js');
  assert.match(s,/POSSIBLE_CONFIRM_HITS = 2/);
  assert.match(s,/cycle\.candidateHits >= POSSIBLE_CONFIRM_HITS/);
});

test('confirmed next-candle entry stays latched through weaker later ticks',()=>{
  resetOrchestrator();
  const bucket=Math.floor(1_813_000_000_000/minute)*minute;
  const first=processSnapshot(m1Snapshot(bucket,54_000),{connection:'online',decisionCycle:lockedCycle(bucket)});
  const weakRows=m1Snapshot(bucket,57_000).candles;
  weakRows[weakRows.length-1]={...weakRows.at(-1),close:weakRows.at(-1).open+0.00001};
  const second=processSnapshot(m1Snapshot(bucket,57_000,weakRows),{connection:'online',decisionCycle:first.decisionCycle});
  assert.equal(second.signal.state,'CONFIRM');
  assert.equal(second.signal.uiState,'ENTER_BUY');
});
