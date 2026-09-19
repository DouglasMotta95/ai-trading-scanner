import test from 'node:test';
import assert from 'node:assert/strict';
import { processSnapshot, resetOrchestrator } from '../src/core/orchestrator.js';
import { bullishAPlusRows, snapshotFor, minute } from './helpers/current-a-plus-fixtures.mjs';

function lockEntry(bucket) {
  const rows = bullishAPlusRows(bucket);
  const state = { connection: 'online' };
  processSnapshot(snapshotFor(bucket, 35_000, { rows, secondsRemaining: 25 }), state);
  processSnapshot(snapshotFor(bucket, 36_000, { rows, secondsRemaining: 24 }), state);
  processSnapshot(snapshotFor(bucket, 51_000, { rows, secondsRemaining: 9 }), state);
  const locked = processSnapshot(snapshotFor(bucket, 52_000, { rows, secondsRemaining: 8 }), state);
  assert.equal(locked.signal.state, 'CONFIRM');
  assert.equal(locked.decisionCycle.locked, 'ENTER');
  return { locked, rows };
}

test('locked next-candle entry survives a service-worker restart before target candle opens', () => {
  resetOrchestrator();
  const bucket = Math.floor(1_806_000_000_000 / minute) * minute;
  const { locked, rows } = lockEntry(bucket);
  const persistedCycle = structuredClone(locked.decisionCycle);

  resetOrchestrator();

  const target = bucket + minute;
  const realOpen = rows.at(-1).close - .00005;
  const current = { time: target, open: realOpen, high: realOpen + .0003, low: realOpen - .0002, close: realOpen + .0001, timeframe: 'M1' };
  const resumed = processSnapshot(snapshotFor(target, 5_000, {
    rows: [...rows, current],
    price: current.close,
    secondsRemaining: 55
  }), {
    connection: 'online',
    decisionCycle: persistedCycle
  });

  assert.equal(resumed.lastConfirmed?.state, 'CONFIRM');
  assert.equal(resumed.lastConfirmed?.direction, 'BUY');
  assert.equal(resumed.lastConfirmed?.entryConfirmed, true);
  assert.equal(resumed.lastConfirmed?.entryPrice, realOpen);
  assert.equal(resumed.lastConfirmed?.entryTime, target);
  assert.notEqual(resumed.lastConfirmed?.entryPrice, current.close);
});

test('recovered pending entry never substitutes a later candle or live quote for the missed target open', () => {
  resetOrchestrator();
  const bucket = Math.floor(1_806_100_000_000 / minute) * minute;
  const { locked, rows } = lockEntry(bucket);
  const persistedCycle = structuredClone(locked.decisionCycle);
  resetOrchestrator();

  const lateBucket = bucket + 2 * minute;
  const lateCandle = { time: lateBucket, open: 9.90, high: 10.0, low: 9.80, close: 9.99, timeframe: 'M1' };
  const resumed = processSnapshot(snapshotFor(lateBucket, 5_000, {
    rows: [...rows, lateCandle],
    price: 9.99,
    secondsRemaining: 55
  }), {
    connection: 'online',
    decisionCycle: persistedCycle
  });

  assert.equal(resumed.lastConfirmed?.state, 'CONFIRM');
  assert.equal(resumed.lastConfirmed?.entryConfirmed, false);
  assert.equal(resumed.lastConfirmed?.entryPrice, null);
  assert.equal(resumed.lastConfirmed?.entryTime, null);
  assert.equal(resumed.lastConfirmed?.capturedAt, null);
});
