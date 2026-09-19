import test from 'node:test';
import assert from 'node:assert/strict';
import { processSnapshot, resetOrchestrator } from '../src/core/orchestrator.js';
import { minute, m1Snapshot, lockedCycle } from './helpers/current-fixtures.mjs';

test('a locked decision remains latched for its target candle',()=>{
  resetOrchestrator();
  const bucket=Math.floor(1_812_000_000_000/minute)*minute;
  const first=processSnapshot(m1Snapshot(bucket,54_000),{connection:'online',decisionCycle:lockedCycle(bucket)});
  const second=processSnapshot(m1Snapshot(bucket,58_000),{connection:'online',decisionCycle:first.decisionCycle});
  assert.equal(first.signal.uiState,'ENTER_BUY');
  assert.equal(second.signal.uiState,'ENTER_BUY');
  assert.equal(second.decisionCycle.key,first.decisionCycle.key);
});

test('the next source candle receives a different decision-cycle key',()=>{
  resetOrchestrator();
  const bucket=Math.floor(1_812_100_000_000/minute)*minute;
  const a=processSnapshot(m1Snapshot(bucket,10_000),{connection:'online'});
  const b=processSnapshot(m1Snapshot(bucket+minute,10_000),{connection:'online'});
  assert.notEqual(a.decisionCycle.key,b.decisionCycle.key);
});
