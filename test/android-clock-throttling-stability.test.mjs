import test from 'node:test';
import assert from 'node:assert/strict';

await import('../src/core/operation-time-sync.js');
await import('../src/core/countdown-authority.js');

const sync = globalThis.__ATS_OPERATION_TIME_SYNC__;
const authority = globalThis.__ATS_COUNTDOWN_AUTHORITY__;
const NOW = Date.UTC(2026, 8, 20, 18, 0, 0);

function state(clockAgeMs) {
  return {
    asset: 'EUR/USD (OTC)',
    analystPreferences: { operatingTimeframe: 'M1' },
    platformControls: {
      observed: { timeframe: 'M1', expiration: '60s', observedAt: { timeframe: NOW, expiration: NOW } },
      timeframeCheckedAt: NOW,
      expirationCheckedAt: NOW
    },
    diagnostics: {
      focusedAsset: { asset:'EUR/USD (OTC)', reliable:true, chartScoped:true, trustedChartFrame:true },
      marketClock: {
        asset:'EUR/USD (OTC)', timeframe:'M1', secondsRemaining:31,
        available:true, verified:true, role:'candle-close',
        source:'trader-dom-countdown', at: NOW - clockAgeMs
      }
    }
  };
}

test('verified CasaTrade clock remains synchronized across a 6 second Android observation gap', () => {
  const s = state(6000);
  assert.equal(sync.read(s, NOW).ready, true);
  assert.equal(authority.readAuthoritativeCountdown(s, NOW).ready, true);
});

test('verified CasaTrade clock still expires after the mobile tolerance window', () => {
  const s = state(8500);
  assert.equal(sync.read(s, NOW).clockReady, false);
  assert.equal(authority.readAuthoritativeCountdown(s, NOW).ready, false);
});
