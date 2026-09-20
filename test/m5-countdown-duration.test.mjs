import test from 'node:test';
import assert from 'node:assert/strict';

await import('../src/content/market-clock-math.js');
const clockMath = globalThis.__ATS_MARKET_CLOCK_MATH__;

test('M1 candle duration is exactly 60000ms and M5 is exactly 300000ms', () => {
  assert.equal(clockMath.durationMsForTimeframe('M1'), 60_000);
  assert.equal(clockMath.durationMsForTimeframe('M5'), 300_000);
});

test('visible M5 wins over a stale M1 platform control', () => {
  const timeframe = clockMath.selectCycleTimeframe({
    chartTimeframe: 'M5',
    controlTimeframe: 'M1',
    exactTimeframe: 'M1',
    platformTimeframe: 'M1'
  });
  assert.equal(timeframe, 'M5');
  assert.equal(clockMath.durationMsForTimeframe(timeframe), 300_000);
});

test('M5 countdown uses the real 5-minute boundary instead of a 60-second cycle', () => {
  const openAt = Date.UTC(2026, 8, 20, 13, 0, 0);
  const now = openAt + 110_000;
  assert.equal(clockMath.remainingSecondsFromOpen({ openAt, now, timeframe: 'M5' }), 190);
});

test('same elapsed time cannot masquerade as an M1 countdown', () => {
  const openAt = Date.UTC(2026, 8, 20, 13, 0, 0);
  assert.equal(clockMath.remainingSecondsFromOpen({ openAt, now: openAt + 49_000, timeframe: 'M1' }), 11);
  assert.equal(clockMath.remainingSecondsFromOpen({ openAt, now: openAt + 49_000, timeframe: 'M5' }), 251);
});
