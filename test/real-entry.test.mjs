import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { processSnapshot, resetOrchestrator, serializeCompletedDecisions, restoreCompletedDecisions } from '../src/core/orchestrator.js';
import { minute, bullishHistory, m1Snapshot, lockedCycle } from './helpers/current-fixtures.mjs';

const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');

test('locked final signal stays CONFIRM until target candle opens',()=>{
  resetOrchestrator();
  const bucket=Math.floor(1_810_000_000_000/minute)*minute;
  const out=processSnapshot(m1Snapshot(bucket,55_000),{connection:'online',decisionCycle:lockedCycle(bucket)});
  assert.equal(out.signal.state,'CONFIRM');
  assert.equal(out.signal.uiState,'ENTER_BUY');
  assert.equal(out.signal.targetStart,bucket+minute);
});

test('rollover records the real target-candle opening price',()=>{
  resetOrchestrator();
  const bucket=Math.floor(1_810_100_000_000/minute)*minute;
  processSnapshot(m1Snapshot(bucket,55_000),{connection:'online',decisionCycle:lockedCycle(bucket)});
  const rows=bullishHistory(bucket).concat([{time:bucket+minute,open:1.2345,high:1.236,low:1.233,close:1.235,timeframe:'M1'}]);
  const next=processSnapshot(m1Snapshot(bucket+minute,5_000,rows),{connection:'online'});
  assert.equal(next.lastConfirmed?.state,'CONFIRM');
  assert.equal(next.lastConfirmed?.entryPrice,1.2345);
  assert.equal(next.lastConfirmed?.entryConfirmed,true);
});

test('missed target candle never substitutes a later candle open',()=>{
  resetOrchestrator();
  const bucket=Math.floor(1_810_200_000_000/minute)*minute;
  processSnapshot(m1Snapshot(bucket,55_000),{connection:'online',decisionCycle:lockedCycle(bucket)});
  const laterBucket=bucket+2*minute;
  const rows=bullishHistory(bucket).concat([{time:laterBucket,open:9.99,high:10,low:9.9,close:9.95,timeframe:'M1'}]);
  const out=processSnapshot(m1Snapshot(laterBucket,5_000,rows),{connection:'online'});
  assert.equal(out.lastConfirmed?.entryConfirmed,false);
  assert.equal(out.lastConfirmed?.entryPrice,null);
});

test('completed decisions serialize and restore without inventing execution',()=>{
  resetOrchestrator();
  const bucket=Math.floor(1_810_300_000_000/minute)*minute;
  processSnapshot(m1Snapshot(bucket,55_000),{connection:'online',decisionCycle:lockedCycle(bucket)});
  const rows=bullishHistory(bucket).concat([{time:bucket+minute,open:1.3,high:1.31,low:1.29,close:1.305,timeframe:'M1'}]);
  processSnapshot(m1Snapshot(bucket+minute,5_000,rows),{connection:'online'});
  const saved=serializeCompletedDecisions();
  assert.ok(saved.some(row=>row.decision?.entryPrice===1.3));
  resetOrchestrator();
  restoreCompletedDecisions(saved);
  const out=processSnapshot(m1Snapshot(bucket+minute,8_000,rows),{connection:'online'});
  assert.equal(out.lastConfirmed?.entryPrice,1.3);
  assert.doesNotMatch(read('src/background-control.js'),/ATS_EXECUTE_TRADE/);
});
