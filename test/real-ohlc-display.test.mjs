import test from 'node:test';
import assert from 'node:assert/strict';

await import('../src/core/ohlc-display.js');
const { selectDisplayOhlc } = globalThis.__ATS_OHLC_DISPLAY__;

const NOW = Date.UTC(2026, 8, 20, 15, 3, 10);

test('partial locally assembled candle never appears as real OHLC numbers', () => {
  const state = {
    price: 1.23456,
    timeframe: 'M5',
    signal: {
      currentCandle: {
        time: NOW - 120_000,
        open: 9,
        high: 10,
        low: 8,
        close: 9.5,
        partial: true,
        openReliable: false,
        rangeReliable: false
      }
    },
    candles: []
  };
  assert.deepEqual(selectDisplayOhlc(state, NOW), {
    open: null,
    high: null,
    low: null,
    close: 1.23456,
    approximate: false,
    source: 'live-price-only'
  });
});

test('structured current M5 candle is shown with exact OHLC', () => {
  const row = {
    time: NOW - 120_000,
    open: 1.2,
    high: 1.25,
    low: 1.18,
    close: 1.23,
    timeframe: 'M5'
  };
  const state = { price: 1.23, timeframe: 'M5', candles: [row] };
  assert.deepEqual(selectDisplayOhlc(state, NOW), {
    open: 1.2,
    high: 1.25,
    low: 1.18,
    close: 1.23,
    approximate: false,
    source: 'structured-casatrade'
  });
});

test('stale historical candle is not reused as current numeric OHLC', () => {
  const row = {
    time: NOW - 600_000,
    open: 1.1,
    high: 1.2,
    low: 1.0,
    close: 1.15,
    timeframe: 'M5'
  };
  const state = { price: 1.2345, timeframe: 'M5', candles: [row] };
  const result = selectDisplayOhlc(state, NOW);
  assert.equal(result.open, null);
  assert.equal(result.high, null);
  assert.equal(result.low, null);
  assert.equal(result.close, 1.2345);
  assert.equal(result.source, 'live-price-only');
});
