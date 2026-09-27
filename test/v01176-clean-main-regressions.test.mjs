import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeCandles, ANALYST_THRESHOLDS } from '../src/core/analysis.js';
import { processSnapshot, resetOrchestrator } from '../src/core/orchestrator.js';

const MINUTE = 60_000;
const FIVE_MINUTES = 5 * MINUTE;

function m1Rows(start, count = 10) {
  return Array.from({ length: count }, (_, i) => {
    const time = start - (count - i) * MINUTE;
    const open = 1 + i * 0.001;
    const close = open + 0.0006;
    return {
      time,
      open,
      high: close + 0.0004,
      low: open - 0.0003,
      close,
      timeframe: 'M1'
    };
  });
}

test('M5 clock normalizes seconds and anchors the next target to the 5-minute boundary', () => {
  resetOrchestrator();
  const bucket = Math.floor(1_800_000_000_000 / FIVE_MINUTES) * FIVE_MINUTES;
  const candles = m1Rows(bucket, 10);
  const serverTimeSeconds = Math.floor((bucket + 90_000) / 1000);

  const out = processSnapshot({
    platformId: 'casatrade',
    asset: 'EUR/USD (OTC)',
    price: 1.011,
    timeframe: 'M5',
    analysisTimeframe: 'M5',
    connection: 'online',
    serverTime: serverTimeSeconds,
    candles
  }, { connection: 'online' });

  assert.equal(out.signal.timeframe, 'M5');
  assert.equal(out.signal.candleCount, 2);
  assert.equal(out.signal.currentCandle.time, bucket);
  assert.equal(out.signal.clock.source, 'serverTime');
  assert.equal(out.signal.clock.currentBucket, bucket);
  assert.equal(out.signal.targetStart, bucket + FIVE_MINUTES);
  assert.equal(out.signal.targetStart % FIVE_MINUTES, 0);
  assert.equal(out.signal.clock.platformClockAligned, false);

  resetOrchestrator();
  const untagged = candles.map(({ timeframe, ...row }) => row);
  const untaggedOut = processSnapshot({
    platformId: 'casatrade',
    asset: 'EUR/USD (OTC)',
    price: 1.011,
    timeframe: 'M5',
    analysisTimeframe: 'M5',
    connection: 'online',
    serverTime: serverTimeSeconds,
    candles: untagged
  }, { connection: 'online' });
  assert.equal(untaggedOut.signal.candleCount, 2);
  assert.equal(untaggedOut.signal.clock.currentBucket, bucket);
});

test('rejection strength remains direction-aware and does not change the decision threshold', () => {
  const candles = [
    { open: 1.00, high: 1.02, low: 0.99, close: 1.015 },
    { open: 1.015, high: 1.03, low: 1.00, close: 1.025 },
    { open: 0.55, high: 1.00, low: 0.00, close: 0.90 }
  ];
  const result = analyzeCandles(candles);
  assert.equal(result.recent.rejection, 'BUY');
  assert.equal(result.analytics.rejectionDirection, 'BUY');
  assert.equal(Math.round(result.analytics.rejectionStrength), 55);
  assert.equal(result.analytics.rejectionGeometry.threshold, ANALYST_THRESHOLDS.rejectionStrength);
  assert.equal(result.analytics.rejectionGeometry.strongBodyThreshold, ANALYST_THRESHOLDS.candleStrength);
  assert.equal(result.analytics.rejectionGeometry.simultaneousThresholdsFeasible, false);
  assert.equal(ANALYST_THRESHOLDS.rejectionStrength, 50);
  assert.equal(ANALYST_THRESHOLDS.candleStrength, 62);
});
