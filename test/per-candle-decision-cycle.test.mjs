import test from 'node:test';
import assert from 'node:assert/strict';
import { processSnapshot, resetOrchestrator } from '../src/core/orchestrator.js';

const minute = 60_000;

function bullishRows(bucket) {
  return [
    { time: bucket - 4 * minute, open: 1.00, high: 1.02, low: .99, close: 1.018, timeframe: 'M1' },
    { time: bucket - 3 * minute, open: 1.018, high: 1.04, low: 1.01, close: 1.038, timeframe: 'M1' },
    { time: bucket - 2 * minute, open: 1.038, high: 1.06, low: 1.03, close: 1.058, timeframe: 'M1' },
    { time: bucket - minute, open: 1.058, high: 1.08, low: 1.05, close: 1.078, timeframe: 'M1' },
    { time: bucket, open: 1.078, high: 1.115, low: 1.075, close: 1.11, timeframe: 'M1' }
  ];
}

function lateralRows(bucket) {
  return [
    { time: bucket - 3 * minute, open: 1.000, high: 1.006, low: .996, close: 1.001, timeframe: 'M1' },
    { time: bucket - 2 * minute, open: 1.001, high: 1.005, low: .997, close: .999, timeframe: 'M1' },
    { time: bucket - minute, open: .999, high: 1.004, low: .996, close: 1.000, timeframe: 'M1' },
    { time: bucket, open: 1.000, high: 1.003, low: .998, close: 1.001, timeframe: 'M1' }
  ];
}

function snap(bucket, elapsed, secondsRemaining, rows = bullishRows(bucket), price = rows.at(-1).close) {
  return processSnapshot({
    platformId: 'casatrade', asset: 'EUR/USD (OTC)', price,
    timeframe: 'M1', analysisTimeframe: 'M1', connection: 'online',
    serverTime: bucket + elapsed, secondsRemaining, candles: rows
  }, { connection: 'online' });
}

test('POSSIBLE is preparation only and does not start more than 30 seconds before the next candle', () => {
  resetOrchestrator();
  const bucket = Math.floor(1_701_000_000_000 / minute) * minute;
  snap(bucket, 19_000, 41);
  const out = snap(bucket, 20_000, 40);
  assert.notEqual(out.signal.uiState, 'POSSIBLE_BUY');
  assert.notEqual(out.signal.uiState, 'POSSIBLE_SELL');
});

test('stable bullish bias becomes POSSIBLE after two observations and stays visible until final ENTER', () => {
  resetOrchestrator();
  const bucket = Math.floor(1_701_100_000_000 / minute) * minute;

  const first = snap(bucket, 35_000, 25);
  assert.notEqual(first.signal.uiState, 'POSSIBLE_BUY');
  assert.notEqual(first.signal.state, 'WATCH');

  const possible = snap(bucket, 36_000, 24);
  assert.equal(possible.signal.uiState, 'POSSIBLE_BUY');
  assert.equal(possible.signal.state, 'WATCH');
  assert.ok(possible.signal.analysisScore >= 44);

  const finalCandidate = snap(bucket, 45_000, 15);
  assert.notEqual(finalCandidate.signal.state, 'CONFIRM');
  assert.equal(finalCandidate.signal.phase, 'POSSIBLE');
  assert.equal(finalCandidate.signal.uiState, 'POSSIBLE_BUY');

  const atTen = snap(bucket, 50_000, 10);
  assert.notEqual(atTen.signal.state, 'CONFIRM');

  const firstFinal = snap(bucket, 55_000, 5);
  const enter = firstFinal.signal.state === 'CONFIRM'
    ? firstFinal
    : snap(bucket, 56_000, 4);
  assert.equal(enter.signal.state, 'CONFIRM');
  assert.equal(enter.signal.uiState, 'ENTER_BUY');
  assert.equal(enter.signal.direction, 'BUY');
  assert.ok([4, 5].includes(enter.signal.secondsRemaining));
  assert.equal(enter.decisionCycle.locked, 'ENTER');
});

test('decision remains latched for the same target candle after entry is released', () => {
  resetOrchestrator();
  const bucket = Math.floor(1_701_200_000_000 / minute) * minute;
  snap(bucket, 55_000, 5);
  const enter = snap(bucket, 56_000, 4);
  assert.equal(enter.signal.state, 'CONFIRM');

  const later = snap(bucket, 57_000, 3, lateralRows(bucket), 1.001);
  assert.equal(later.signal.state, 'CONFIRM');
  assert.equal(later.signal.direction, 'BUY');
  assert.equal(later.signal.uiState, 'ENTER_BUY');
});

test('if no setup confirms by one second the next candle ends in AGUARDAR', () => {
  resetOrchestrator();
  const bucket = Math.floor(1_701_300_000_000 / minute) * minute;
  const out = snap(bucket, 59_000, 1, lateralRows(bucket), 1.001);
  assert.equal(out.signal.state, 'NO_TRADE');
  assert.equal(out.signal.uiState, 'WAIT');
  assert.equal(out.signal.provisional, false);
  assert.match(out.signal.reason, /^AGUARDAR/);
  assert.equal(out.decisionCycle.locked, 'WAIT');
});

test('each next candle gets a new decision cycle instead of inheriting POSSIBLE indefinitely', () => {
  resetOrchestrator();
  const bucket = Math.floor(1_701_400_000_000 / minute) * minute;
  const waited = snap(bucket, 59_000, 1, lateralRows(bucket), 1.001);
  const firstKey = waited.decisionCycle.key;

  const nextBucket = bucket + minute;
  const nextRows = [
    ...bullishRows(bucket).slice(0, -1),
    { time: bucket, open: 1.078, high: 1.115, low: 1.075, close: 1.11, timeframe: 'M1' },
    { time: nextBucket, open: 1.11, high: 1.116, low: 1.108, close: 1.114, timeframe: 'M1' }
  ];
  const next = snap(nextBucket, 10_000, 50, nextRows, 1.114);
  assert.notEqual(next.decisionCycle.key, firstKey);
  assert.equal(next.decisionCycle.locked, null);
});
