import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeCandles } from '../src/core/analysis.js';
import { processSnapshot, resetOrchestrator } from '../src/core/orchestrator.js';
import { detectPlatform } from '../src/platforms/registry.js';

const minute = 60_000;
const aPlusBullishRows = bucket => Array.from({ length: 40 }, (_, index) => {
  const offset = 39 - index;
  const open = 1 + index * .002;
  const close = open + .0016;
  return { time: bucket - offset * minute, open, high: close + .00045, low: open - .00035, close, timeframe: 'M1' };
});

function bullishRows(bucket) { return aPlusBullishRows(bucket); }

function snap(bucket, atMs, price = 1.11, candles = bullishRows(bucket), extra = {}) {
  return processSnapshot({
    platformId: 'casatrade', asset: 'EUR/USD (OTC)', price,
    timeframe: 'M1', analysisTimeframe: 'M1', connection: 'online',
    serverTime: bucket + atMs, candles, ...extra
  }, { connection: 'online' });
}

function publishPossible(bucket) {
  const first = snap(bucket, 35_000);
  assert.notEqual(first.signal.state, 'WATCH');
  const second = snap(bucket, 36_000);
  assert.equal(second.signal.state, 'WATCH');
  assert.equal(second.signal.phase, 'POSSIBLE');
  assert.equal(second.signal.direction, 'BUY');
  assert.equal(second.signal.uiState, 'POSSIBLE_BUY');
  return second;
}

function confirmStable(bucket) {
  publishPossible(bucket);
  const firstFinal = snap(bucket, 51_000);
  assert.notEqual(firstFinal.signal.state, 'CONFIRM');
  const confirmed = snap(bucket, 52_000);
  assert.equal(confirmed.signal.state, 'CONFIRM');
  assert.equal(confirmed.signal.direction, 'BUY');
  assert.equal(confirmed.signal.uiState, 'ENTER_BUY');
  return confirmed;
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
  const out = snap(bucket, 15_000, 1.058, candles);
  assert.notEqual(out.signal.state, 'SEARCHING');
  assert.notEqual(out.signal.phase, 'HISTORY');
  assert.equal(out.signal.warmup.required, 2);
  assert.equal(out.signal.candleCount, 2);
});

test('possible signal requires consecutive stable observations in the last 30 seconds', () => {
  resetOrchestrator();
  const bucket = Math.floor(1_700_000_000_000 / minute) * minute;
  const first = snap(bucket, 35_000);
  assert.notEqual(first.signal.state, 'WATCH');
  assert.notEqual(first.signal.uiState, 'POSSIBLE_BUY');

  const second = snap(bucket, 36_000);
  assert.equal(second.signal.phase, 'POSSIBLE');
  assert.equal(second.signal.state, 'WATCH');
  assert.equal(second.signal.direction, 'BUY');
  assert.equal(second.signal.uiState, 'POSSIBLE_BUY');
  assert.equal(second.signal.secondsRemaining, 24);
});

test('final decision requires stable confirmation for the next candle', () => {
  resetOrchestrator();
  const bucket = Math.floor(1_700_100_000_000 / minute) * minute;
  publishPossible(bucket);

  const firstFinal = snap(bucket, 51_000);
  assert.notEqual(firstFinal.signal.state, 'CONFIRM');

  const out = snap(bucket, 52_000);
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
  const confirmed = confirmStable(bucket);
  assert.equal(confirmed.signal.state, 'CONFIRM');

  const closed = bullishRows(bucket).slice(0, -1);
  const weak = snap(bucket, 55_000, 1.079, [
    ...closed,
    { time: bucket, open: 1.078, high: 1.09, low: 1.07, close: 1.079, timeframe: 'M1' }
  ]);

  assert.equal(weak.signal.state, 'CONFIRM');
  assert.equal(weak.signal.direction, 'BUY');
  assert.equal(weak.signal.uiState, 'ENTER_BUY');
  assert.equal(weak.signal.provisional, false);
  assert.equal(weak.signal.targetStart, bucket + minute);
});

test('live analyst exposes pattern-building state before the pre-signal window', () => {
  resetOrchestrator();
  const bucket = Math.floor(1_700_175_000_000 / minute) * minute;
  const out = snap(bucket, 15_000);
  assert.equal(out.signal.phase, 'BUILDING');
  assert.equal(out.signal.uiState, 'BUILDING_PATTERN');
  assert.equal(out.signal.direction, null);
  assert.equal(out.signal.analysisDirection, 'BUY');
  assert.equal(out.signal.analysisScore, out.signal.score);
});

test('completed final decision is exposed as last confirmed after candle rollover', () => {
  resetOrchestrator();
  const bucket = Math.floor(1_700_190_000_000 / minute) * minute;
  const final = confirmStable(bucket);
  assert.equal(final.signal.state, 'CONFIRM');

  const history = bullishRows(bucket).slice(0, -1);
  const next = processSnapshot({
    platformId: 'casatrade', asset: 'EUR/USD (OTC)', price: 1.112,
    timeframe: 'M1', analysisTimeframe: 'M1', connection: 'online',
    serverTime: bucket + minute + 5_000,
    candles: [
      ...history,
      { time: bucket, open: 1.078, high: 1.115, low: 1.075, close: 1.11, timeframe: 'M1' },
      { time: bucket + minute, open: 1.11, high: 1.113, low: 1.109, close: 1.112, timeframe: 'M1' }
    ]
  }, { connection: 'online' });

  assert.equal(next.lastConfirmed.state, 'CONFIRM');
  assert.equal(next.lastConfirmed.direction, 'BUY');
  assert.equal(next.lastConfirmed.time, bucket + minute);
  assert.equal(next.lastConfirmed.asset, 'EUR/USD (OTC)');
  assert.equal(next.lastConfirmed.timeframe, 'M1');
});

test('CasaTrade countdown overrides wall-clock countdown when provided', () => {
  resetOrchestrator();
  const bucket = Math.floor(1_700_200_000_000 / minute) * minute;
  const out = snap(bucket, 20_000, 1.11, bullishRows(bucket), { secondsRemaining: 9 });
  assert.equal(out.signal.secondsRemaining, 9);
  assert.equal(out.signal.phase, 'FINAL');
});

test('platform detection rejects unrelated hosts', () => {
  assert.equal(detectPlatform('example.com'), null);
  assert.equal(detectPlatform('notcasatrade.io'), null);
  assert.equal(detectPlatform('casatrade.com')?.id, 'casatrade');
});
