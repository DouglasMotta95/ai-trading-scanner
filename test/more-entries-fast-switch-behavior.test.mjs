import test from 'node:test';
import assert from 'node:assert/strict';
import { ANALYST_THRESHOLDS, analyzeCandles, recentPriceAction, waitingFor } from '../src/core/analysis.js';
import { A_PLUS_THRESHOLDS, assessHighConfidence } from '../src/core/high-confidence.js';
import { assessAssetQuality } from '../src/core/asset-quality.js';
import { MARKET_SWITCH_TIMING, isWithinSwitchGuard, resyncSchedule } from '../src/core/market-switch-timing.js';

const minute = 60_000;
const BASE = Date.UTC(2026, 8, 20, 12, 0, 0);

function score38Candles() {
  const rows = [];
  let price = 100;
  const directions = ['BUY','SELL','BUY','SELL','BUY','SELL','BUY','SELL',null];
  directions.forEach((direction, index) => {
    const open = price;
    const close = direction === 'BUY' ? open + .25 : direction === 'SELL' ? open - .25 : open;
    const high = index === 0 ? open + 1.4 : Math.max(open, close) + .375;
    const low = index === 0 ? open - .6 : Math.min(open, close) - .375;
    rows.push({ time: BASE + index * minute, open, high, low, close, timeframe: 'M1' });
    price = close;
  });
  const open = price;
  const close = open + .65;
  rows.push({
    time: BASE + 9 * minute,
    open,
    high: close + .175,
    low: open - .175,
    close,
    timeframe: 'M1'
  });
  return rows;
}

function stretchedCandles(rangeMultiple) {
  const rows = [];
  for (let index = 0; index < 9; index += 1) {
    const open = 100.7;
    const close = index % 2 === 0 ? 100.95 : 100.45;
    rows.push({
      time: BASE + index * minute,
      open,
      high: 101.2,
      low: 100.2,
      close,
      timeframe: 'M1'
    });
  }
  const open = 100;
  const close = 101.05;
  const high = 101.1;
  const low = high - rangeMultiple;
  rows.push({ time: BASE + 9 * minute, open, high, low, close, timeframe: 'M1' });
  return rows;
}

function trendHistory(count = 60) {
  const rows = [];
  let price = 1.05;
  for (let index = 0; index < count; index += 1) {
    const open = price;
    const close = open + .001;
    rows.push({
      time: BASE + index * minute,
      open,
      high: close + .0003,
      low: open - .0003,
      close,
      timeframe: 'M1'
    });
    price = close;
  }
  return rows;
}

function aPlusSignal(mult) {
  return {
    setup: 'continuação',
    regime: { type: 'uptrend' },
    analytics: {
      buyPower: 64,
      sellPower: 32,
      currentStrength: 66,
      rejectionDirection: 'BUY',
      rejectionStrength: 58,
      momentumDirection: 'BUY',
      momentumScore: 62,
      macdHistogram: .01,
      continuationDirection: 'BUY',
      continuationScore: 68,
      breakoutDirection: null,
      breakoutDistanceRatio: 0,
      currentRangeMultiple: mult,
      strongBreakout: false,
      overextendedImpulse: false,
      exhaustionRisk: false
    }
  };
}

function poorAssetState() {
  const candles = Array.from({ length: 10 }, (_, index) => {
    const open = 1 + (index % 2 ? .00002 : -.00002);
    const close = 1 + (index % 2 ? -.00002 : .00002);
    return {
      time: BASE + index * minute,
      open,
      high: 1.0005,
      low: .9995,
      close,
      timeframe: 'M1'
    };
  });
  return {
    asset: 'EUR/USD (OTC)',
    candles: candles.slice(0, 9),
    currentCandle: candles.at(-1),
    signal: {
      uiState: 'WAIT',
      analysisDirection: null,
      analysisScore: 30,
      regime: { type: 'range' },
      analytics: {
        buyPower: 45,
        sellPower: 45,
        currentStrength: 4,
        momentumScore: 10,
        continuationScore: 0,
        lossOfStrength: 20
      }
    }
  };
}

