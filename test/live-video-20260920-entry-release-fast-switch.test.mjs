import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { processSnapshot, resetOrchestrator } from '../src/core/orchestrator.js';

const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const minute = 60_000;

function bullishRows(bucket) {
  return [
    { time: bucket - 4 * minute, open: 1.000, high: 1.020, low: .990, close: 1.018, timeframe: 'M1' },
    { time: bucket - 3 * minute, open: 1.018, high: 1.040, low: 1.010, close: 1.038, timeframe: 'M1' },
    { time: bucket - 2 * minute, open: 1.038, high: 1.060, low: 1.030, close: 1.058, timeframe: 'M1' },
    { time: bucket - minute, open: 1.058, high: 1.080, low: 1.050, close: 1.078, timeframe: 'M1' },
    { time: bucket, open: 1.078, high: 1.115, low: 1.075, close: 1.110, timeframe: 'M1' }
  ];
}
function snap(bucket, elapsed, secondsRemaining) {
  const candles = bullishRows(bucket);
  return processSnapshot({
    platformId: 'casatrade',
    asset: 'EUR/USD (OTC)',
    price: candles.at(-1).close,
    timeframe: 'M1',
    analysisTimeframe: 'M1',
    connection: 'online',
    serverTime: bucket + elapsed,
    secondsRemaining,
    candles
  }, { connection: 'online' });
}

test('20/09: score/pattern can reach POSSIBLE below 30s and final ENTER inside the 15s window', () => {
  resetOrchestrator();
  const bucket = Math.floor(1_811_500_000_000 / minute) * minute;

  const first = snap(bucket, 35_000, 25);
  assert.notEqual(first.signal.uiState, 'ENTER_BUY');

  const possible = snap(bucket, 41_000, 19); // 6s Android-style gap
  assert.equal(possible.signal.uiState, 'POSSIBLE_BUY');
  assert.ok(possible.signal.analysisScore >= 55);

  const final1 = snap(bucket, 45_000, 15);
  assert.notEqual(final1.signal.uiState, 'WAIT');

  const final2 = snap(bucket, 46_000, 14);
  assert.equal(final2.signal.uiState, 'ENTER_BUY');
  assert.equal(final2.signal.state, 'CONFIRM');
  assert.equal(final2.decisionCycle.locked, 'ENTER');
});

test('20/09: focused release thresholds keep base analyst scoring intact', () => {
  const analysis = read('src/core/analysis.js');
  const orchestrator = read('src/core/orchestrator.js');
  assert.match(analysis, /possibleScore:\s*44/);
  assert.match(analysis, /confirmScore:\s*58/);
  assert.match(orchestrator, /POSSIBLE_RELEASE_SCORE = 55/);
  assert.match(orchestrator, /POSSIBLE_CONFIRM_HITS = 2/);
  assert.match(orchestrator, /POSSIBLE_HIT_GAP_MS = 8000/);
  assert.match(orchestrator, /CONFIRM_HITS = 2/);
  assert.match(orchestrator, /FINAL_CANDIDATE_MIN_AGE_MS = 500/);
  assert.match(orchestrator, /timeframe === 'M1' \|\| timeframe === 'M5'/);
  assert.match(orchestrator, /decision: 15/);
  assert.match(orchestrator, /function patternEvidence/);
  assert.match(orchestrator, /quality remains advisory/);
});

test('20/09: asset switch prioritizes the touched market and never pairs it with an old quote row', () => {
  const focus = read('src/content/focused-asset-v2.js');
  const canvas = read('src/content/canvas-probe.js');
  const background = read('src/background.js');
  const manifest = JSON.parse(read('manifest.json'));
  assert.match(focus, /ATS_VISUAL_ASSET_SWITCH/);
  assert.match(canvas, /preferredAssetAt/);
  assert.match(canvas, /preferenceFresh/);
  assert.match(canvas, /taggedMatchingRows/);
  assert.match(canvas, /sameAsset\(row\.asset, asset\)/);
  assert.match(canvas, /lastAppScanAt < 300/);
  assert.match(background, /ANALYSIS_CADENCE_MS = 350/);
  assert.match(background, /seconds <= 15/);
  assert.equal(manifest.version, '0.11.43.1');
  assert.equal(manifest.version_name, '0.11.43.1-entry-release-fast-asset-switch');
});
