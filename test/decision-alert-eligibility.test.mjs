import test from 'node:test';
import assert from 'node:assert/strict';
import { explainDecisionAlertEligibility, qualifiedDecision } from '../src/core/signal-alert-qualification.js';

const pattern = direction => ({
  qualified: true, direction, score: 90, notStretched: true, roomToLevel: 0.8
});
const state = (overrides = {}) => ({
  scanner: 'scanning',
  connection: 'online',
  asset: 'USD/XOF (OTC)',
  professionalDecision: {
    uiState: 'POSSIBLE_BUY', direction: 'BUY', actionable: false,
    score: 80, cycleKey: 'USD/XOF (OTC)|M1|1000', timeframe: 'M1',
    actualExpiration: '60s', secondsRemaining: 40,
    timeReady: true, expirationReady: true,
    pullbackContinuation: pattern('BUY')
  },
  signal: { analytics: { pullbackContinuation: pattern('BUY') } },
  ...overrides
});

test('audit explains eligible anticipatory BUY signal and can build event', () => {
  const value = state();
  const explanation = explainDecisionAlertEligibility(value);
  assert.equal(explanation.eligible, true);
  assert.equal(explanation.stage, 'pre');
  assert.equal(qualifiedDecision(value)?.stage, 'pre');
  assert.equal(explanation.seconds, 40);
  assert.equal(explanation.alertWindow, 45);
});

test('audit gives the exact connection blocker instead of silently dropping the alert', () => {
  const value = state({ connection: 'offline' });
  const explanation = explainDecisionAlertEligibility(value);
  assert.equal(explanation.eligible, false);
  assert.match(explanation.reason, /conexão.*online/i);
  assert.equal(qualifiedDecision(value), null);
});

test('audit names the mismatch when M5 has a one-minute expiration', () => {
  const value = state({ professionalDecision: {
    ...state().professionalDecision, timeframe: 'M5', actualExpiration: '60s'
  }});
  const explanation = explainDecisionAlertEligibility(value);
  assert.equal(explanation.eligible, false);
  assert.match(explanation.reason, /incompatível com M5/i);
});

test('audit prevents final notification for AGUARDAR and reports why', () => {
  const value = state({ professionalDecision: {
    ...state().professionalDecision, uiState: 'WAIT', direction: null, secondsRemaining: 7
  }});
  const explanation = explainDecisionAlertEligibility(value);
  assert.equal(explanation.eligible, false);
  assert.match(explanation.reason, /A decisão não tem direção BUY/i);
});

test('audit explains missing exact clock and expired target cycle', () => {
  const base = state().professionalDecision;
  assert.match(explainDecisionAlertEligibility(state({ professionalDecision: { ...base, timeReady: false } })).reason, /relógio exato/i);
  assert.match(explainDecisionAlertEligibility(state({ professionalDecision: { ...base, secondsRemaining: 0 } })).reason, /countdown ausente/i);
});
