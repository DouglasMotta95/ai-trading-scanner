import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { analyzeCandles, ANALYST_THRESHOLDS } from '../src/core/analysis.js';
import { processSnapshot, resetOrchestrator } from '../src/core/orchestrator.js';
import { bullishAPlusRows, weakCurrentFrom, snapshotFor, minute } from './helpers/current-a-plus-fixtures.mjs';

const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');

function run(bucket, offset, rows = bullishAPlusRows(bucket)) {
  return processSnapshot(snapshotFor(bucket, offset, { rows }), { connection: 'online' });
}

test('analyst exposes buying power, selling power, rejection, strength, momentum and loss of strength', () => {
  const result = analyzeCandles(bullishAPlusRows(1_800_000_000_000));
  assert.equal(ANALYST_THRESHOLDS.minimumClosedCandles, 2);
  assert.equal(ANALYST_THRESHOLDS.possibleScore, 44);
  assert.equal(ANALYST_THRESHOLDS.confirmScore, 58);
  assert.equal(ANALYST_THRESHOLDS.candleStrength, 62);
  assert.equal(ANALYST_THRESHOLDS.rejectionStrength, 50);
  for (const key of ['buyPower','sellPower','currentStrength','rejectionStrength','momentumScore','lossOfStrength']) {
    assert.ok(Number.isFinite(Number(result.analytics[key])), `${key} must be numeric`);
  }
  assert.ok(Object.hasOwn(result.analytics, 'momentumDirection'));
  assert.ok(Object.hasOwn(result.analytics, 'continuationScore'));
});

test('one strong tick never becomes possible signal by itself', () => {
  resetOrchestrator();
  const bucket = Math.floor(1_800_010_000_000 / minute) * minute;
  const rows = bullishAPlusRows(bucket);
  const first = run(bucket, 35_000, rows);
  assert.notEqual(first.signal.state, 'WATCH');
  assert.notEqual(first.signal.uiState, 'POSSIBLE_BUY');

  const second = run(bucket, 36_000, rows);
  assert.equal(second.signal.state, 'WATCH');
  assert.equal(second.signal.uiState, 'POSSIBLE_BUY');
  assert.equal(second.signal.aPlus?.candidateAllowed, true);
});

test('confirmed next-candle entry is latched until candle rollover', () => {
  resetOrchestrator();
  const bucket = Math.floor(1_800_020_000_000 / minute) * minute;
  const rows = bullishAPlusRows(bucket);
  run(bucket, 35_000, rows);
  const possible = run(bucket, 36_000, rows);
  assert.equal(possible.signal.uiState, 'POSSIBLE_BUY');
  run(bucket, 51_000, rows);
  const confirmed = run(bucket, 52_000, rows);
  assert.equal(confirmed.signal.state, 'CONFIRM');
  assert.equal(confirmed.signal.uiState, 'ENTER_BUY');

  const afterWeakTick = run(bucket, 55_000, weakCurrentFrom(rows, bucket));
  assert.equal(afterWeakTick.signal.state, 'CONFIRM');
  assert.equal(afterWeakTick.signal.direction, 'BUY');
  assert.equal(afterWeakTick.signal.uiState, 'ENTER_BUY');
});

test('all principal sidepanel surfaces consume the same central state.signal', () => {
  const app = read('src/sidepanel/app-v2.js');
  const guidance = read('src/sidepanel/signal-guidance-ui.js');
  assert.match(app, /The orchestrator signal is the only decision authority rendered by the UI/);
  assert.match(app, /const signal = state\.signal \|\| \{\}/);
  assert.doesNotMatch(app, /score >= 44/);
  assert.match(guidance, /const signal = state\.signal \|\| \{\}/);
  assert.doesNotMatch(guidance, /state\.professionalDecision/);
});
