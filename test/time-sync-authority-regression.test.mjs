import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

await import('../src/core/operation-time-sync.js');
const sync = globalThis.__ATS_OPERATION_TIME_SYNC__;
const NOW = Date.UTC(2026, 8, 20, 17, 30, 0);

function baseState() {
  return {
    asset: 'XAU/USD (OTC)',
    analystPreferences: { operatingTimeframe: 'M1' },
    platformControls: {
      observed: {
        timeframe: null,
        expiration: null,
        observedAt: { timeframe: 0, expiration: 0 }
      },
      liveAuthority: false
    },
    diagnostics: {
      focusedAsset: {
        asset: 'XAU/USD (OTC)',
        reliable: true,
        chartScoped: true,
        trustedChartFrame: true
      },
      marketClock: {
        asset: 'XAU/USD (OTC)',
        timeframe: 'M1',
        secondsRemaining: 33,
        available: true,
        verified: true,
        role: 'candle-close',
        source: 'trader-dom-countdown',
        at: NOW
      }
    }
  };
}

test('direct expiration probe is authoritative even when platformControls.observed missed the value', () => {
  const state = baseState();
  state.diagnostics.expirationGuard = {
    actual: '60s',
    source: 'background-direct-expiration-probe',
    at: NOW
  };
  const exp = sync.authoritativeExpiration(state);
  assert.equal(exp.value, '60s');
  assert.equal(exp.source, 'background-direct-expiration-probe');

  const result = sync.read(state, NOW + 500);
  assert.equal(result.timeframeReady, true);
  assert.equal(result.expirationReady, true);
  assert.equal(result.clockReady, true);
  assert.equal(result.ready, true);
});

test('configured local target expiration is never accepted as real CasaTrade evidence', () => {
  const state = baseState();
  state.expiration = '60s';
  state.targetExpiration = '60s';
  const exp = sync.authoritativeExpiration(state);
  assert.equal(exp.value, null);
  const result = sync.read(state, NOW + 500);
  assert.equal(result.expirationReady, false);
  assert.equal(result.ready, false);
});

test('live platform-control expiration remains preferred authority', () => {
  const state = baseState();
  state.platformControls = {
    observed: {
      timeframe: null,
      expiration: '60s',
      observedAt: { timeframe: 0, expiration: NOW }
    },
    expirationCheckedAt: NOW,
    liveAuthority: true,
    source: 'casatrade-expiration-probe-v4'
  };
  state.diagnostics.expirationGuard = {
    actual: '5s',
    source: 'background-direct-expiration-probe',
    at: NOW - 1000
  };
  const exp = sync.authoritativeExpiration(state);
  assert.equal(exp.value, '60s');
  assert.equal(exp.source, 'casatrade-expiration-probe-v4');
});

test('panel exposes individual synchronization flags instead of generic endless syncing', () => {
  const app = fs.readFileSync(new URL('../src/sidepanel/app-v2.js', import.meta.url), 'utf8');
  assert.match(app, /ATIVO/);
  assert.match(app, /VELA/);
  assert.match(app, /EXP/);
  assert.match(app, /CLOCK/);
  assert.match(app, /operationSync\?\.expirationReady/);
});
