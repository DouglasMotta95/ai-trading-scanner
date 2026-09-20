import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { strongSelectedMarketMismatch } from '../src/core/feed-focus-guard.js';

await import('../src/core/operation-time-sync.js');
const sync = globalThis.__ATS_OPERATION_TIME_SYNC__;
const NOW = Date.UTC(2026, 8, 20, 17, 10, 0);

function timingState({
  mode = 'M1',
  visibleTf = null,
  expiration = '60s',
  clockTf = 'M1',
  seconds = 42
} = {}) {
  return {
    asset: 'XAU/USD (OTC)',
    analystPreferences: { operatingTimeframe: mode },
    platformControls: {
      observed: {
        timeframe: visibleTf,
        expiration,
        observedAt: {
          timeframe: visibleTf ? NOW : 0,
          expiration: NOW
        }
      },
      timeframeCheckedAt: visibleTf ? NOW : 0,
      expirationCheckedAt: NOW
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

test('14977: exact M1 candle clock confirms candle period when compact UI does not expose a separate timeframe control', () => {
  const result = sync.read(timingState({ visibleTf: null }), NOW + 400);
  assert.equal(result.ready, true);
  assert.equal(result.timeframeReady, true);
  assert.equal(result.timeframeAuthority, 'exact-candle-clock');
  assert.equal(result.clockTimeframe, 'M1');
  assert.equal(result.expirationReady, true);
});

test('14977: a fresh contradictory visible timeframe still blocks the exact clock fallback', () => {
  const result = sync.read(timingState({ visibleTf: 'M5' }), NOW + 400);
  assert.equal(result.ready, false);
  assert.equal(result.timeframeReady, false);
  assert.match(result.reason, /Período da vela fora de sincronia/);
});

test('14977: expiration 5 seconds blocks M1 until CasaTrade is really changed to 60 seconds', () => {
  const bad = sync.read(timingState({ expiration: '5s' }), NOW + 400);
  assert.equal(bad.ready, false);
  assert.equal(bad.expirationReady, false);
  assert.match(bad.reason, /Expiração fora de sincronia/);

  const good = sync.read(timingState({ expiration: '60s' }), NOW + 400);
  assert.equal(good.ready, true);
});

test('14977: strong fresh selected NZD feed contradicting old EUR focus is detected immediately', () => {
  const mismatch = strongSelectedMarketMismatch({
    focusAsset: 'EUR/USD (OTC)',
    now: NOW,
    candidates: [
      {
        asset: 'NZD/USD (OTC)',
        selected: true,
        confidence: 90,
        observedAt: NOW - 120,
        price: 0.54931
      },
      {
        asset: 'EUR/USD (OTC)',
        selected: false,
        confidence: 96,
        observedAt: NOW - 80,
        price: 1.14821
      }
    ]
  });
  assert.equal(mismatch?.asset, 'NZD/USD (OTC)');
  assert.equal(mismatch?.price, 0.54931);
});

test('14977: weak or stale selected feed cannot steal focus', () => {
  assert.equal(strongSelectedMarketMismatch({
    focusAsset: 'EUR/USD (OTC)',
    now: NOW,
    candidates: [{ asset: 'NZD/USD (OTC)', selected: true, confidence: 60, observedAt: NOW - 100, price: .549 }]
  }), null);
  assert.equal(strongSelectedMarketMismatch({
    focusAsset: 'EUR/USD (OTC)',
    now: NOW,
    candidates: [{ asset: 'NZD/USD (OTC)', selected: true, confidence: 95, observedAt: NOW - 8000, price: .549 }]
  }), null);
});

test('14977: runtime recovery forces asset, expiration, platform controls and candle clock readers', () => {
  const control = fs.readFileSync(new URL('../src/background-control.js', import.meta.url), 'utf8');
  assert.match(control, /__ATS_FORCE_FOCUSED_ASSET_SCAN__/);
  assert.match(control, /__ATS_FORCE_EXPIRATION_SCAN__/);
  assert.match(control, /__ATS_FORCE_PLATFORM_CONTROL_SCAN__/);
  assert.match(control, /__ATS_FORCE_MARKET_CLOCK_SCAN__/);
  assert.match(control, /readAndCommitDirectExpiration\(tabId\)/);
});

test('14977: UI shell shows synchronizing until operation-time sync is ready', () => {
  const shell = fs.readFileSync(new URL('../src/sidepanel/ui-shell-v2.js', import.meta.url), 'utf8');
  assert.match(shell, /CONECTADO — SINCRONIZANDO/);
  assert.match(shell, /operationSync\?\.ready === true/);
  assert.match(shell, /CONECTADO — ANALISANDO SINAL/);
});

test('14977: exact clock can arrive from a trusted sibling frame instead of requiring focus.frameHost equality', () => {
  const session = fs.readFileSync(new URL('../src/background-market-session.js', import.meta.url), 'utf8');
  const start = session.indexOf('export async function applyClock');
  const end = session.indexOf('\nexport async function applyFeed', start);
  const block = session.slice(start, end);
  assert.doesNotMatch(block, /clean\(focus\.frameHost\).*info\.frameHost/);
  assert.match(block, /sameMarket\(focus\.asset, asset\)/);
});

test('14977: embedded CasaTrade frames are allowed to publish platform controls', () => {
  const observer = fs.readFileSync(new URL('../src/content/casatrade-ui-observer-v2.js', import.meta.url), 'utf8');
  assert.doesNotMatch(observer, /window !== window\.top/);
});
