import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { processSnapshot, resetOrchestrator } from '../src/core/orchestrator.js';
import { bullishAPlusRows, snapshotFor, minute } from './helpers/current-a-plus-fixtures.mjs';

const read = path => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

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

test('burst acquisition updates cannot reset a prepared candidate between central analysis ticks', () => {
  resetOrchestrator();
  const bucket = Math.floor(1_704_000_000_000 / minute) * minute;
  const rows = bullishAPlusRows(bucket);
  const state = { connection: 'online' };

  const first = processSnapshot(snapshotFor(bucket, 35_000, { rows, secondsRemaining: 25 }), state);
  assert.notEqual(first.signal.uiState, 'POSSIBLE_BUY');

  // Simulate several independent acquisition writes without invoking the engine.
  const shared = {
    ...state,
    connection: 'online',
    asset: 'EUR/USD (OTC)',
    price: rows.at(-1).close,
    candles: rows,
    diagnostics: {
      focusedAsset: {
        asset: 'EUR/USD (OTC)', reliable: true, chartScoped: true, trustedChartFrame: true,
        frameId: 7, frameHost: 'trade.casatraders.online', at: bucket + 40_000
      },
      marketClock: {
        asset: 'EUR/USD (OTC)', timeframe: 'M1', secondsRemaining: 19,
        verified: true, available: true, operational: true, role: 'candle-close',
        source: 'trader-dom-countdown', frameId: 7, frameHost: 'trade.casatraders.online',
        at: bucket + 41_000
      }
    }
  };

  const possible = processSnapshot(snapshotFor(bucket, 41_000, { rows, secondsRemaining: 19 }), shared);
  assert.equal(possible.signal.uiState, 'POSSIBLE_BUY');

  const firstFinal = processSnapshot(snapshotFor(bucket, 51_000, { rows, secondsRemaining: 9 }), { ...shared, ...possible });
  assert.notEqual(firstFinal.signal.state, 'CONFIRM');
  const confirmed = processSnapshot(snapshotFor(bucket, 52_000, { rows, secondsRemaining: 8 }), { ...shared, ...firstFinal });
  assert.equal(confirmed.signal.state, 'CONFIRM');
  assert.equal(confirmed.signal.uiState, 'ENTER_BUY');
  assert.equal(confirmed.decisionCycle.locked, 'ENTER');
});

test('central loop coalesces burst updates and schedules a final-window follow-up without treating frame handoff as market identity', () => {
  const central = read('src/background.js');
  assert.match(central, /const ANALYSIS_CADENCE_MS = 650/);
  assert.match(central, /const BURST_COALESCE_MS = 80/);
  assert.match(central, /inputSignature === lastInputSignature/);
  assert.match(central, /needsConfirmationFollowup/);
  assert.match(central, /scheduleAnalysis\(true\)/);
  assert.match(central, /owner: 'background\.js'/);
  assert.match(central, /Number\(session\.epoch \|\| 0\)/);

  const start = central.indexOf('const marketKey = [');
  const end = central.indexOf("].join('|');", start);
  const marketKey = central.slice(start, end);
  assert.doesNotMatch(marketKey, /frameId|frameHost/);
});
