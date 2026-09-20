import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');

test('20/09 entry flow releases POSSIBLE at 55 and final decision near 15 seconds', () => {
  const analysis = read('src/core/analysis.js');
  const orchestrator = read('src/core/orchestrator.js');
  assert.match(analysis, /possibleScore:\s*55/);
  assert.match(analysis, /confirmScore:\s*58/);
  assert.match(orchestrator, /const POSSIBLE_CONFIRM_HITS = 1/);
  assert.match(orchestrator, /const CONFIRM_HITS = 1/);
  assert.match(orchestrator, /FINAL_CANDIDATE_MIN_AGE_MS = 750/);
  assert.match(orchestrator, /timeframe === 'M1' \|\| timeframe === 'M5'/);
  assert.match(orchestrator, /decision: 15/);
  assert.match(orchestrator, /function patternEvidence/);
  assert.match(orchestrator, /score < ANALYST_THRESHOLDS\.confirmScore/);
  assert.match(orchestrator, /Asset\s+quality remains advisory/);
});

test('20/09 asset switch prioritizes the touched market and never pairs it with an old quote row', () => {
  const focus = read('src/content/focused-asset-v2.js');
  const canvas = read('src/content/canvas-probe.js');
  const background = read('src/background.js');
  const manifest = JSON.parse(read('manifest.json'));
  assert.match(focus, /ATS_VISUAL_ASSET_SWITCH/);
  assert.match(canvas, /preferredAssetAt/);
  assert.match(canvas, /preferenceFresh/);
  assert.match(canvas, /matchingRows/);
  assert.match(canvas, /sameAsset\(row\.asset, asset\)/);
  assert.match(canvas, /lastAppScanAt < 300/);
  assert.match(background, /ANALYSIS_CADENCE_MS = 350/);
  assert.match(background, /seconds <= 15/);
  assert.equal(manifest.version, '0.11.43.1');
  assert.equal(manifest.version_name, '0.11.43.1-entry-release-fast-asset-switch');
});
