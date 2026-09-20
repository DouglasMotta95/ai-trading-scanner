import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MARKET_SWITCH_TIMING,
  protocolTakeoverAllowed,
  realSelectionAgeMs,
  shouldRefreshVisualSelectionLock
} from '../src/core/market-switch-timing.js';

const NOW = 10_000;

test('passive chart-header heartbeat is not treated as a fresh user-selection lock', () => {
  const age = realSelectionAgeMs({
    now: NOW,
    focus: {
      asset: 'EUR/USD (OTC)',
      at: NOW - 100,
      stableSince: NOW - 20_000,
      source: 'visible-chart-header',
      interactionHint: false
    },
    selectionLock: { asset: 'EUR/USD (OTC)', at: NOW - 100, source: 'protocol-selected-fallback' }
  });
  assert.equal(age, Infinity);
  assert.equal(shouldRefreshVisualSelectionLock({ userSelected: false, source: 'visible-chart-header' }), false);
});

test('real user selection remains protected for the 1.2 second switch guard', () => {
  assert.equal(realSelectionAgeMs({
    now: NOW,
    focus: {
      interactionHint: true,
      interactionAt: NOW - 900,
      source: 'user-selected-transition'
    },
    selectionLock: { asset: 'EUR/USD (OTC)', at: NOW - 900, source: 'user-selection' }
  }), 900);
  assert.equal(protocolTakeoverAllowed({
    oldFocusAgeMs: 900,
    recentSelectionAgeMs: 900,
    incomingExplicit: true,
    incomingStable: true
  }), false);
});

test('stable explicit protocol can replace stale passive focus without waiting on repeated old.at heartbeats', () => {
  const age = realSelectionAgeMs({
    now: NOW,
    focus: {
      asset: 'EUR/USD (OTC)',
      at: NOW - 100,
      source: 'visible-chart-header',
      interactionHint: false
    },
    selectionLock: null
  });
  assert.equal(age, Infinity);
  assert.equal(protocolTakeoverAllowed({
    oldFocusAgeMs: age,
    recentSelectionAgeMs: age,
    incomingExplicit: true,
    incomingStable: true
  }), true);
  assert.equal(MARKET_SWITCH_TIMING.staleFocusProtectionMs, 1200);
});
