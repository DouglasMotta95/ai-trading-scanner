import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canShowFinalEntry,
  canShowTechnicalAnalysis,
  selectTechnicalScore
} from '../src/core/decision-display.js';

test('a zero score from the blocked decision cannot hide a non-zero technical-engine score', () => {
  assert.equal(selectTechnicalScore({
    analysisScore: 0,
    technicalScore: 78,
    decisionScore: 0,
    confidenceScore: 67
  }), 78);
  assert.equal(selectTechnicalScore({
    analysisScore: null,
    technicalScore: null,
    decisionScore: 0,
    confidenceScore: 67
  }), 67);
  assert.equal(selectTechnicalScore({
    analysisScore: 0,
    technicalScore: 0,
    decisionScore: 0,
    confidenceScore: 0
  }), 0);
});

test('technical analysis can be displayed when the active market and real candles are valid even if timing is blocked', () => {
  assert.equal(canShowTechnicalAnalysis({ marketReady: true, timingReady: false }), true);
  assert.equal(canShowTechnicalAnalysis({ marketReady: false, timingReady: true }), false);
});

test('a visible technical score never bypasses final entry timing and expiration checks', () => {
  const ready = {
    marketReady: true, timingReady: true, decisionTimeReady: true,
    expirationReady: true, actionable: true
  };
  assert.equal(canShowFinalEntry(ready), true);
  assert.equal(canShowFinalEntry({ ...ready, timingReady: false }), false);
  assert.equal(canShowFinalEntry({ ...ready, expirationReady: false }), false);
  assert.equal(canShowFinalEntry({ ...ready, decisionTimeReady: false }), false);
  assert.equal(canShowFinalEntry({ ...ready, actionable: false }), false);
  assert.equal(canShowFinalEntry({ ...ready, marketReady: false }), false);
});
