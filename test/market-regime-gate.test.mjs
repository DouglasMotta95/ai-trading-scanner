import test from 'node:test';
import assert from 'node:assert/strict';
import { marketRegime } from '../src/core/market-regime.js';
import { processSnapshot, resetOrchestrator } from '../src/core/orchestrator.js';

const minute = 60_000;
function rangeWithStrongCurrent(bucket) {
  const candles = [];
  for (let i = 20; i >= 10; i--) {
    const index = 20 - i;
    const open = 1.1000 + (index % 2 === 0 ? -0.0010 : 0.0010);
    const close = 1.1000 + (index % 3 === 0 ? 0.0010 : -0.0010);
    candles.push({ time: bucket - i * minute, open, high: 1.1500, low: 1.0500, close, timeframe: 'M1' });
  }
  for (let i = 9; i >= 1; i--) {
    const step = 9 - i;
    const open = 1.0900 + step * 0.0020;
    const close = open + 0.0017;
    candles.push({ time: bucket - i * minute, open, high: close + 0.0002, low: open - 0.0002, close, timeframe: 'M1' });
  }
  candles.push({ time: bucket, open: 1.1080, high: 1.1125, low: 1.1078, close: 1.1122, timeframe: 'M1' });
  return candles;
}
function snapshot(bucket, offset, candles) {
  return { platformId: 'casatrade', asset: 'EUR/USD', price: 1.1122, timeframe: 'M1', analysisTimeframe: 'M1', connection: 'online', serverTime: bucket + offset, candles };
}

test('market regime classifies the fixture as range', () => {
  const bucket = Math.floor(1_800_100_000_000 / minute) * minute;
  const candles = rangeWithStrongCurrent(bucket);
  assert.equal(marketRegime(candles.slice(0, -1)).type, 'range');
});

test('range regime is blocked unless the A+ edge/breakout requirements are truly satisfied', () => {
  resetOrchestrator();
  const bucket = Math.floor(1_800_110_000_000 / minute) * minute;
  const candles = rangeWithStrongCurrent(bucket);
  processSnapshot(snapshot(bucket, 35_000, candles), { connection: 'online' });
  processSnapshot(snapshot(bucket, 36_000, candles), { connection: 'online' });
  const firstFinal = processSnapshot(snapshot(bucket, 51_000, candles), { connection: 'online' });
  const final = processSnapshot(snapshot(bucket, 52_000, candles), { connection: 'online' });

  assert.equal(final.signal.regime?.type, 'range');
  assert.ok(Number(final.signal.analysisScore) >= 58);
  assert.notEqual(final.signal.state, 'CONFIRM');
  assert.ok(['BUILDING_PATTERN','DECIDING','WAIT'].includes(final.signal.uiState));
  assert.ok(Array.isArray(final.signal.aPlus?.hardVetoes));
  assert.ok(final.signal.aPlus.hardVetoes.some(veto =>
    ['range-no-meio-sem-borda','breakout-sem-confirmação','vela-estendida-exaustão','histórico-contexto-insuficiente'].includes(veto)
  ));
  assert.notEqual(firstFinal.signal.uiState, 'ENTER_BUY');
  assert.notEqual(firstFinal.signal.uiState, 'ENTER_SELL');
});

test('regime gate is additive and does not change approved thresholds', async () => {
  const { ANALYST_THRESHOLDS } = await import('../src/core/analysis.js');
  assert.equal(ANALYST_THRESHOLDS.possibleScore, 44);
  assert.equal(ANALYST_THRESHOLDS.confirmScore, 58);
  assert.equal(ANALYST_THRESHOLDS.candleStrength, 62);
  assert.equal(ANALYST_THRESHOLDS.rejectionStrength, 50);
});
