import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('demo candidate keeps focus, waiting guidance and range gate together', async () => {
  const [orchestrator, legacyOrchestrator, focusedAsset, analysis] = await Promise.all([
    readFile(new URL('../src/core/orchestrator.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/core/orchestrator-legacy.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/content/focused-asset.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/core/analysis.js', import.meta.url), 'utf8')
  ]);
  assert.match(orchestrator, /orchestrator-legacy\.js/);
  assert.match(orchestrator, /if \(regime === 'range'\)/);
  assert.match(legacyOrchestrator, /marketRegime\(closed\)/);
  assert.match(legacyOrchestrator, /regime\?\.type === 'range'/);
  assert.match(legacyOrchestrator, /AGUARDANDO — mercado sem tendência definida/);
  assert.match(legacyOrchestrator, /waitingFor: liveResult\.waitingFor \|\| null/);
  assert.match(analysis, /waitingFor/);
  assert.match(focusedAsset, /user-selection/);
  assert.match(focusedAsset, /aria-selected/);
  assert.match(focusedAsset, /__ATS_FOCUSED_ASSET_VALUE__/);
});
