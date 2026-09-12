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

test('final decision is locked in the last 10 seconds for the next candle', () => {
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

test('platform detection rejects unrelated hosts', () => {
  assert.equal(detectPlatform('example.com'), null);
  assert.equal(detectPlatform('notcasatrade.io'), null);
  assert.equal(detectPlatform('casatrade.com')?.id, 'casatrade');
});
