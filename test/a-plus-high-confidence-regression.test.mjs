import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { assessHighConfidence, A_PLUS_THRESHOLDS, A_PLUS_WEIGHTS, A_PLUS_PROFILES } from '../src/core/high-confidence.js';

const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');

const BASE = Date.UTC(2026, 0, 1, 12, 0, 0);
function trendCandles({ count = 80, start = 1, step = .001, direction = 'BUY', timeframe = 'M1', intervalMs = 60_000 } = {}) {
  const sign = direction === 'SELL' ? -1 : 1;
  const rows = [];
  let price = start;
  for (let i = 0; i < count; i += 1) {
    const open = price;
    const close = open + sign * step * .55;
    const high = Math.max(open, close) + step * .22;
    const low = Math.min(open, close) - step * .22;
    rows.push({ time: BASE + i * intervalMs, open, high, low, close, timeframe });
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
  assert.equal(Object.values(A_PLUS_WEIGHTS).reduce((sum, value) => sum + value, 0), 100);
});

test('profiles map M1->M5/1min and M5->M15/5min', () => {
  assert.equal(A_PLUS_PROFILES.M1.contextTimeframe, 'M5');
  assert.equal(A_PLUS_PROFILES.M1.requiredExpiration, '60s');
  assert.equal(A_PLUS_PROFILES.M5.contextTimeframe, 'M15');
  assert.equal(A_PLUS_PROFILES.M5.requiredExpiration, '300s');
  assert.ok(A_PLUS_PROFILES.M5.enterScore >= A_PLUS_PROFILES.M1.enterScore);
});

test('A+ refuses candidate without enough operational/context history', () => {
  const candles = trendCandles({ count: 4 });
  const result = assessHighConfidence({
    candles,
    currentCandle: { ...candles.at(-1), time: BASE + 4 * 60_000 },
    signal: signal('BUY'),
    direction: 'BUY',
    operatingTimeframe: 'M1',
    cycle: { possibleSince: Date.now() - 6000 }
  });
  assert.equal(result.candidateAllowed, false);
  assert.ok(result.hardVetoes.includes('histórico-operacional-insuficiente'));
  assert.ok(result.hardVetoes.includes('histórico-contexto-insuficiente'));
});

test('M1 operation blocks BUY when M5 context is bearish', () => {
  const candles = trendCandles({ count: 40, direction: 'SELL' });
  const result = assessHighConfidence({
    candles,
    currentCandle: { ...candles.at(-1), time: BASE + 40 * 60_000 },
    signal: signal('BUY'),
    direction: 'BUY',
    operatingTimeframe: 'M1',
    cycle: { possibleSince: Date.now() - 7000 }
  });
  assert.ok(result.hardVetoes.includes('contexto-contra-direção'));
  assert.equal(result.finalAllowed, false);
});

test('M5 operation derives M15 context from M1 source data', () => {
  const candles = trendCandles({ count: 180, direction: 'BUY' });
  const last = candles.at(-1).close;
  const result = assessHighConfidence({
    candles,
    currentCandle: { time: BASE + 180 * 60_000, open: last, high: last + .0005, low: last - .00035, close: last + .00025 },
    signal: signal('BUY', { rejectionDirection: 'BUY', rejectionStrength: 62, buyPower: 64, sellPower: 30 }),
    direction: 'BUY',
    operatingTimeframe: 'M5',
    cycle: { possibleSince: Date.now() - 9000 }
  });
  assert.equal(result.operatingTimeframe, 'M5');
  assert.equal(result.contextTimeframe, 'M15');
  assert.equal(result.requiredExpiration, '300s');
  assert.ok(result.data.operatingBars >= 20);
  assert.ok(result.data.contextBars >= 6);
});

