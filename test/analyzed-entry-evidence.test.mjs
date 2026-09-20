import test from 'node:test';
import assert from 'node:assert/strict';
import { assessEntryEvidence } from '../src/core/entry-evidence.js';

function signal(overrides = {}) {
  return {
    analysisScore: 45,
    regime: { type: 'uptrend' },
    analytics: {
      buyPower: 51,
      sellPower: 32,
      currentStrength: 54,
      rejectionDirection: null,
      rejectionStrength: 0,
      continuationDirection: 'BUY',
      continuationScore: 56,
      momentumDirection: 'BUY',
      momentumScore: 47,
      strongBreakout: false,
      breakoutDirection: null,
      breakoutDistanceRatio: 0,
      exhaustionRisk: false,
      overextendedImpulse: false,
      ...overrides
    }
  };
}

test('an analyzed aligned setup can pass evidence even when legacy score is below old 52 duplicate gate', () => {
  const result = assessEntryEvidence(signal(), 'BUY');
  assert.equal(result.qualifies, true);
  assert.equal(result.setup, 'continuação');
  assert.ok(result.factors.includes('continuação'));
  assert.ok(result.factors.includes('momentum'));
});

test('directional power alone never becomes an entry', () => {
  const result = assessEntryEvidence(signal({
    buyPower: 65,
    currentStrength: 30,
    continuationDirection: null,
    continuationScore: 0,
    momentumDirection: null,
    momentumScore: 0
  }), 'BUY');
  assert.equal(result.qualifies, false);
});

test('counter-trend evidence is blocked instead of generating a random signal', () => {
  const s = signal();
  s.regime = { type: 'downtrend' };
  const result = assessEntryEvidence(s, 'BUY');
  assert.equal(result.qualifies, false);
  assert.equal(result.blocker, 'counter-trend');
});

test('exhausted impulse stays blocked unless there is real directional rejection', () => {
  const blocked = assessEntryEvidence(signal({ exhaustionRisk: true }), 'BUY');
  assert.equal(blocked.qualifies, false);
  assert.equal(blocked.blocker, 'exhaustion-risk');

  const protectedByRejection = assessEntryEvidence(signal({
    exhaustionRisk: true,
    rejectionDirection: 'BUY',
    rejectionStrength: 52
  }), 'BUY');
  assert.equal(protectedByRejection.qualifies, true);
  assert.equal(protectedByRejection.setup, 'rejeição');
});
