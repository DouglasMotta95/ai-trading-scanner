import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeCandles } from '../src/core/analysis.js';
import { processSnapshot, resetOrchestrator } from '../src/core/orchestrator.js';
import { detectPlatform } from '../src/platforms/registry.js';

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

test('current candle can create a possible signal in the last 30 seconds', () => {
  resetOrchestrator();
  const minute = 60_000;
  const bucket = Math.floor(1_700_000_000_000 / minute) * minute;
  const candles = [
    { time: bucket - 4 * minute, open: 1.00, high: 1.02, low: .99, close: 1.018 },
    { time: bucket - 3 * minute, open: 1.018, high: 1.04, low: 1.01, close: 1.038 },
    { time: bucket - 2 * minute, open: 1.038, high: 1.06, low: 1.03, close: 1.058 },
    { time: bucket - minute, open: 1.058, high: 1.08, low: 1.05, close: 1.078 },
    { time: bucket, open: 1.078, high: 1.10, low: 1.075, close: 1.098 }
  ];
  const out = processSnapshot({
    platformId: 'casatrade', asset: 'EUR/USD (OTC)', price: 1.098,
    timeframe: 'M1', analysisTimeframe: 'M1', connection: 'online',
    serverTime: bucket + 35_000, candles
  }, { connection: 'online' });
  assert.equal(out.signal.phase, 'POSSIBLE');
  assert.equal(out.signal.state, 'WATCH');
  assert.equal(out.signal.direction, 'BUY');
  assert.equal(out.signal.secondsRemaining, 25);
});

test('final decision confirms in the last 10 seconds for the next candle', () => {
  resetOrchestrator();
  const minute = 60_000;
  const bucket = Math.floor(1_700_100_000_000 / minute) * minute;
  const candles = [
    { time: bucket - 4 * minute, open: 1.00, high: 1.02, low: .99, close: 1.018 },
    { time: bucket - 3 * minute, open: 1.018, high: 1.04, low: 1.01, close: 1.038 },
    { time: bucket - 2 * minute, open: 1.038, high: 1.06, low: 1.03, close: 1.058 },
    { time: bucket - minute, open: 1.058, high: 1.08, low: 1.05, close: 1.078 },
    { time: bucket, open: 1.078, high: 1.11, low: 1.075, close: 1.105 }
  ];
  const out = processSnapshot({
    platformId: 'casatrade', asset: 'EUR/USD (OTC)', price: 1.105,
    timeframe: 'M1', analysisTimeframe: 'M1', connection: 'online',
    serverTime: bucket + 50_000, candles
  }, { connection: 'online' });
  assert.equal(out.signal.phase, 'FINAL');
  assert.equal(out.signal.state, 'CONFIRM');
  assert.equal(out.signal.direction, 'BUY');
  assert.equal(out.signal.provisional, false);
  assert.equal(out.signal.secondsRemaining, 10);
  assert.equal(out.signal.targetStart, bucket + minute);
});

test('final decision recalculates on every new tick inside the last 10 seconds', () => {
  resetOrchestrator();
  const minute = 60_000;
  const bucket = Math.floor(1_700_150_000_000 / minute) * minute;
  const closed = [
    { time: bucket - 4 * minute, open: 1.00, high: 1.02, low: .99, close: 1.018, timeframe: 'M1' },
    { time: bucket - 3 * minute, open: 1.018, high: 1.04, low: 1.01, close: 1.038, timeframe: 'M1' },
    { time: bucket - 2 * minute, open: 1.038, high: 1.06, low: 1.03, close: 1.058, timeframe: 'M1' },
    { time: bucket - minute, open: 1.058, high: 1.08, low: 1.05, close: 1.078, timeframe: 'M1' }
  ];

  const weak = processSnapshot({
    platformId: 'casatrade', asset: 'EUR/USD (OTC)', price: 1.079,
    timeframe: 'M1', analysisTimeframe: 'M1', connection: 'online',
    serverTime: bucket + 50_000,
    candles: [...closed, { time: bucket, open: 1.078, high: 1.09, low: 1.07, close: 1.079, timeframe: 'M1' }]
  }, { connection: 'online' });

  assert.equal(weak.signal.phase, 'FINAL');
  assert.equal(weak.signal.state, 'NO_TRADE');
  assert.equal(weak.signal.direction, null);
  assert.equal(weak.signal.score, 48);
  assert.equal(weak.signal.secondsRemaining, 10);

  const stronger = processSnapshot({
    platformId: 'casatrade', asset: 'EUR/USD (OTC)', price: 1.115,
    timeframe: 'M1', analysisTimeframe: 'M1', connection: 'online',
    serverTime: bucket + 55_000,
    candles: [...closed, { time: bucket, open: 1.078, high: 1.12, low: 1.075, close: 1.115, timeframe: 'M1' }]
  }, { connection: 'online' });

  assert.equal(stronger.signal.phase, 'FINAL');
  assert.equal(stronger.signal.state, 'CONFIRM');
  assert.equal(stronger.signal.direction, 'BUY');
  assert.equal(stronger.signal.provisional, false);
  assert.ok(stronger.signal.score >= 58);
  assert.equal(stronger.signal.secondsRemaining, 5);
  assert.equal(stronger.signal.targetStart, bucket + minute);
});

