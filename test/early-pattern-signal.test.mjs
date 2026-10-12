import test from 'node:test';
import assert from 'node:assert/strict';
import {
  anticipationWindowSeconds,
  decisionQuality,
  qualifiesEarlyPattern
} from '../src/core/orchestrator.js';
import { getThresholds } from '../src/core/analysis.js';

const pattern = (direction, overrides = {}) => ({
  qualified: true,
  direction,
  score: 90,
  notStretched: true,
  roomToLevel: 0.8,
  ...overrides
});

const signal = (direction = 'BUY', overrides = {}) => ({
  state: 'WAIT',
  analysisScore: 52,
  direction: null,
  analysisDirection: direction,
  analytics: {
    buyPower: direction === 'BUY' ? 54 : 42,
    sellPower: direction === 'SELL' ? 54 : 42,
    momentumDirection: direction,
    momentumScore: 42,
    continuationDirection: null,
    continuationScore: 0,
    rejectionDirection: null,
    rejectionStrength: 0,
    currentStrength: 40,
    pullbackContinuation: pattern(direction),
    ...overrides
  }
});

test('qualifies a pattern early before generic final thresholds for BUY and SELL', () => {
  assert.equal(qualifiesEarlyPattern(signal('BUY'), 'BUY', 52), true);
  assert.equal(qualifiesEarlyPattern(signal('SELL'), 'SELL', 52), true);
});

test('blocks an early candidate when pattern is stretched, near a level, weak or below score floor', () => {
  assert.equal(qualifiesEarlyPattern(signal('BUY', {pullbackContinuation: pattern('BUY',{notStretched:false})}), 'BUY', 52), false);
  assert.equal(qualifiesEarlyPattern(signal('BUY', {pullbackContinuation: pattern('BUY',{roomToLevel:0.2})}), 'BUY', 52), false);
  assert.equal(qualifiesEarlyPattern(signal('BUY', {buyPower:51}), 'BUY', 52), false);
  assert.equal(qualifiesEarlyPattern(signal('BUY'), 'BUY', 44), false);
  assert.equal(qualifiesEarlyPattern(signal('BUY'), 'SELL', 52), false);
});

test('gives M1 and M5 distinct practical early alert windows', () => {
  assert.equal(anticipationWindowSeconds('M1'), 45);
  assert.equal(anticipationWindowSeconds('M5'), 120);
});

test('qualified pullback can pass final quality with a lower-but-bounded score and independent confirmation', () => {
  const s = signal('BUY', {
    buyPower: 56,
    momentumDirection: 'BUY',
    momentumScore: 42,
    pullbackContinuation: pattern('BUY')
  });
  s.analysisScore = 65;
  const result = decisionQuality(s, 'BUY', getThresholds('MEDIO'), 'SIMPLES');
  assert.equal(result.qualifies, true);
  assert.equal(result.commonReady, false, 'this should be the explicit pullback lane, not the generic 70/60 gate');
});

test('qualified pullback alone cannot bypass independent confirmation or score/power floors', () => {
  const s = signal('BUY', {
    buyPower: 56,
    momentumDirection: null,
    momentumScore: 0,
    continuationDirection: null,
    continuationScore: 0,
    rejectionDirection: null,
    rejectionStrength: 0,
    currentStrength: 20,
    pullbackContinuation: pattern('BUY')
  });
  s.analysisScore = 65;
  assert.equal(decisionQuality(s, 'BUY', getThresholds('MEDIO'), 'SIMPLES').qualifies, false);
  s.analytics.buyPower = 54;
  s.analytics.momentumDirection = 'BUY';
  s.analytics.momentumScore = 42;
  assert.equal(decisionQuality(s, 'BUY', getThresholds('MEDIO'), 'SIMPLES').qualifies, false);
});
