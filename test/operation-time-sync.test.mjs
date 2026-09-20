import test from 'node:test';
import assert from 'node:assert/strict';

await import('../src/core/operation-time-sync.js');
const sync = globalThis.__ATS_OPERATION_TIME_SYNC__;

const NOW = Date.UTC(2026, 8, 20, 16, 30, 0);

function state({
  mode = 'M1',
  visibleTf = mode,
  expiration = mode === 'M5' ? '300s' : '60s',
  clockTf = mode,
  seconds = mode === 'M5' ? 190 : 41,
  chartRange = null
} = {}) {
  return {
    asset: 'EUR/USD (OTC)',
    analystPreferences: { operatingTimeframe: mode },
    platformControls: {
      observed: {
        timeframe: visibleTf,
        expiration,
        chartRange,
        observedAt: { timeframe: NOW, expiration: NOW }
      },
      timeframeCheckedAt: NOW,
      expirationCheckedAt: NOW
    },
    diagnostics: {
      focusedAsset: {
        asset: 'EUR/USD (OTC)',
        reliable: true,
        chartScoped: true,
        trustedChartFrame: true
      },
      marketClock: {
        asset: 'EUR/USD (OTC)',
        timeframe: clockTf,
        secondsRemaining: seconds,
        available: true,
        verified: true,
        role: 'candle-close',
        source: 'trader-dom-countdown',
        at: NOW
      }
    }
  };
}

test('M1 only becomes ready when candle period, 60s expiration and M1 countdown agree', () => {
  const result = sync.read(state({ mode: 'M1', seconds: 41 }), NOW + 500);
  assert.equal(result.ready, true);
  assert.equal(result.desiredTimeframe, 'M1');
  assert.equal(result.visibleTimeframe, 'M1');
  assert.equal(result.requiredExpiration, '60s');
  assert.equal(result.secondsRemaining, 41);
  assert.equal(result.contextTimeframe, 'M5');
});

test('M5 uses 300s expiration and a real M5 countdown up to 300 seconds', () => {
  const result = sync.read(state({ mode: 'M5', seconds: 190 }), NOW + 500);
  assert.equal(result.ready, true);
  assert.equal(result.desiredTimeframe, 'M5');
  assert.equal(result.visibleTimeframe, 'M5');
  assert.equal(result.clockTimeframe, 'M5');
  assert.equal(result.requiredExpiration, '300s');
  assert.equal(result.secondsRemaining, 190);
  assert.equal(result.durationSeconds, 300);
  assert.equal(result.contextTimeframe, 'M15');
});

test('chart viewing range is not operational timeframe authority', () => {
  const result = sync.read(state({ mode: 'M1', visibleTf: 'M1', chartRange: 'M5', seconds: 30 }), NOW + 500);
  assert.equal(result.ready, true);
  assert.equal(result.desiredTimeframe, 'M1');
  assert.equal(result.visibleTimeframe, 'M1');
});

test('M5 is blocked if expiration is still 60 seconds', () => {
  const result = sync.read(state({ mode: 'M5', expiration: '60s', seconds: 190 }), NOW + 500);
  assert.equal(result.ready, false);
  assert.equal(result.timeframeReady, true);
  assert.equal(result.expirationReady, false);
  assert.match(result.reason, /Expiração fora de sincronia/);
});

test('M5 is blocked if countdown belongs to M1 even when visible chart says M5', () => {
  const result = sync.read(state({ mode: 'M5', clockTf: 'M1', seconds: 20 }), NOW + 500);
  assert.equal(result.ready, false);
  assert.equal(result.timeframeReady, true);
  assert.equal(result.expirationReady, true);
  assert.equal(result.clockReady, false);
  assert.match(result.reason, /fechamento real da vela M5/);
});

test('changing scanner preference to M5 updates both operating timeframe and required expiration', () => {
  const prefs = sync.preferencesFromMessage(
    { operatingTimeframe: 'M1', preferredExpiration: '60s', geminiEnabled: true },
    { operatingTimeframe: 'M5', preferredExpiration: '300s', geminiEnabled: true }
  );
  assert.equal(prefs.mode, 'A_PLUS');
  assert.equal(prefs.operatingTimeframe, 'M5');
  assert.equal(prefs.preferredExpiration, '300s');
});