test('possibleScore 38 publishes WATCH on a real 38/100 candle pattern', () => {
  const candles = score38Candles();
  const recent = recentPriceAction(candles);
  assert.equal(recent.score, 38);
  assert.equal(recent.direction, 'BUY');
  assert.equal(ANALYST_THRESHOLDS.possibleScore, 38);
  const analyzed = analyzeCandles(candles, []);
  assert.equal(analyzed.score, 38);
  assert.equal(analyzed.state, 'WATCH');
  assert.equal(analyzed.direction, 'BUY');
});

test('confirmScore 52 becomes the exact next confirmation target', () => {
  const recent = recentPriceAction(score38Candles());
  assert.equal(ANALYST_THRESHOLDS.confirmScore, 52);
  const below = waitingFor(recent, 'BUY', 51);
  assert.equal(below.type, 'confirm_score');
  assert.equal(below.current, 51);
  assert.equal(below.required, 52);
  const atThreshold = waitingFor(recent, 'BUY', 52);
  assert.notEqual(atThreshold.type, 'confirm_score');
});

test('anti-chase allows 1.70x range but flags 1.76x', () => {
  const allowed = recentPriceAction(stretchedCandles(1.70));
  assert.ok(Math.abs(allowed.currentRangeMultiple - 1.70) < 1e-9);
  assert.equal(allowed.overextendedImpulse, false);
  assert.equal(allowed.exhaustionRisk, false);

  const blocked = recentPriceAction(stretchedCandles(1.76));
  assert.ok(Math.abs(blocked.currentRangeMultiple - 1.76) < 1e-9);
  assert.equal(blocked.overextendedImpulse, true);
  assert.equal(blocked.exhaustionRisk, true);
});

test('A+ stretch veto follows the same exact 1.75x boundary', () => {
  assert.equal(A_PLUS_THRESHOLDS.maxImpulseRangeMultiple, 1.75);
  const candles = trendHistory();
  const last = candles.at(-1);
  const currentCandle = {
    time: BASE + 60 * minute,
    open: last.close,
    high: last.close + .0006,
    low: last.close - .0003,
    close: last.close + .0003
  };

  const allowed = assessHighConfidence({
    candles,
    currentCandle,
    signal: aPlusSignal(1.70),
    direction: 'BUY',
    operatingTimeframe: 'M1',
    cycle: { possibleSince: Date.now() - 6000 }
  });
  assert.equal(allowed.hardVetoes.includes('vela-estendida-exaustão'), false);
  assert.equal(allowed.hardVetoes.includes('volatilidade-explosiva'), false);

  const blocked = assessHighConfidence({
    candles,
    currentCandle,
    signal: aPlusSignal(1.76),
    direction: 'BUY',
    operatingTimeframe: 'M1',
    cycle: { possibleSince: Date.now() - 6000 }
  });
  assert.equal(blocked.hardVetoes.includes('vela-estendida-exaustão'), true);
  assert.equal(blocked.hardVetoes.includes('volatilidade-explosiva'), true);
});

test('poor asset quality remains a visual warning and no longer blocks an entry', () => {
  const quality = assessAssetQuality(poorAssetState());
  assert.equal(quality.status, 'POOR');
  assert.equal(quality.label, 'ATIVO RUIM PARA OPERAR');
  assert.equal(quality.tradable, true);
  assert.equal(quality.blocking, false);
});

test('market-switch guard releases by 1.2s and resync completes inside 1.5s', () => {
  assert.equal(MARKET_SWITCH_TIMING.staleFocusProtectionMs, 1200);
  assert.equal(MARKET_SWITCH_TIMING.recentSelectionProtectionMs, 1200);
  assert.equal(isWithinSwitchGuard(1199), true);
  assert.equal(isWithinSwitchGuard(1200), false);
  assert.deepEqual(resyncSchedule(), [0, 120, 700]);
  assert.ok(Math.max(...resyncSchedule()) <= 1500);
});
