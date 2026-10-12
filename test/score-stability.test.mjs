import test from 'node:test';
import assert from 'node:assert/strict';
import { createScoreStabilizer, scoreCycleKey } from '../src/core/score-stability.js';

test('score cycle key is stable while raw live-candle timestamps change within one candle', () => {
  const first = scoreCycleKey({
    asset: 'EUR/USD (OTC)',
    timeframe: 'M1',
    candle: { time: 1791817020000 },
    clock: { timeframe: 'M1', openAt: 1791817020000 }
  });
  const nextTick = scoreCycleKey({
    asset: 'EUR/USD (OTC)',
    timeframe: 'M1',
    candle: { time: 1791817045000 },
    clock: { timeframe: 'M1', openAt: 1791817020000 }
  });
  assert.equal(first, nextTick);
});

test('score cycle key resets at a new candle boundary and normalizes seconds timestamps', () => {
  const first = scoreCycleKey({
    asset: 'EUR/USD (OTC)', timeframe: 'M1',
    candle: { time: 1791817020 }, clock: { openAt: 1791817020 }
  });
  const nextCandle = scoreCycleKey({
    asset: 'EUR/USD (OTC)', timeframe: 'M1',
    candle: { time: 1791817080 }, clock: { openAt: 1791817080 }
  });
  assert.notEqual(first, nextCandle);
  assert.equal(first, scoreCycleKey({
    asset: 'EUR/USD (OTC)', timeframe: 'M1',
    candle: { time: 1791817020000 }, clock: { openAt: 1791817020000 }
  }));
});

test('large score jumps are smoothed within a candle and raw score returns on rollover', () => {
  const smoother = createScoreStabilizer({ alpha: 0.2, sampleIntervalMs: 650, maxPointsPerSecond: 6 });
  assert.equal(smoother.update({ key: 'EUR/USD|M1|1', rawScore: 61, ready: true, at: 1000 }), 61);
  const drop = smoother.update({ key: 'EUR/USD|M1|1', rawScore: 4, ready: true, at: 1650 });
  assert.ok(drop < 61 && drop > 50, `expected a smoothed drop, got ${drop}`);
  const rebound = smoother.update({ key: 'EUR/USD|M1|1', rawScore: 73, ready: true, at: 2300 });
  assert.ok(rebound > drop && rebound < 65, `expected a smoothed rebound, got ${rebound}`);
  assert.equal(smoother.update({ key: 'EUR/USD|M1|2', rawScore: 73, ready: true, at: 2950 }), 73);
});

test('score stabilizer resets when technical data is not market-ready', () => {
  const smoother = createScoreStabilizer();
  smoother.update({ key: 'EUR/USD|M1|1', rawScore: 61, ready: true, at: 1000 });
  assert.equal(smoother.update({ key: 'EUR/USD|M1|1', rawScore: 0, ready: false, at: 1650 }), 0);
  assert.equal(smoother.update({ key: 'EUR/USD|M1|1', rawScore: 4, ready: true, at: 2300 }), 4);
});
