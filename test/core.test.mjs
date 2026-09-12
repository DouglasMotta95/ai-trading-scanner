import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeCandles } from '../src/core/analysis.js';
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

test('platform detection accepts only the real CasaTrade web app host', () => {
  assert.equal(detectPlatform('trade.casatrade.com')?.id, 'casatrade');
  for (const host of ['casatrade.com', 'www.casatrade.com', 'app.casatrade.com', 'casatrade.io', 'trade.casatrade.io', 'example.com', 'notcasatrade.io']) {
    assert.equal(detectPlatform(host), null, `${host} must not be treated as the trading app`);
  }
});