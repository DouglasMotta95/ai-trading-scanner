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

test('shows POSSIBLE inside the 30 second preparation window', () => {
  resetFastLiveDecision();
  const r = fastLiveDecision(base({ secondsRemaining: 24 }), { asset: 'AUD/CAD (OTC)', timeframe: 'M1', serverTime: 100000 });
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

test('keeps POSSIBLE visible in the final window while confirmation is still pending', () => {
  resetFastLiveDecision();
  const r = fastLiveDecision(base({ secondsRemaining: 3 }), { asset: 'AUD/CAD (OTC)', timeframe: 'M1', serverTime: 100000 });
  assert.equal(r.uiState, 'POSSIBLE_SELL');
  assert.equal(r.state, 'WATCH');
  assert.equal(r.direction, 'SELL');
  assert.match(r.reason, /POSSÍVEL VENDA/i);
});


test('simple confirmation ignores strong evidence from the opposite direction', () => {
  resetFastLiveDecision();
  const signal = base({
    score: 64,
    analysisScore: 64,
    secondsRemaining: 9,
    analytics: {
      sellPower: 57,
      buyPower: 43,
      momentumDirection: 'BUY',
      momentumScore: 99,
      continuationDirection: 'BUY',
      continuationScore: 99,
      rejectionDirection: 'BUY',
      rejectionStrength: 99
    }
  });
  const first = fastLiveDecision(signal, { asset: 'AUD/CAD (OTC)', timeframe: 'M1', serverTime: 200000, confirmationMode: 'SIMPLES' });
  const second = fastLiveDecision(signal, { asset: 'AUD/CAD (OTC)', timeframe: 'M1', serverTime: 201000, confirmationMode: 'SIMPLES' });
  assert.equal(first.uiState, 'POSSIBLE_SELL');
  assert.equal(second.uiState, 'POSSIBLE_SELL');
  assert.notEqual(second.state, 'CONFIRM');
});
