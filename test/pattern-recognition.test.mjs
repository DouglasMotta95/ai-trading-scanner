import test from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeCandles,
  detectPullbackContinuation,
  recentPriceAction
} from '../src/core/analysis.js';

const bullishPullback = () => [
  { open: 100.00, high: 100.60, low: 99.70, close: 100.30 },
  { open: 100.30, high: 101.00, low: 100.20, close: 100.80 },
  { open: 100.80, high: 102.00, low: 100.70, close: 101.10 },
  { open: 101.10, high: 101.50, low: 101.00, close: 101.40 },
  { open: 101.40, high: 101.45, low: 101.15, close: 101.22 },
  { open: 101.22, high: 101.52, low: 101.18, close: 101.48 }
];

const mirrorBearish = rows => rows.map(c => ({
  open: 200 - c.open,
  high: 200 - c.low,
  low: 200 - c.high,
  close: 200 - c.close
}));

test('detects a bullish pullback continuation with a higher low, unextended trigger and room', () => {
  const detected = detectPullbackContinuation(bullishPullback());
  assert.equal(detected.observed, true);
  assert.equal(detected.qualified, true);
  assert.equal(detected.direction, 'BUY');
  assert.equal(detected.higherStructure, true);
  assert.equal(detected.notStretched, true);
  assert.ok(detected.roomToLevel >= 0.35);
  assert.match(detected.reason, /Pullback compradora qualificado/i);
});

test('recognizes the mirrored bearish pullback continuation', () => {
  const detected = detectPullbackContinuation(mirrorBearish(bullishPullback()));
  assert.equal(detected.observed, true);
  assert.equal(detected.qualified, true);
  assert.equal(detected.direction, 'SELL');
  assert.equal(detected.higherStructure, true);
  assert.equal(detected.notStretched, true);
});

test('does not qualify an otherwise similar setup when price is too close to resistance', () => {
  const rows = bullishPullback();
  rows[2] = { ...rows[2], high: 101.65 };
  const detected = detectPullbackContinuation(rows);
  assert.equal(detected.observed, true);
  assert.equal(detected.qualified, false);
  assert.ok(detected.roomToLevel < 0.35);
  assert.match(detected.reason, /nível contrário|recuo|rompeu/i);
});

test('does not qualify a continuation if the trigger candle is stretched', () => {
  const rows = bullishPullback();
  rows[5] = { open: 101.22, high: 102.30, low: 101.05, close: 102.25 };
  const detected = detectPullbackContinuation(rows);
  assert.equal(detected.observed, true);
  assert.equal(detected.qualified, false);
  assert.equal(detected.notStretched, false);
  assert.match(detected.reason, /esticado/i);
});

test('feeds a qualified pullback into recent pattern score and professional context', () => {
  const candles = bullishPullback();
  const recent = recentPriceAction(candles, 'MEDIO');
  assert.equal(recent.direction, 'BUY');
  assert.equal(recent.pullbackContinuation?.qualified, true);

  const analysis = analyzeCandles(candles, candles, 'MEDIO');
  assert.equal(analysis.direction, 'BUY');
  assert.equal(analysis.analytics.pullbackContinuation?.qualified, true);
  assert.equal(analysis.analytics.professional.pullbackContinuation, true);
  assert.equal(analysis.analytics.professional.contextReady, true);
  assert.equal(analysis.analytics.professional.triggerReady, true);
});
