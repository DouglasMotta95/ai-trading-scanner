import test from 'node:test';
import assert from 'node:assert/strict';
import { confirmedMarket, shouldResetForFocusedAsset } from '../src/core/market-session-guard.js';

function state({ confirmedAsset = null, asset = null } = {}) {
  return {
    asset,
    diagnostics: {
      marketSession: {
        confirmedAsset
      }
    }
  };
}

test('same confirmed EUR/USD never becomes a market reset because a stale focus disagreed', () => {
  const current = state({ confirmedAsset: 'EUR/USD (OTC)', asset: 'EUR/USD (OTC)' });
  assert.equal(confirmedMarket(current), 'EUR/USD (OTC)');
  assert.equal(shouldResetForFocusedAsset(current, 'EUR/USD (OTC)'), false);
});

test('a genuinely different incoming market resets the confirmed EUR/USD session', () => {
  const current = state({ confirmedAsset: 'EUR/USD (OTC)', asset: 'EUR/USD (OTC)' });
  assert.equal(shouldResetForFocusedAsset(current, 'NZD/USD (OTC)'), true);
});

test('reset decision follows confirmed market even when old focus has already drifted', () => {
  const current = state({ confirmedAsset: 'EUR/USD (OTC)', asset: 'EUR/USD (OTC)' });
  assert.equal(shouldResetForFocusedAsset(current, 'NZD/USD (OTC)'), true);
  assert.equal(shouldResetForFocusedAsset(current, 'EUR/USD (OTC)'), false);
});

test('an unconfirmed bootstrap focus does not clear state as a market switch', () => {
  const current = state({ confirmedAsset: null, asset: null });
  assert.equal(confirmedMarket(current), '');
  assert.equal(shouldResetForFocusedAsset(current, 'EUR/USD (OTC)'), false);
});
