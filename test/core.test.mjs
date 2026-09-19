import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeCandles } from '../src/core/analysis.js';
import { processSnapshot, resetOrchestrator } from '../src/core/orchestrator.js';
import { detectPlatform } from '../src/platforms/registry.js';
import { bullishAPlusRows, weakCurrentFrom, snapshotFor, minute } from './helpers/current-a-plus-fixtures.mjs';

function snap(bucket, atMs, rows = bullishAPlusRows(bucket), extra = {}) {
  return processSnapshot(snapshotFor(bucket, atMs, { rows, extra }), { connection: 'online' });
}

function publishPossible(bucket) {
  const rows = bullishAPlusRows(bucket);
  const first = snap(bucket, 35_000, rows);
  assert.notEqual(first.signal.state, 'WATCH');
  const second = snap(bucket, 36_000, rows);
  assert.equal(second.signal.state, 'WATCH');
  assert.equal(second.signal.phase, 'POSSIBLE');
  assert.equal(second.signal.direction, 'BUY');
  assert.equal(second.signal.uiState, 'POSSIBLE_BUY');
  assert.equal(second.signal.aPlus?.hardVetoes?.length, 0);
  return { second, rows };
}

function confirmStable(bucket) {
  const { rows } = publishPossible(bucket);
  const firstFinal = snap(bucket, 51_000, rows);
  assert.notEqual(firstFinal.signal.state, 'CONFIRM');
  const confirmed = snap(bucket, 52_000, rows);
  assert.equal(confirmed.signal.state, 'CONFIRM');
  assert.equal(confirmed.signal.direction, 'BUY');
  assert.equal(confirmed.signal.uiState, 'ENTER_BUY');
  assert.ok(Number(confirmed.signal.aPlus?.score || 0) >= 78);
  return { confirmed, rows };
}

test('recent candle analysis works with real short history', () => {
  const candles = [
    { open: 1, high: 1.02, low: .99, close: 1.015 },
    { open: 1.015, high: 1.04, low: 1.01, close: 1.035 },
    { open: 1.035, high: 1.06, low: 1.03, close: 1.055 },
    { open: 1.055, high: 1.08, low: 1.05, close: 1.075 },
    { open: 1.075, high: 1.10, low: 1.07, close: 1.095 }
  ];
  const result = analyzeCandles(candles);
  assert.equal(result.recent.ready, true);
  assert.equal(result.recent.count, 5);
  assert.equal(result.direction, 'BUY');
});

test('analysis ignores candles with missing OHLC values', () => {
  const candles = [
    { open: null, high: null, low: null, close: null },
    { open: 1, high: 1.02, low: .99, close: 1.015 },
    { open: 1.015, high: 1.04, low: 1.01, close: 1.035 },
    { open: 1.035, high: 1.06, low: 1.03, close: 1.055 }
  ];
  const result = analyzeCandles(candles);
  assert.equal(result.recent.ready, true);
  assert.equal(result.recent.count, 3);
  assert.equal(result.direction, 'BUY');
});

test('analysis considers up to the last ten candles', () => {
  const candles = Array.from({ length: 10 }, (_, i) => ({
    open: 1 + i * .01,
    high: 1.018 + i * .01,
    low: .995 + i * .01,
    close: 1.015 + i * .01
  }));
  const result = analyzeCandles(candles);
  assert.equal(result.recent.ready, true);
  assert.equal(result.recent.count, 10);
  assert.equal(result.direction, 'BUY');
});

test('analyst starts once two closed candles plus current candle are available', () => {
  resetOrchestrator();
  const bucket = Math.floor(1_699_990_000_000 / minute) * minute;
  const candles = [
    { time: bucket - 2 * minute, open: 1.00, high: 1.02, low: .99, close: 1.018, timeframe: 'M1' },
    { time: bucket - minute, open: 1.018, high: 1.04, low: 1.01, close: 1.038, timeframe: 'M1' },
    { time: bucket, open: 1.038, high: 1.06, low: 1.035, close: 1.058, timeframe: 'M1' }
  ];
  const out = snap(bucket, 15_000, candles);
  assert.notEqual(out.signal.state, 'SEARCHING');
  assert.notEqual(out.signal.phase, 'HISTORY');
  assert.equal(out.signal.warmup.required, 2);
  assert.equal(out.signal.candleCount, 2);
});

