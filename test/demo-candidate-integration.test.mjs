import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { assessEntryEvidence } from '../src/core/entry-evidence.js';

test('demo candidate keeps current focus, waiting guidance and range gate together', async () => {
  const [orchestrator, legacyOrchestrator, focusedAsset, analysis, entry] = await Promise.all([
    readFile(new URL('../src/core/orchestrator.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/core/orchestrator-legacy.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/content/focused-asset-v2.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/core/analysis.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/background-entry.js', import.meta.url), 'utf8')
  ]);
  assert.match(orchestrator, /orchestrator-legacy\.js/);
  assert.match(legacyOrchestrator, /marketRegime\(closed\)/);
  assert.match(legacyOrchestrator, /regime\?\.type === 'range'/);
  assert.match(legacyOrchestrator, /waitingFor: liveResult\.waitingFor \|\| null/);
  assert.match(analysis, /waitingFor/);
  assert.match(focusedAsset, /ariaSelected === 'true'/);
  assert.match(focusedAsset, /__ATS_FOCUSED_ASSET_VALUE__/);
  assert.match(focusedAsset, /const frameRole = traderHost\(host\) \? 'trader-frame' : 'casa-chart-frame'/);
  assert.match(entry, /background-market-session\.js/);

  const rangeOnlyMomentum = assessEntryEvidence({
    regime: { type: 'range' },
    analytics: {
      buyPower: 62,
      currentStrength: 68,
      continuationDirection: 'BUY',
      continuationScore: 72,
      momentumDirection: 'BUY',
      momentumScore: 65
    }
  }, 'BUY');
  assert.equal(rangeOnlyMomentum.qualifies, false);
  assert.equal(rangeOnlyMomentum.blocker, 'range-needs-rejection-or-breakout');
});
