import test from 'node:test';
import assert from 'node:assert/strict';

await import('../src/core/countdown-authority.js');
const authority = globalThis.__ATS_COUNTDOWN_AUTHORITY__;

const NOW = Date.UTC(2026, 8, 20, 14, 0, 0);

function baseState(clock = {}) {
  return {
    asset: 'EUR/USD (OTC)',
    analysisTimeframe: 'M5',
    timeframe: 'M5',
    professionalDecision: { secondsRemaining: 233 },
    signal: { secondsRemaining: 233, timeframe: 'M5' },
    currentCandle: {
      time: NOW - 67_000,
      open: 1.1, high: 1.2, low: 1.0, close: 1.15
    },
    diagnostics: {
      focusedAsset: {
        asset: 'EUR/USD (OTC)',
        reliable: true,
        chartScoped: true,
        trustedChartFrame: true,
        at: NOW
      },
      marketClock: clock
    }
  };
}

test('verified real M5 CasaTrade countdown is accepted exactly', () => {
  const state = baseState({
    asset: 'EUR/USD (OTC)',
    timeframe: 'M5',
    secondsRemaining: 233,
    available: true,
    verified: true,
    role: 'candle-close',
    source: 'trader-dom-countdown',
    at: NOW
  });
  const result = authority.readAuthoritativeCountdown(state, NOW + 500);
  assert.deepEqual(result, {
    ready: true,
    secondsRemaining: 233,
    timeframe: 'M5',
    source: 'trader-dom-countdown'
  });
});

test('platform-cycle-derived countdown is rejected even if it carries 233 seconds', () => {
  const state = baseState({
    asset: 'EUR/USD (OTC)',
    timeframe: 'M5',
    secondsRemaining: 233,
    available: true,
    verified: false,
    operational: true,
    role: 'candle-close',
    source: 'platform-cycle-derived',
    at: NOW
  });
  const result = authority.readAuthoritativeCountdown(state, NOW + 500);
  assert.equal(result.ready, false);
  assert.equal(result.secondsRemaining, null);
});

test('signal, professionalDecision and candle timestamp cannot fabricate countdown when real clock is missing', () => {
  const state = baseState(null);
  state.diagnostics.marketClock = null;
  const result = authority.readAuthoritativeCountdown(state, NOW + 500);
  assert.equal(result.ready, false);
  assert.equal(result.secondsRemaining, null);
});

test('stale real countdown becomes pending instead of being locally decremented', () => {
  const state = baseState({
    asset: 'EUR/USD (OTC)',
    timeframe: 'M5',
    secondsRemaining: 233,
    available: true,
    verified: true,
    role: 'candle-close',
    source: 'network-server-cycle',
    at: NOW
  });
  const result = authority.readAuthoritativeCountdown(state, NOW + 8_500);
  assert.equal(result.ready, false);
  assert.equal(result.secondsRemaining, null);
});
