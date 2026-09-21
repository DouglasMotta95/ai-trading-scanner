import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { processSnapshot, resetOrchestrator } from '../src/core/orchestrator.js';

const read = path => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const minute = 60_000;

function bullishRows(bucket) {
  return [
    { time: bucket - 4 * minute, open: 1.00, high: 1.02, low: .99, close: 1.018, timeframe: 'M1' },
    { time: bucket - 3 * minute, open: 1.018, high: 1.04, low: 1.01, close: 1.038, timeframe: 'M1' },
    { time: bucket - 2 * minute, open: 1.038, high: 1.06, low: 1.03, close: 1.058, timeframe: 'M1' },
    { time: bucket - minute, open: 1.058, high: 1.08, low: 1.05, close: 1.078, timeframe: 'M1' },
    { time: bucket, open: 1.078, high: 1.115, low: 1.075, close: 1.11, timeframe: 'M1' }
  ];
}

function snapshotFrom(state, serverTime) {
  return {
    platformId: 'casatrade',
    platformName: 'CasaTrade',
    connection: 'online',
    asset: state.asset,
    price: state.price,
    timeframe: 'M1',
    analysisTimeframe: 'M1',
    expiration: '60s',
    targetExpiration: '60s',
    secondsRemaining: state.diagnostics.marketClock.secondsRemaining,
    serverTime,
    candles: state.candles,
    capabilities: { structuredQuotes: true, candles: true }
  };
}

test('processSnapshot has one runtime owner and acquisition modules never call it directly', () => {
  const entry = read('src/background-entry.js');
  const central = read('src/background.js');

  assert.match(entry, /import '.\/background\.js';/);
  assert.match(central, /Single owner of technical analysis/);
  assert.equal((central.match(/processSnapshot\(/g) || []).length, 1);

  for (const path of [
    'src/background-augment.js',
    'src/background-integrity.js',
    'src/background-market-session.js'
  ]) {
    const source = read(path);
    assert.doesNotMatch(source, /processSnapshot\(/, path);
    assert.doesNotMatch(source, /processSnapshot\s*,/, path);
    assert.doesNotMatch(source, /resetOrchestrator\(/, path);
  }
});

test('three burst data updates cannot reset confirmation between central analysis ticks', () => {
  resetOrchestrator();
  const bucket = Math.floor(1_704_000_000_000 / minute) * minute;

  // Three independent acquisition sources update the same shared state.
  // None of them runs processSnapshot().
  let shared = {
    connection: 'online',
    scanner: 'scanning',
    asset: 'EUR/USD (OTC)',
    price: 1.108,
    candles: bullishRows(bucket),
    diagnostics: {
      focusedAsset: {
        asset: 'EUR/USD (OTC)', reliable: true, chartScoped: true, trustedChartFrame: true,
        frameId: 7, frameHost: 'trade.casatraders.online', at: bucket + 50_000
      },
      marketClock: {
        asset: 'EUR/USD (OTC)', timeframe: 'M1', secondsRemaining: 9,
        verified: true, available: true, operational: true, role: 'candle-close',
        source: 'trader-dom-countdown', frameId: 7, frameHost: 'trade.casatraders.online',
        at: bucket + 50_000
      }
    }
  };

  shared = { ...shared, price: 1.109 }; // feed update
  shared = { ...shared, candles: bullishRows(bucket) }; // candle/history update
  shared = {
    ...shared,
    diagnostics: {
      ...shared.diagnostics,
      marketClock: { ...shared.diagnostics.marketClock, secondsRemaining: 9, at: bucket + 50_050 }
    }
  }; // clock update

  const first = processSnapshot(snapshotFrom(shared, bucket + 50_100), shared);
  const consolidatedAfterFirst = { ...shared, ...first };

  // Main loop cadence: second observation arrives 800 ms later, inside the
  // 2500 ms confirmation window, with no competing source calling the engine.
  const second = processSnapshot(snapshotFrom(shared, bucket + 50_900), consolidatedAfterFirst);

  assert.notEqual(first.signal.state, 'CONFIRM');
  assert.equal(second.signal.state, 'CONFIRM');
  assert.equal(second.signal.uiState, 'ENTER_BUY');
  assert.equal(second.signal.direction, 'BUY');
  assert.equal(second.decisionCycle.locked, 'ENTER');
});

test('central loop coalesces burst updates and schedules a final-window follow-up', () => {
  const central = read('src/background.js');
  assert.match(central, /const ANALYSIS_CADENCE_MS = 650/);
  assert.match(central, /const BURST_COALESCE_MS = 80/);
  assert.match(central, /inputSignature === lastInputSignature/);
  assert.match(central, /needsConfirmationFollowup/);
  assert.match(central, /scheduleAnalysis\(true\)/);
  assert.match(central, /owner: 'background\.js'/);
  assert.match(central, /Number\(session\.epoch \|\| 0\)/);
  // Same-market shell/trader handoff must not redefine market identity or
  // reset the orchestrator in the middle of a candle.
  const marketKeyBlock = central.match(/const marketKey = \[[\s\S]*?\]\.join\('\|'\);/)?.[0] || '';
  assert.ok(marketKeyBlock);
  assert.doesNotMatch(marketKeyBlock, /frameId|frameHost/);
});
