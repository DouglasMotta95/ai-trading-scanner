import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { assessHighConfidence, A_PLUS_THRESHOLDS, A_PLUS_WEIGHTS } from '../src/core/high-confidence.js';

const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');

const BASE = Date.UTC(2026, 0, 1, 12, 0, 0);
function trendCandles({ count = 36, start = 1, step = .001, direction = 'BUY' } = {}) {
  const sign = direction === 'SELL' ? -1 : 1;
  const rows = [];
  let price = start;
  for (let i = 0; i < count; i += 1) {
    const open = price;
    const close = open + sign * step * .55;
    const high = Math.max(open, close) + step * .22;
    const low = Math.min(open, close) - step * .22;
    rows.push({ time: BASE + i * 60_000, open, high, low, close, timeframe: 'M1' });
    price = close;
  }
  return rows;
}
function signal(direction = 'BUY', extra = {}) {
  const buy = direction === 'BUY';
  return {
    setup: 'continuação',
    regime: { type: buy ? 'uptrend' : 'downtrend' },
    analytics: {
      buyPower: buy ? 62 : 35,
      sellPower: buy ? 35 : 62,
      currentStrength: 66,
      rejectionDirection: null,
      rejectionStrength: 0,
      momentumDirection: direction,
      momentumScore: 62,
      macdHistogram: buy ? .01 : -.01,
      continuationDirection: direction,
      continuationScore: 70,
      breakoutDirection: null,
      breakoutDistanceRatio: 0,
      currentRangeMultiple: 1.05,
      strongBreakout: false,
      overextendedImpulse: false,
      exhaustionRisk: false,
      ...extra
    }
  };
}

test('A+ weights are independent buckets that total 100', () => {
  const total = Object.values(A_PLUS_WEIGHTS).reduce((sum, value) => sum + value, 0);
  assert.equal(total, 100);
  assert.deepEqual(A_PLUS_WEIGHTS, {
    structure: 25,
    supportResistance: 20,
    priceAction: 20,
    momentum: 10,
    breakout: 10,
    volatility: 10,
    stability: 5
  });
});

test('A+ refuses to create a high-confidence candidate without enough M1/M5 history', () => {
  const candles = trendCandles({ count: 10 });
  const result = assessHighConfidence({
    candles,
    currentCandle: { ...candles.at(-1), time: BASE + 10 * 60_000 },
    signal: signal('BUY'),
    direction: 'BUY',
    cycle: { possibleSince: Date.now() - 6000 }
  });
  assert.equal(result.candidateAllowed, false);
  assert.equal(result.finalAllowed, false);
  assert.ok(result.hardVetoes.includes('histórico-m1-insuficiente'));
  assert.ok(result.hardVetoes.includes('histórico-m5-insuficiente'));
});

test('A+ blocks a BUY when the derived M5 structure is clearly bearish', () => {
  const candles = trendCandles({ count: 40, direction: 'SELL' });
  const result = assessHighConfidence({
    candles,
    currentCandle: { ...candles.at(-1), time: BASE + 40 * 60_000 },
    signal: signal('BUY'),
    direction: 'BUY',
    cycle: { possibleSince: Date.now() - 7000 }
  });
  assert.ok(result.hardVetoes.includes('m5-contra-direção'));
  assert.equal(result.finalAllowed, false);
});

test('A+ hard-vetoes stretched/exhausted impulse instead of chasing it', () => {
  const candles = trendCandles({ count: 40, direction: 'BUY' });
  const result = assessHighConfidence({
    candles,
    currentCandle: { ...candles.at(-1), time: BASE + 40 * 60_000 },
    signal: signal('BUY', { overextendedImpulse: true, exhaustionRisk: true, currentRangeMultiple: 1.8 }),
    direction: 'BUY',
    cycle: { possibleSince: Date.now() - 7000 }
  });
  assert.ok(result.hardVetoes.includes('vela-estendida-exaustão'));
  assert.equal(result.finalAllowed, false);
});

test('A+ adaptive history only blocks a setup after a meaningful sample', () => {
  const candles = trendCandles({ count: 40, direction: 'BUY' });
  const journal = Array.from({ length: A_PLUS_THRESHOLDS.adaptiveMinSamples }, (_, index) => ({
    resolved: true,
    direction: 'BUY',
    setup: 'continuação',
    regime: 'uptrend',
    outcome: index < 8 ? 'WIN' : 'LOSS'
  }));
  const result = assessHighConfidence({
    candles,
    currentCandle: { ...candles.at(-1), time: BASE + 40 * 60_000 },
    signal: signal('BUY'),
    direction: 'BUY',
    cycle: { possibleSince: Date.now() - 7000 },
    journal
  });
  assert.equal(result.historical.samples, A_PLUS_THRESHOLDS.adaptiveMinSamples);
  assert.ok(result.hardVetoes.includes('setup-histórico-fraco'));
});

test('orchestrator uses A+ candidate and final gates instead of raw technical score alone', () => {
  const orchestrator = read('src/core/orchestrator.js');
  assert.match(orchestrator, /assessHighConfidence/);
  assert.match(orchestrator, /stableAPlus\.candidateAllowed/);
  assert.match(orchestrator, /aPlus\.finalAllowed/);
  assert.match(orchestrator, /A\+ \$\{Math\.round\(aPlus\.score\)\}\/100/);
});

test('background journals issued signals and resolves WIN LOSS from target candle', () => {
  const background = read('src/background.js');
  assert.match(background, /function resolveSignalJournal/);
  assert.match(background, /outcome = delta === 0/);
  assert.match(background, /\? 'WIN' : 'LOSS'/);
  assert.match(background, /signalJournal = resolveSignalJournal/);
});

test('A+ product mode is forced as the default in UI and policy metadata', () => {
  const app = read('src/sidepanel/app-v2.js');
  const policy = read('src/background-decision-policy.js');
  assert.match(app, /analystMode: 'A_PLUS'/);
  assert.match(app, /mode: 'A_PLUS'/);
  assert.match(policy, /mode: 'A_PLUS'/);
});


test('A+ can still authorize a genuinely aligned high-confidence setup', () => {
  const candles = trendCandles({ count: 40, direction: 'BUY' });
  const last = candles.at(-1).close;
  const result = assessHighConfidence({
    candles,
    currentCandle: {
      time: BASE + 40 * 60_000,
      open: last,
      high: last + .0005,
      low: last - .00035,
      close: last + .00025
    },
    signal: signal('BUY', {
      rejectionDirection: 'BUY',
      rejectionStrength: 62,
      buyPower: 64,
      sellPower: 30
    }),
    direction: 'BUY',
    cycle: { possibleSince: Date.now() - 7000 }
  });
  assert.ok(result.score >= A_PLUS_THRESHOLDS.enterScore);
  assert.equal(result.finalAllowed, true);
  assert.deepEqual(result.hardVetoes, []);
});
