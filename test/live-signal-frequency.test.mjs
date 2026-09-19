import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { marketRegime } from '../src/core/market-regime.js';
import { processSnapshot, resetOrchestrator } from '../src/core/orchestrator.js';
import { bullishAPlusRows, minute } from './helpers/current-a-plus-fixtures.mjs';
const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');

function bullish(bucket) {
  return bullishAPlusRows(bucket);
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

test('overlay shows only relevant support, resistance and one directional entry trigger', () => {
  const overlay = read('src/content/analysis-visual-overlay-v2.js');
  for (const label of ['Resistência relevante', 'Suporte relevante', 'Entrada COMPRA', 'Entrada VENDA']) assert.ok(overlay.includes(label), `missing overlay line: ${label}`);
  for (const legacy of ['Preço atual', 'Gatilho compra', 'Gatilho venda', 'Aguardando:']) assert.ok(!overlay.includes(legacy), `legacy overlay clutter remained: ${legacy}`);
  assert.match(overlay, /const trigger = activeTrigger\(analytics, waiting\)/);
  assert.match(overlay, /if \(trigger\) \{/);
  assert.match(overlay, /pointerEvents: 'none'/);
  assert.match(overlay, /sameMarket\(focus\?\.asset, state\.asset\)/);
});
