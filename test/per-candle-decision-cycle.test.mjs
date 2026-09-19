import test from 'node:test';
import assert from 'node:assert/strict';
import { processSnapshot, resetOrchestrator } from '../src/core/orchestrator.js';
import { bullishAPlusRows, weakCurrentFrom, snapshotFor, minute } from './helpers/current-a-plus-fixtures.mjs';

function snap(bucket, elapsed, secondsRemaining, rows = bullishAPlusRows(bucket)) {
  return processSnapshot(snapshotFor(bucket, elapsed, { rows, secondsRemaining }), { connection: 'online' });
}

test('POSSIBLE is preparation only and does not start more than 30 seconds before the next M1 candle', () => {
  resetOrchestrator();
  const bucket = Math.floor(1_701_000_000_000 / minute) * minute;
  const rows = bullishAPlusRows(bucket);
  snap(bucket, 19_000, 41, rows);
  const out = snap(bucket, 20_000, 40, rows);
  assert.notEqual(out.signal.uiState, 'POSSIBLE_BUY');
  assert.notEqual(out.signal.uiState, 'POSSIBLE_SELL');
});

test('stable A+ bullish bias becomes POSSIBLE after two observations and stays visible until final ENTER', () => {
  resetOrchestrator();
  const bucket = Math.floor(1_701_100_000_000 / minute) * minute;
  const rows = bullishAPlusRows(bucket);

  const first = snap(bucket, 35_000, 25, rows);
  assert.notEqual(first.signal.uiState, 'POSSIBLE_BUY');

  const possible = snap(bucket, 36_000, 24, rows);
  assert.equal(possible.signal.uiState, 'POSSIBLE_BUY');
  assert.equal(possible.signal.state, 'WATCH');
  assert.ok(Number(possible.signal.aPlus?.score || 0) >= 62);

  const finalCandidate = snap(bucket, 45_000, 15, rows);
  assert.equal(finalCandidate.signal.uiState, 'POSSIBLE_BUY');

  const atTen = snap(bucket, 50_000, 10, rows);
  assert.notEqual(atTen.signal.state, 'CONFIRM');

  const enter = snap(bucket, 51_000, 9, rows);
  assert.equal(enter.signal.uiState, 'POSSIBLE_BUY');
  const confirmed = snap(bucket, 52_000, 8, rows);
  assert.equal(confirmed.signal.state, 'CONFIRM');
  assert.equal(confirmed.signal.uiState, 'ENTER_BUY');
  assert.equal(confirmed.decisionCycle.locked, 'ENTER');
});

test('decision remains latched for the same target candle after entry is released', () => {
  resetOrchestrator();
  const bucket = Math.floor(1_701_200_000_000 / minute) * minute;
  const rows = bullishAPlusRows(bucket);
  snap(bucket, 35_000, 25, rows);
  snap(bucket, 36_000, 24, rows);
  snap(bucket, 51_000, 9, rows);
  const enter = snap(bucket, 52_000, 8, rows);
  assert.equal(enter.signal.state, 'CONFIRM');

  const later = snap(bucket, 55_000, 5, weakCurrentFrom(rows, bucket));
  assert.equal(later.signal.state, 'CONFIRM');
  assert.equal(later.signal.direction, 'BUY');
  assert.equal(later.signal.uiState, 'ENTER_BUY');
});

test('if no A+ setup confirms by four seconds the next candle ends in AGUARDAR', () => {
  resetOrchestrator();
  const bucket = Math.floor(1_701_300_000_000 / minute) * minute;
  const weak = weakCurrentFrom(bullishAPlusRows(bucket), bucket);
  const out = snap(bucket, 56_000, 4, weak);
  assert.equal(out.signal.uiState, 'WAIT');
  assert.equal(out.signal.provisional, false);
  assert.match(out.signal.reason, /^AGUARDAR/);
  assert.equal(out.decisionCycle.locked, 'WAIT');
});

test('each next candle gets a new decision cycle instead of inheriting POSSIBLE indefinitely', () => {
  resetOrchestrator();
  const bucket = Math.floor(1_701_400_000_000 / minute) * minute;
  const weak = weakCurrentFrom(bullishAPlusRows(bucket), bucket);
  const waited = snap(bucket, 56_000, 4, weak);
  const firstKey = waited.decisionCycle.key;

  const nextBucket = bucket + minute;
  const nextRows = bullishAPlusRows(nextBucket);
  const next = snap(nextBucket, 5_000, 55, nextRows);
  assert.notEqual(next.decisionCycle.key, firstKey);
  assert.notEqual(next.decisionCycle.locked, 'WAIT');
});
