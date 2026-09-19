import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeCandles, INDICATOR_SCORE_WEIGHTS } from '../src/core/analysis.js';
import { processSnapshot, resetOrchestrator } from '../src/core/orchestrator.js';

const DIRECTIONS = [1, 1, -1, 1, -1, 1, 1, -1, 1, 1];

function scoringFixture({ preDelta = .001, bucket = null } = {}) {
  const minute = 60_000;
  const candles = [];
  let price = .97;

  for (let i = 0; i < 30; i++) {
    const open = price;
    const close = open + preDelta;
    candles.push({ open, high: close + .003, low: open - .003, close });
    price = close;
  }

  for (const direction of DIRECTIONS) {
    const open = price;
    const close = open + direction * .004;
    candles.push({
      open,
      high: Math.max(open, close) + .008,
      low: Math.min(open, close) - .008,
      close
    });
    price = close;
  }

  if (bucket != null) {
    candles.forEach((candle, index) => {
      candle.time = bucket - (candles.length - 1 - index) * minute;
      candle.timeframe = 'M1';
    });
  }

  return { candles, recent: candles.slice(-10) };
}

test('approved indicator weights stay exact', () => {
  assert.deepEqual(INDICATOR_SCORE_WEIGHTS, {
    rsiFavor: 8,
    macdFavor: 10,
    macdAgainst: -10,
    ema: 0,
    bollinger: 0
  });
});

test('RSI and MACD reinforce the score without changing the 10-candle price action window', () => {
  const { candles, recent } = scoringFixture({ preDelta: .001 });
  const before = analyzeCandles(recent, []);
  const after = analyzeCandles(recent, candles);

  assert.equal(before.recent.count, 10);
  assert.equal(before.direction, 'BUY');
  assert.equal(before.baseScore, 44);
  assert.equal(before.score, 44);

  assert.equal(after.recent.count, 10);
  assert.equal(after.direction, 'BUY');
  assert.equal(after.baseScore, 44);
  assert.equal(after.indicators.rsi.effect, 8);
  assert.equal(after.indicators.macd.effect, 10);
  assert.equal(after.indicators.ema.effect, 0);
  assert.equal(after.indicators.bollinger.effect, 0);
  assert.equal(after.indicators.adjustment, 18);
  assert.equal(after.score, 62);
  assert.ok(Number.isFinite(after.analytics.buyPower));
  assert.ok(Number.isFinite(after.analytics.sellPower));
  assert.ok(Number.isFinite(after.analytics.currentStrength));
  assert.ok(Number.isFinite(after.analytics.momentumScore));
});

test('MACD against the price-action direction subtracts exactly 10', () => {
  const { candles, recent } = scoringFixture({ preDelta: .002 });
  const result = analyzeCandles(recent, candles);

  assert.equal(result.direction, 'BUY');
  assert.equal(result.baseScore, 44);
  assert.equal(result.indicators.rsi.effect, 8);
  assert.equal(result.indicators.macd.effect, -10);
  assert.equal(result.indicators.adjustment, -2);
  assert.equal(result.score, 42);
});

test('orchestrator uses extended history for indicators while A+ independently gates the entry', () => {
  resetOrchestrator();
  const minute = 60_000;
  const bucket = Math.floor(1_701_000_000_000 / minute) * minute;
  const { candles } = scoringFixture({ preDelta: .001, bucket });
  const current = candles.at(-1);

  const snapshot = serverTime => ({
    platformId: 'casatrade',
    asset: 'EUR/USD (OTC)',
    price: current.close,
    timeframe: 'M1',
    analysisTimeframe: 'M1',
    connection: 'online',
    serverTime,
    candles
  });

  const first = processSnapshot(snapshot(bucket + 35_000), { connection: 'online' });
  assert.notEqual(first.signal.state, 'WATCH');

  const out = processSnapshot(snapshot(bucket + 36_000), { connection: 'online' });
  assert.equal(out.signal.analysisScore, 62);
  assert.equal(out.candles.length, 39);
  assert.equal(out.signal.aPlus?.candidateAllowed, false);
  assert.ok(Array.isArray(out.signal.aPlus?.hardVetoes));
  assert.ok(out.signal.aPlus.hardVetoes.length > 0);
});
