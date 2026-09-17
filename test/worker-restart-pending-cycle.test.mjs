import test from 'node:test';
import assert from 'node:assert/strict';
import { processSnapshot, resetOrchestrator } from '../src/core/orchestrator.js';

const minute = 60_000;

function bullishRows(bucket) {
  return [
    { time: bucket - 4 * minute, open: 1.000, high: 1.020, low: .990, close: 1.018, timeframe: 'M1' },
    { time: bucket - 3 * minute, open: 1.018, high: 1.040, low: 1.010, close: 1.038, timeframe: 'M1' },
    { time: bucket - 2 * minute, open: 1.038, high: 1.060, low: 1.030, close: 1.058, timeframe: 'M1' },
    { time: bucket - minute, open: 1.058, high: 1.080, low: 1.050, close: 1.078, timeframe: 'M1' },
    { time: bucket, open: 1.078, high: 1.115, low: 1.075, close: 1.110, timeframe: 'M1' }
  ];
}

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

  processSnapshot(snapshot(bucket, 45_000, 15), state);
  const locked = processSnapshot(snapshot(bucket, 46_000, 14), state);
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
  processSnapshot(snapshot(bucket, 45_000, 15), state);
  const locked = processSnapshot(snapshot(bucket, 46_000, 14), state);
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
