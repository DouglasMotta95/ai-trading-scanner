import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { analyzeCandles, ANALYST_THRESHOLDS } from '../src/core/analysis.js';
import { processSnapshot, resetOrchestrator } from '../src/core/orchestrator.js';

const minute = 60_000;
const aPlusBullishRows = bucket => Array.from({ length: 40 }, (_, index) => {
  const offset = 39 - index;
  const open = 1 + index * .002;
  const close = open + .0016;
  return { time: bucket - offset * minute, open, high: close + .00045, low: open - .00035, close, timeframe: 'M1' };
});
const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');

function bullish(bucket) { return aPlusBullishRows(bucket); }

function run(bucket, offset, price = 1.110, candles = bullish(bucket)) {
  return processSnapshot({
    platformId: 'casatrade',
    asset: 'EUR/USD',
    price,
    timeframe: 'M1',
    analysisTimeframe: 'M1',
    connection: 'online',
    serverTime: bucket + offset,
    candles
  }, { connection: 'online' });
}

test('analyst exposes buying power, selling power, rejection, strength, momentum and loss of strength', () => {
  const result = analyzeCandles(bullish(1_800_000_000_000));
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
  const first = run(bucket, 35_000);
  assert.notEqual(first.signal.state, 'WATCH');
  assert.notEqual(first.signal.uiState, 'POSSIBLE_BUY');

  const second = run(bucket, 36_000);
  assert.equal(second.signal.state, 'WATCH');
  assert.equal(second.signal.uiState, 'POSSIBLE_BUY');
});

test('confirmed next-candle entry is latched until candle rollover', () => {
  resetOrchestrator();
  const bucket = Math.floor(1_800_020_000_000 / minute) * minute;
  run(bucket, 35_000);
  const possible = run(bucket, 36_000);
  assert.equal(possible.signal.uiState, 'POSSIBLE_BUY');
  run(bucket, 51_000);
  const confirmed = run(bucket, 52_000);
  assert.equal(confirmed.signal.state, 'CONFIRM');
  assert.equal(confirmed.signal.uiState, 'ENTER_BUY');

  const weak = bullish(bucket);
  weak[weak.length - 1] = { time: bucket, open: 1.078, high: 1.085, low: 1.070, close: 1.079, timeframe: 'M1' };
  const afterWeakTick = run(bucket, 55_000, 1.079, weak);
  assert.equal(afterWeakTick.signal.state, 'CONFIRM');
  assert.equal(afterWeakTick.signal.direction, 'BUY');
  assert.equal(afterWeakTick.signal.uiState, 'ENTER_BUY');
});

test('panel derives all principal surfaces from one state and contains no legacy conflicting message', () => {
  const panel = read('src/sidepanel/app.js');
  assert.match(panel, /function principalState\(s = \{\}\)/);
  assert.match(panel, /analysisTitle'\)\.textContent = principal\.text/);
  assert.match(panel, /signalTitle'\)\.textContent = principal\.text/);
  assert.match(panel, /decisionText'\)\.textContent = principal\.text/);
  assert.match(panel, /analyzingNow'\)\.textContent = principal\.text/);
  assert.match(panel, /tradeActionStatus'\)\.textContent = principal\.text/);
  assert.doesNotMatch(panel, /DIAGNÓSTICO: AGUARDAR|AGUARDE CONFIRMAÇÃO|Pré-sinal aponta/);
});
