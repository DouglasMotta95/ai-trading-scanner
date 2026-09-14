import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { marketRegime } from '../src/core/market-regime.js';
import { processSnapshot, resetOrchestrator } from '../src/core/orchestrator.js';

const minute = 60_000;
const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');

function bullish(bucket) {
  return [
    { time: bucket - 4 * minute, open: 1.000, high: 1.020, low: .990, close: 1.018, timeframe: 'M1' },
    { time: bucket - 3 * minute, open: 1.018, high: 1.040, low: 1.010, close: 1.038, timeframe: 'M1' },
    { time: bucket - 2 * minute, open: 1.038, high: 1.060, low: 1.030, close: 1.058, timeframe: 'M1' },
    { time: bucket - minute, open: 1.058, high: 1.080, low: 1.050, close: 1.078, timeframe: 'M1' },
    { time: bucket, open: 1.078, high: 1.115, low: 1.075, close: 1.110, timeframe: 'M1' }
  ];
}

function snapshot(bucket, offset, candles = bullish(bucket)) {
  return {
    platformId: 'casatrade', asset: 'EUR/USD', price: candles.at(-1).close,
    timeframe: 'M1', analysisTimeframe: 'M1', connection: 'online',
    serverTime: bucket + offset, candles
  };
}

test('stable setup stays in pattern-building before the 30-second preparation window', () => {
  resetOrchestrator();
  const bucket = Math.floor(1_800_300_000_000 / minute) * minute;
  const first = processSnapshot(snapshot(bucket, 10_000), { connection: 'online' });
  const second = processSnapshot(snapshot(bucket, 11_000), { connection: 'online' });
  assert.notEqual(first.signal.uiState, 'POSSIBLE_BUY');
  assert.equal(second.signal.uiState, 'BUILDING_PATTERN');
  assert.ok(second.signal.secondsRemaining > 30);
});

test('mobile-throttled observations still complete POSSIBLE inside the preparation window', () => {
  resetOrchestrator();
  const bucket = Math.floor(1_800_310_000_000 / minute) * minute;
  processSnapshot(snapshot(bucket, 35_000), { connection: 'online' });
  const second = processSnapshot(snapshot(bucket, 41_000), { connection: 'online' });
  assert.equal(second.signal.uiState, 'POSSIBLE_BUY');
  assert.ok(second.signal.secondsRemaining <= 30);
  assert.ok(second.signal.secondsRemaining > 15);
});

test('slow but consistent twenty-candle drift is a trend, not automatically range', () => {
  const candles = [];
  for (let i = 0; i < 20; i++) {
    const open = 1.1000 + i * 0.00018;
    const close = open + 0.00012;
    candles.push({ open, high: close + 0.00018, low: open - 0.00018, close });
  }
  const regime = marketRegime(candles);
  assert.equal(regime.type, 'uptrend');
  assert.ok(regime.efficiency >= .48);
});

test('overlay shows the levels and live engine state used for analysis', () => {
  const overlay = read('src/content/analysis-visual-overlay.js');
  for (const label of ['Preço atual', 'Resistência', 'Suporte', 'Gatilho compra', 'Gatilho venda', 'Aguardando:', 'Tendência alta', 'Mercado lateral']) {
    assert.ok(overlay.includes(label), `missing overlay diagnostic: ${label}`);
  }
  assert.match(overlay, /waiting\?\.type === 'breakout'/);
  assert.match(overlay, /pointerEvents = 'none'/);
});
