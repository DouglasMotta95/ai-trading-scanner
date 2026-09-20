import test from 'node:test';
import assert from 'node:assert/strict';
import { assessEntryEvidence } from '../src/core/entry-evidence.js';

function base(overrides = {}) {
  return {
    regime: { type: 'range' },
    analytics: {
      buyPower: 60,
      sellPower: 30,
      currentStrength: 65,
      continuationDirection: 'BUY',
      continuationScore: 70,
      momentumDirection: 'BUY',
      momentumScore: 60,
      rejectionDirection: null,
      rejectionStrength: 0,
      strongBreakout: false,
      breakoutDirection: null,
      breakoutDistanceRatio: 0,
      exhaustionRisk: false,
      overextendedImpulse: false,
      ...overrides
    }
  };
}

test('range regime only allows rejection or confirmed breakout quality',()=>{
  const momentumOnly = assessEntryEvidence(base(), 'BUY');
  assert.equal(momentumOnly.qualifies, false);
  assert.equal(momentumOnly.blocker, 'range-needs-rejection-or-breakout');

  const rejection = assessEntryEvidence(base({
    rejectionDirection: 'BUY',
    rejectionStrength: 55
  }), 'BUY');
  assert.equal(rejection.qualifies, true);
  assert.equal(rejection.setup, 'rejeição no range');

  const breakout = assessEntryEvidence(base({
    strongBreakout: true,
    breakoutDirection: 'BUY',
    breakoutDistanceRatio: .22
  }), 'BUY');
  assert.equal(breakout.qualifies, true);
  assert.equal(breakout.setup, 'rompimento confirmado no range');
});
