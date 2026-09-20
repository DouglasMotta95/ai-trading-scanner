import test from 'node:test';
import assert from 'node:assert/strict';
import { assessHighConfidence, profileForTimeframe } from '../src/core/high-confidence.js';
import { operatingTimeframeFromPreferences } from '../src/core/operation-mode.js';
import { MARKET_SWITCH_TIMING, protocolTakeoverAllowed, resyncSchedule } from '../src/core/market-switch-timing.js';

const minute = 60_000;
const BASE = Date.UTC(2026, 8, 20, 12, 0, 0);

function tenClosedM1Candles(direction = 'BUY') {
  const sign = direction === 'SELL' ? -1 : 1;
  const rows = [];
  let price = 1.05;
  for (let index = 0; index < 10; index += 1) {
    const open = price;
    const close = open + sign * .001;
    rows.push({
      time: BASE + index * minute,
      open,
      high: Math.max(open, close) + .0003,
      low: Math.min(open, close) - .0003,
      close,
      timeframe: 'M1'
    });
    price = close;
  }
  return rows;
}

function currentAfter(rows, direction = 'BUY') {
  const sign = direction === 'SELL' ? -1 : 1;
  const last = rows.at(-1);
  return {
    time: BASE + 10 * minute,
    open: last.close,
    high: last.close + .0005,
    low: last.close - .0002,
    close: last.close + sign * .0003,
    timeframe: 'M1'
  };
}

function liveSignal({ rejectionStrength, momentumScore }) {
  return {
    setup: 'continuação',
    regime: { type: 'uptrend' },
    analytics: {
      buyPower: 55,
      sellPower: 30,
      currentStrength: 55,
      rejectionDirection: 'BUY',
      rejectionStrength,
      momentumDirection: 'BUY',
      momentumScore,
      macdHistogram: .01,
      continuationDirection: 'BUY',
      continuationScore: 60,
      breakoutDirection: null,
      breakoutDistanceRatio: 0,
      currentRangeMultiple: 1.10,
      strongBreakout: false,
      overextendedImpulse: false,
      exhaustionRisk: false
    }
  };
}

test('live 10-candle M1 history is enough to evaluate A+ instead of permanent history veto', () => {
  const candles = tenClosedM1Candles();
  const result = assessHighConfidence({
    candles,
    currentCandle: currentAfter(candles),
    signal: liveSignal({ rejectionStrength: 45, momentumScore: 46 }),
    direction: 'BUY',
    operatingTimeframe: 'M1',
    cycle: { possibleSince: Date.now() - 3500 },
    now: Date.now()
  });
  assert.equal(profileForTimeframe('M1').minimumOperatingBars, 8);
  assert.equal(profileForTimeframe('M1').minimumContextBars, 1);
  assert.equal(result.data.operatingBars, 10);
  assert.equal(result.data.contextBars, 2);
  assert.equal(result.hardVetoes.includes('histórico-operacional-insuficiente'), false);
  assert.equal(result.hardVetoes.includes('histórico-contexto-insuficiente'), false);
});

test('A+ 45/100 now keeps POSSIBLE but does not prematurely release final entry', () => {
  const candles = tenClosedM1Candles();
  const result = assessHighConfidence({
    candles,
    currentCandle: currentAfter(candles),
    signal: liveSignal({ rejectionStrength: 45, momentumScore: 46 }),
    direction: 'BUY',
    operatingTimeframe: 'M1',
    cycle: { possibleSince: Date.now() - 3500 },
    now: Date.now()
  });
  assert.equal(result.thresholds.possibleScore, 38);
  assert.equal(result.thresholds.enterScore, 52);
  assert.equal(result.score, 45);
  assert.equal(result.candidateAllowed, true);
  assert.equal(result.finalAllowed, false);
});

test('A+ 57/100 releases final technical entry with the new 52 threshold', () => {
  const candles = tenClosedM1Candles();
  const result = assessHighConfidence({
    candles,
    currentCandle: currentAfter(candles),
    signal: liveSignal({ rejectionStrength: 60, momentumScore: 60 }),
    direction: 'BUY',
    operatingTimeframe: 'M1',
    cycle: { possibleSince: Date.now() - 6000 },
    now: Date.now()
  });
  assert.equal(result.score, 57);
  assert.equal(result.candidateAllowed, true);
  assert.equal(result.finalAllowed, true);
});

test('operating timeframe defaults to M1 and only explicit M5 selects M5', () => {
  assert.equal(operatingTimeframeFromPreferences({}), 'M1');
  assert.equal(operatingTimeframeFromPreferences({ operatingTimeframe: null }), 'M1');
  assert.equal(operatingTimeframeFromPreferences({ operatingTimeframe: 'M1' }), 'M1');
  assert.equal(operatingTimeframeFromPreferences({ operatingTimeframe: 'M5' }), 'M5');
});

test('stale visual lock can be replaced by a stable explicit protocol market by 1.2s', () => {
  assert.equal(MARKET_SWITCH_TIMING.staleFocusProtectionMs, 1200);
  assert.equal(protocolTakeoverAllowed({
    oldFocusAgeMs: 1199,
    recentSelectionAgeMs: 1199,
    incomingExplicit: true,
    incomingStable: true
  }), false);
  assert.equal(protocolTakeoverAllowed({
    oldFocusAgeMs: 1200,
    recentSelectionAgeMs: 1200,
    incomingExplicit: true,
    incomingStable: true
  }), true);
  assert.deepEqual(resyncSchedule(), [0, 120, 700]);
  assert.ok(Math.max(...resyncSchedule()) <= 1500);
});
