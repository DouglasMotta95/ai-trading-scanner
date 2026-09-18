import test from 'node:test';
import assert from 'node:assert/strict';
import { fastLiveDecision, resetFastLiveDecision } from '../src/core/live-fast-decision.js';

function base(overrides = {}) {
  return {
    state: 'WAIT', uiState: 'BUILDING_PATTERN', analysisDirection: 'SELL',
    score: 54, analysisScore: 54, secondsRemaining: 40,
    analytics: { sellPower: 57, buyPower: 43, momentumDirection: 'SELL', momentumScore: 48 },
    ...overrides
  };
}

test('shows POSSIBLE immediately instead of hiding in BUILDING_PATTERN', () => {
  resetFastLiveDecision();
  const r = fastLiveDecision(base(), { asset: 'AUD/CAD (OTC)', timeframe: 'M1', serverTime: 100000 });
  assert.equal(r.uiState, 'POSSIBLE_SELL');
  assert.equal(r.direction, 'SELL');
});

test('confirms ENTER on two strong observations inside final 10 seconds', () => {
  resetFastLiveDecision();
  const signal = base({ score: 64, analysisScore: 64, secondsRemaining: 9 });
  const first = fastLiveDecision(signal, { asset: 'AUD/CAD (OTC)', timeframe: 'M1', serverTime: 100000 });
  const second = fastLiveDecision(signal, { asset: 'AUD/CAD (OTC)', timeframe: 'M1', serverTime: 101000 });
  assert.equal(first.uiState, 'POSSIBLE_SELL');
  assert.equal(second.uiState, 'ENTER_SELL');
  assert.equal(second.state, 'CONFIRM');
});

test('finishes candle with AGUARDAR when setup never confirms', () => {
  resetFastLiveDecision();
  const r = fastLiveDecision(base({ secondsRemaining: 3 }), { asset: 'AUD/CAD (OTC)', timeframe: 'M1', serverTime: 100000 });
  assert.equal(r.uiState, 'WAIT');
  assert.equal(r.state, 'NO_TRADE');
});