test('possible signal requires consecutive stable observations in the preparation window', () => {
  resetOrchestrator();
  const bucket = Math.floor(1_700_000_000_000 / minute) * minute;
  const rows = bullishAPlusRows(bucket);
  const first = snap(bucket, 35_000, rows);
  assert.notEqual(first.signal.uiState, 'POSSIBLE_BUY');
  const second = snap(bucket, 36_000, rows);
  assert.equal(second.signal.phase, 'POSSIBLE');
  assert.equal(second.signal.state, 'WATCH');
  assert.equal(second.signal.direction, 'BUY');
  assert.equal(second.signal.uiState, 'POSSIBLE_BUY');
  assert.equal(second.signal.secondsRemaining, 24);
});

test('final decision requires stable A+ confirmation for the next candle', () => {
  resetOrchestrator();
  const bucket = Math.floor(1_700_100_000_000 / minute) * minute;
  const { rows } = publishPossible(bucket);
  const firstFinal = snap(bucket, 51_000, rows);
  assert.notEqual(firstFinal.signal.state, 'CONFIRM');
  const out = snap(bucket, 52_000, rows);
  assert.equal(out.signal.phase, 'FINAL');
  assert.equal(out.signal.state, 'CONFIRM');
  assert.equal(out.signal.direction, 'BUY');
  assert.equal(out.signal.uiState, 'ENTER_BUY');
  assert.equal(out.signal.provisional, false);
  assert.equal(out.signal.secondsRemaining, 8);
  assert.equal(out.signal.targetStart, bucket + minute);
});

test('confirmed decision is latched and cannot flicker back to wait inside the same candle', () => {
  resetOrchestrator();
  const bucket = Math.floor(1_700_150_000_000 / minute) * minute;
  const { confirmed, rows } = confirmStable(bucket);
  assert.equal(confirmed.signal.state, 'CONFIRM');
  const weakRows = weakCurrentFrom(rows, bucket);
  const weak = snap(bucket, 55_000, weakRows);
  assert.equal(weak.signal.state, 'CONFIRM');
  assert.equal(weak.signal.direction, 'BUY');
  assert.equal(weak.signal.uiState, 'ENTER_BUY');
  assert.equal(weak.signal.provisional, false);
  assert.equal(weak.signal.targetStart, bucket + minute);
});

test('live analyst exposes pattern-building state before the pre-signal window', () => {
  resetOrchestrator();
  const bucket = Math.floor(1_700_175_000_000 / minute) * minute;
  const out = snap(bucket, 15_000, bullishAPlusRows(bucket));
  assert.equal(out.signal.phase, 'BUILDING');
  assert.equal(out.signal.uiState, 'BUILDING_PATTERN');
  assert.equal(out.signal.direction, null);
  assert.equal(out.signal.analysisDirection, 'BUY');
  assert.ok(Number.isFinite(Number(out.signal.analysisScore)));
});

test('completed final decision is exposed as last confirmed after candle rollover', () => {
  resetOrchestrator();
  const bucket = Math.floor(1_700_190_000_000 / minute) * minute;
  const { confirmed, rows } = confirmStable(bucket);
  assert.equal(confirmed.signal.state, 'CONFIRM');
  const current = rows.at(-1);
  const target = bucket + minute;
  const next = processSnapshot(snapshotFor(target, 5_000, {
    rows: [
      ...rows,
      { time: target, open: current.close, high: current.close + .0003, low: current.close - .0001, close: current.close + .0002, timeframe: 'M1' }
    ]
  }), { connection: 'online' });
  assert.equal(next.lastConfirmed.state, 'CONFIRM');
  assert.equal(next.lastConfirmed.direction, 'BUY');
  assert.equal(next.lastConfirmed.time, target);
  assert.equal(next.lastConfirmed.asset, 'EUR/USD (OTC)');
  assert.equal(next.lastConfirmed.timeframe, 'M1');
});

test('CasaTrade countdown overrides wall-clock countdown when provided', () => {
  resetOrchestrator();
  const bucket = Math.floor(1_700_200_000_000 / minute) * minute;
  const rows = bullishAPlusRows(bucket);
  const out = snap(bucket, 20_000, rows, { secondsRemaining: 9 });
  assert.equal(out.signal.secondsRemaining, 9);
  assert.equal(out.signal.phase, 'FINAL');
});

test('platform detection rejects unrelated hosts', () => {
  assert.equal(detectPlatform('example.com'), null);
  assert.equal(detectPlatform('notcasatrade.io'), null);
  assert.equal(detectPlatform('casatrade.com')?.id, 'casatrade');
});
