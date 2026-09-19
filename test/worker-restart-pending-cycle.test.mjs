import test from 'node:test';
import assert from 'node:assert/strict';
import { processSnapshot, resetOrchestrator } from '../src/core/orchestrator.js';

const minute = 60_000;
const aPlusBullishRows = bucket => Array.from({ length: 40 }, (_, index) => {
  const offset = 39 - index;
  const open = 1 + index * .002;
  const close = open + .0016;
  return { time: bucket - offset * minute, open, high: close + .00045, low: open - .00035, close, timeframe: 'M1' };
});

function bullishRows(bucket) { return aPlusBullishRows(bucket); }

function snapshot(bucket, elapsed, secondsRemaining, candles = bullishRows(bucket), price = candles.at(-1).close) {
  return {
    platformId: 'casatrade', asset: 'EUR/USD (OTC)', price,
    timeframe: 'M1', analysisTimeframe: 'M1', connection: 'online',
    serverTime: bucket + elapsed, secondsRemaining, candles
  };
}

test('locked next-candle entry survives a service-worker restart before target candle opens', () => {
  resetOrchestrator();
  const bucket = Math.floor(1_806_000_000_000 / minute) * minute;
  const state = { connection: 'online' };

  processSnapshot(snapshot(bucket, 50_000, 10), state);
  const locked = processSnapshot(snapshot(bucket, 51_000, 9), state);
  assert.equal(locked.signal.state, 'CONFIRM');
  assert.equal(locked.decisionCycle.locked, 'ENTER');
  assert.equal(locked.decisionCycle.direction, 'BUY');

  const persistedCycle = structuredClone(locked.decisionCycle);
  resetOrchestrator(); // simulates MV3 service-worker memory being discarded

  const target = bucket + minute;
  const realOpen = 1.1095;
  const current = { time: target, open: realOpen, high: 1.114, low: 1.108, close: 1.112, timeframe: 'M1' };
  const rows = [...bullishRows(bucket), current];
  const resumed = processSnapshot(snapshot(target, 5_000, 55, rows, current.close), {
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
  const state = { connection: 'online' };
  processSnapshot(snapshot(bucket, 50_000, 10), state);
  const locked = processSnapshot(snapshot(bucket, 51_000, 9), state);
  const persistedCycle = structuredClone(locked.decisionCycle);
  resetOrchestrator();

  const lateBucket = bucket + 2 * minute;
  const lateCandle = { time: lateBucket, open: 9.90, high: 10.0, low: 9.80, close: 9.99, timeframe: 'M1' };
  const rows = [...bullishRows(bucket), lateCandle];
  const resumed = processSnapshot(snapshot(lateBucket, 5_000, 55, rows, 9.99), {
    connection: 'online',
    decisionCycle: persistedCycle
  });

  assert.equal(resumed.lastConfirmed?.state, 'CONFIRM');
  assert.equal(resumed.lastConfirmed?.entryConfirmed, false);
  assert.equal(resumed.lastConfirmed?.entryPrice, null);
  assert.equal(resumed.lastConfirmed?.entryTime, null);
  assert.equal(resumed.lastConfirmed?.capturedAt, null);
});
