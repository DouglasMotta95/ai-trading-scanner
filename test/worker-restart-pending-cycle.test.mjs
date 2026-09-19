import test from 'node:test';
import assert from 'node:assert/strict';
import { processSnapshot, resetOrchestrator } from '../src/core/orchestrator.js';
import { minute, bullishHistory, m1Snapshot, lockedCycle } from './helpers/current-fixtures.mjs';

test('locked next-candle decision survives an orchestrator memory reset through persisted decisionCycle',()=>{
  const bucket=Math.floor(1_811_000_000_000/minute)*minute;
  const persisted=lockedCycle(bucket);
  resetOrchestrator();
  const out=processSnapshot(m1Snapshot(bucket,56_000),{connection:'online',decisionCycle:persisted});
  assert.equal(out.signal.state,'CONFIRM');
  assert.equal(out.signal.uiState,'ENTER_BUY');
  assert.equal(out.decisionCycle.locked,'ENTER');
});

test('recovered pending decision only confirms entry price from the exact target candle',()=>{
  const bucket=Math.floor(1_811_100_000_000/minute)*minute;
  resetOrchestrator();
  processSnapshot(m1Snapshot(bucket,56_000),{connection:'online',decisionCycle:lockedCycle(bucket)});
  const later=bucket+2*minute;
  const rows=bullishHistory(bucket).concat([{time:later,open:7,high:8,low:6,close:7.5,timeframe:'M1'}]);
  const out=processSnapshot(m1Snapshot(later,4_000,rows),{connection:'online'});
  assert.equal(out.lastConfirmed?.entryConfirmed,false);
  assert.equal(out.lastConfirmed?.entryPrice,null);
});
