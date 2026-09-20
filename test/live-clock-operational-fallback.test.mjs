import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');

await import('../src/core/countdown-authority.js');
const authority = globalThis.__ATS_COUNTDOWN_AUTHORITY__;
const NOW = Date.UTC(2026, 8, 20, 14, 5, 0);

function clockState(clock) {
  return {
    asset: 'EUR/USD (OTC)',
    analysisTimeframe: 'M5',
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

test('fallback clock is rejected and exact CasaTrade clock alone authorizes visible timing',()=>{
  const fallback = authority.readAuthoritativeCountdown(clockState({
    asset: 'EUR/USD (OTC)',
    timeframe: 'M5',
    secondsRemaining: 180,
    available: true,
    verified: false,
    operational: true,
    role: 'candle-close',
    source: 'platform-cycle-derived',
    at: NOW
  }), NOW + 400);
  assert.equal(fallback.ready, false);
  assert.equal(fallback.secondsRemaining, null);

  const exact = authority.readAuthoritativeCountdown(clockState({
    asset: 'EUR/USD (OTC)',
    timeframe: 'M5',
    secondsRemaining: 180,
    available: true,
    verified: true,
    role: 'candle-close',
    source: 'network-server-cycle',
    at: NOW
  }), NOW + 400);
  assert.equal(exact.ready, true);
  assert.equal(exact.secondsRemaining, 180);
});

test('partial OHLC is labeled as unreliable instead of fabricated',()=>{
  const session=read('src/background-market-session.js');
  assert.match(session,/openReliable: false/);
  assert.match(session,/rangeReliable: false/);
});
