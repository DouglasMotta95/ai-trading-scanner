import test from 'node:test';
import assert from 'node:assert/strict';
import { fastLiveDecision, resetFastLiveDecision } from '../src/core/live-fast-decision.js';

function base(overrides = {}) {
  return {
    state: 'WAIT', uiState: 'BUILDING_PATTERN', analysisDirection: 'SELL',
    score: 64, analysisScore: 64, secondsRemaining: 40,
    analytics: {
      sellPower: 62,
      buyPower: 38,
      momentumDirection: 'SELL',
      momentumScore: 52,
      continuationDirection: 'SELL',
      continuationScore: 64
    },
    ...overrides
  };
}

test('shows only a high-confidence POSSIBLE inside the 30 second preparation window', () => {
  resetFastLiveDecision();
  const r = fastLiveDecision(base({ secondsRemaining: 24 }), { asset: 'AUD/CAD (OTC)', timeframe: 'M1', serverTime: 100000 });
  assert.equal(r.uiState, 'POSSIBLE_SELL');
  assert.equal(r.direction, 'SELL');
  assert.match(r.reason, /ALTA CONFIANÇA/i);
});

test('confirms ENTER on two high-confidence observations inside final window', () => {
  resetFastLiveDecision();
  const signal = base({ score: 74, analysisScore: 74, secondsRemaining: 4 });
  const first = fastLiveDecision(signal, { asset: 'AUD/CAD (OTC)', timeframe: 'M1', serverTime: 100000 });
  const second = fastLiveDecision(signal, { asset: 'AUD/CAD (OTC)', timeframe: 'M1', serverTime: 101000 });
  assert.equal(first.uiState, 'POSSIBLE_SELL');
  assert.equal(second.uiState, 'ENTER_SELL');
  assert.equal(second.state, 'CONFIRM');
  assert.match(second.reason, /ALTA CONFIANÇA/i);
});

test('keeps high-confidence POSSIBLE visible while the second final hit is pending', () => {
  resetFastLiveDecision();
  const r = fastLiveDecision(base({ score: 74, analysisScore: 74, secondsRemaining: 4 }), { asset: 'AUD/CAD (OTC)', timeframe: 'M1', serverTime: 100000 });
  assert.equal(r.uiState, 'POSSIBLE_SELL');
  assert.equal(r.state, 'WATCH');
  assert.equal(r.direction, 'SELL');
});

test('keeps M1 as POSSIBLE before the 5 second final window', () => {
  resetFastLiveDecision();
  const signal = base({ score: 74, analysisScore: 74, secondsRemaining: 6 });
  const first = fastLiveDecision(signal, { asset: 'AUD/CAD (OTC)', timeframe: 'M1', serverTime: 150000 });
  const second = fastLiveDecision(signal, { asset: 'AUD/CAD (OTC)', timeframe: 'M1', serverTime: 151000 });
  assert.equal(first.uiState, 'POSSIBLE_SELL');
  assert.equal(second.uiState, 'POSSIBLE_SELL');
  assert.notEqual(second.state, 'CONFIRM');
});

test('confirms M5 only inside the 8 second final window', () => {
  resetFastLiveDecision();
  const signal = base({ score: 74, analysisScore: 74, secondsRemaining: 7 });
  const first = fastLiveDecision(signal, { asset: 'AUD/CAD (OTC)', timeframe: 'M5', operationMode: 'M5', serverTime: 160000 });
  const second = fastLiveDecision(signal, { asset: 'AUD/CAD (OTC)', timeframe: 'M5', operationMode: 'M5', serverTime: 161000 });
  assert.equal(first.uiState, 'POSSIBLE_SELL');
  assert.equal(second.uiState, 'ENTER_SELL');
  assert.equal(second.state, 'CONFIRM');
});

test('simple confirmation rejects score and power when independent directional evidence is missing', () => {
  resetFastLiveDecision();
  const signal = base({
    score: 74,
    analysisScore: 74,
    secondsRemaining: 9,
    analytics: {
      sellPower: 62,
      buyPower: 38,
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
  assert.equal(first.uiState, 'WAIT');
  assert.equal(second.uiState, 'WAIT');
  assert.notEqual(second.state, 'CONFIRM');
});

test('strict confirmation rejects opposite-direction setup evidence', () => {
  resetFastLiveDecision();
  const signal = base({
    score: 74,
    analysisScore: 74,
    secondsRemaining: 9,
    analytics: {
      sellPower: 62,
      buyPower: 38,
      currentStrength: 20,
      momentumDirection: 'BUY',
      momentumScore: 99,
      continuationDirection: 'BUY',
      continuationScore: 99,
      rejectionDirection: 'BUY',
      rejectionStrength: 99
    }
  });
  const first = fastLiveDecision(signal, { asset: 'AUD/CAD (OTC)', timeframe: 'M1', serverTime: 300000, confirmationMode: 'EXIGENTE' });
  const second = fastLiveDecision(signal, { asset: 'AUD/CAD (OTC)', timeframe: 'M1', serverTime: 301000, confirmationMode: 'EXIGENTE' });
  assert.equal(first.uiState, 'WAIT');
  assert.equal(second.uiState, 'WAIT');
  assert.notEqual(second.state, 'CONFIRM');
});