test('A+ hard-vetoes stretched/exhausted impulse', () => {
  const candles = trendCandles({ count: 40, direction: 'BUY' });
  const result = assessHighConfidence({
    candles,
    currentCandle: { ...candles.at(-1), time: BASE + 40 * 60_000 },
    signal: signal('BUY', { overextendedImpulse: true, exhaustionRisk: true, currentRangeMultiple: 1.8 }),
    direction: 'BUY',
    operatingTimeframe: 'M1',
    cycle: { possibleSince: Date.now() - 7000 }
  });
  assert.ok(result.hardVetoes.includes('vela-estendida-exaustão'));
  assert.equal(result.finalAllowed, false);
});

test('adaptive history blocks only after meaningful sample in same timeframe', () => {
  const candles = trendCandles({ count: 40, direction: 'BUY' });
  const journal = Array.from({ length: A_PLUS_THRESHOLDS.adaptiveMinSamples }, (_, index) => ({
    resolved: true,
    direction: 'BUY',
    timeframe: 'M1',
    setup: 'continuação',
    regime: 'uptrend',
    outcome: index < 8 ? 'WIN' : 'LOSS'
  }));
  const result = assessHighConfidence({
    candles,
    currentCandle: { ...candles.at(-1), time: BASE + 40 * 60_000 },
    signal: signal('BUY'),
    direction: 'BUY',
    operatingTimeframe: 'M1',
    cycle: { possibleSince: Date.now() - 7000 },
    journal
  });
  assert.equal(result.historical.samples, A_PLUS_THRESHOLDS.adaptiveMinSamples);
  assert.ok(result.hardVetoes.includes('setup-histórico-fraco'));
});

test('orchestrator uses A+ candidate/final gates and passes operating timeframe', () => {
  const orchestrator = read('src/core/orchestrator.js');
  assert.match(orchestrator, /assessHighConfidence/);
  assert.match(orchestrator, /operatingTimeframe: snapshot.analysisTimeframe/);
  assert.match(orchestrator, /stableAPlus.candidateAllowed/);
  assert.match(orchestrator, /aPlus.finalAllowed/);
});

test('background journals next-candle entry quote and resolves target duration', () => {
  const start = BASE + 50 * 60_000;
  const issued = {
    asset: 'EUR/USD (OTC)',
    direction: 'BUY',
    targetStart: start,
    activeUntil: start + 60_000,
    issuedAt: start - 5000,
    timeframe: 'M1'
  };
  const active = updateSignalJournal({
    previousRows: [],
    snapshot: {
      asset: 'EUR/USD (OTC)',
      candles: [{ time: start, open: 1.2, high: 1.2004, low: 1.1998, close: 1.2002 }]
    },
    issued,
    tfMs: 60_000,
    now: start + 1000
  });
  assert.equal(active[0].entryPrice, 1.2);
  assert.equal(active[0].status, 'ACTIVE');

  const resolved = updateSignalJournal({
    previousRows: active,
    snapshot: {
      asset: 'EUR/USD (OTC)',
      candles: [{ time: start, open: 1.2, high: 1.2007, low: 1.1998, close: 1.2005 }]
    },
    tfMs: 60_000,
    now: start + 60_100
  });
  assert.equal(resolved[0].exitPrice, 1.2005);
  assert.equal(resolved[0].outcome, 'WIN');
});

test('aligned high-confidence M1 rejection can still authorize entry', () => {
  const candles = trendCandles({ count: 40, direction: 'BUY' });
  const last = candles.at(-1).close;
  const result = assessHighConfidence({
    candles,
    currentCandle: { time: BASE + 40 * 60_000, open: last, high: last + .0005, low: last - .00035, close: last + .00025 },
    signal: signal('BUY', { rejectionDirection: 'BUY', rejectionStrength: 62, buyPower: 64, sellPower: 30 }),
    direction: 'BUY',
    operatingTimeframe: 'M1',
    cycle: { possibleSince: Date.now() - 7000 }
  });
  assert.ok(result.score >= A_PLUS_PROFILES.M1.enterScore);
  assert.equal(result.finalAllowed, true);
  assert.deepEqual(result.hardVetoes, []);
});