test('live analysis direction remains visible before the pre-signal window', () => {
  resetOrchestrator();
  const minute = 60_000;
  const bucket = Math.floor(1_700_175_000_000 / minute) * minute;
  const candles = [
    { time: bucket - 4 * minute, open: 1.00, high: 1.02, low: .99, close: 1.018, timeframe: 'M1' },
    { time: bucket - 3 * minute, open: 1.018, high: 1.04, low: 1.01, close: 1.038, timeframe: 'M1' },
    { time: bucket - 2 * minute, open: 1.038, high: 1.06, low: 1.03, close: 1.058, timeframe: 'M1' },
    { time: bucket - minute, open: 1.058, high: 1.08, low: 1.05, close: 1.078, timeframe: 'M1' },
    { time: bucket, open: 1.078, high: 1.10, low: 1.075, close: 1.098, timeframe: 'M1' }
  ];
  const out = processSnapshot({
    platformId: 'casatrade', asset: 'EUR/USD (OTC)', price: 1.098,
    timeframe: 'M1', analysisTimeframe: 'M1', connection: 'online',
    serverTime: bucket + 15_000, candles
  }, { connection: 'online' });
  assert.equal(out.signal.phase, 'ANALYZING');
  assert.equal(out.signal.direction, null);
  assert.equal(out.signal.analysisDirection, 'BUY');
  assert.equal(out.signal.analysisScore, out.signal.score);
});

test('completed final decision is exposed as last confirmed after candle rollover', () => {
  resetOrchestrator();
  const minute = 60_000;
  const bucket = Math.floor(1_700_190_000_000 / minute) * minute;
  const closed = [
    { time: bucket - 4 * minute, open: 1.00, high: 1.02, low: .99, close: 1.018, timeframe: 'M1' },
    { time: bucket - 3 * minute, open: 1.018, high: 1.04, low: 1.01, close: 1.038, timeframe: 'M1' },
    { time: bucket - 2 * minute, open: 1.038, high: 1.06, low: 1.03, close: 1.058, timeframe: 'M1' },
    { time: bucket - minute, open: 1.058, high: 1.08, low: 1.05, close: 1.078, timeframe: 'M1' }
  ];

  const final = processSnapshot({
    platformId: 'casatrade', asset: 'EUR/USD (OTC)', price: 1.11,
    timeframe: 'M1', analysisTimeframe: 'M1', connection: 'online',
    serverTime: bucket + 55_000,
    candles: [...closed, { time: bucket, open: 1.078, high: 1.115, low: 1.075, close: 1.11, timeframe: 'M1' }]
  }, { connection: 'online' });
  assert.equal(final.signal.state, 'CONFIRM');

  const next = processSnapshot({
    platformId: 'casatrade', asset: 'EUR/USD (OTC)', price: 1.112,
    timeframe: 'M1', analysisTimeframe: 'M1', connection: 'online',
    serverTime: bucket + minute + 5_000,
    candles: [
      ...closed,
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
  const minute = 60_000;
  const bucket = Math.floor(1_700_200_000_000 / minute) * minute;
  const candles = [
    { time: bucket - 4 * minute, open: 1.00, high: 1.02, low: .99, close: 1.018, timeframe: 'M1' },
    { time: bucket - 3 * minute, open: 1.018, high: 1.04, low: 1.01, close: 1.038, timeframe: 'M1' },
    { time: bucket - 2 * minute, open: 1.038, high: 1.06, low: 1.03, close: 1.058, timeframe: 'M1' },
    { time: bucket - minute, open: 1.058, high: 1.08, low: 1.05, close: 1.078, timeframe: 'M1' },
    { time: bucket, open: 1.078, high: 1.11, low: 1.075, close: 1.105, timeframe: 'M1' }
  ];
  const out = processSnapshot({
    platformId: 'casatrade', asset: 'EUR/USD (OTC)', price: 1.105,
    timeframe: 'M1', analysisTimeframe: 'M1', connection: 'online',
    serverTime: bucket + 20_000, secondsRemaining: 9, candles
  }, { connection: 'online' });
  assert.equal(out.signal.secondsRemaining, 9);
  assert.equal(out.signal.phase, 'FINAL');
});

test('platform detection rejects unrelated hosts', () => {
  assert.equal(detectPlatform('example.com'), null);
  assert.equal(detectPlatform('notcasatrade.io'), null);
  assert.equal(detectPlatform('casatrade.com')?.id, 'casatrade');
});
