import test from 'node:test';
import assert from 'node:assert/strict';
import {
  activeAssetCandles,
  activeAssetTransitionNeeded,
  clearStaleAssetDecision
} from '../src/core/active-asset-transition.js';

const focus = asset => ({
  asset, reliable: true, chartScoped: true, trustedChartFrame: true
});

test('detects stale signal and candle after the user changes selected asset', () => {
  const staleSignal = {
    asset: 'USD/XOF (OTC)',
    signal: { asset: 'USD/XOF (OTC)', analysisScore: 81 },
    currentCandle: { asset: 'USD/XOF (OTC)', close: 1.1 },
    diagnostics: { focusedAsset: focus('EUR/USD (OTC)') }
  };
  staleSignal.asset = 'EUR/USD (OTC)';
  assert.equal(activeAssetTransitionNeeded(staleSignal), true);
});

test('clears old signal, decision and cycle but preserves the old candle identity until fresh data arrives', () => {
  const state = {
    asset: 'EUR/USD (OTC)',
    signal: { asset: 'USD/XOF (OTC)', analysisScore: 81 },
    professionalDecision: { uiState: 'ENTER_BUY', actionable: true },
    decisionCycle: { key: 'old-cycle', locked: 'ENTER' },
    candidateBlockerTrace: [{ reason: 'old asset' }],
    currentCandle: { asset: 'USD/XOF (OTC)', close: 1.1 },
    diagnostics: { focusedAsset: focus('EUR/USD (OTC)') }
  };
  const reset = clearStaleAssetDecision(state, 1234);
  assert.equal(reset.signal, null);
  assert.equal(reset.professionalDecision, null);
  assert.equal(reset.decisionCycle, null);
  assert.deepEqual(reset.candidateBlockerTrace, []);
  assert.equal(reset.currentCandle.asset, 'USD/XOF (OTC)', 'old tag remains until fresh data arrives');
  assert.equal(reset.diagnostics.activeAssetTransition.to, 'EUR/USD (OTC)');
  assert.equal(clearStaleAssetDecision(reset, 5678), reset, 'does not repeat the reset each poll');
});

test('prefers history keyed to the selected asset even while currentCandle still carries old identity', () => {
  const current = { time: 10, open: 1, high: 2, low: .5, close: 1.5 };
  const rows = activeAssetCandles({
    asset: 'EUR/USD (OTC)',
    signal: null,
    currentCandle: { asset: 'USD/XOF (OTC)' },
    candles: [{ time: 1, open: 1, high: 1, low: 1, close: 1 }],
    marketHistory: { 'EUR/USD (OTC)': [current] }
  }, 'EUR/USD (OTC)');
  assert.deepEqual(rows, [current]);
});

test('refuses to relabel unkeyed candles from the previous asset as the new asset', () => {
  const rows = activeAssetCandles({
    asset: 'EUR/USD (OTC)',
    signal: null,
    currentCandle: { asset: 'USD/XOF (OTC)' },
    candles: [{ time: 1, open: 1, high: 1, low: 1, close: 1 }],
    marketHistory: {}
  }, 'EUR/USD (OTC)');
  assert.deepEqual(rows, []);
});
