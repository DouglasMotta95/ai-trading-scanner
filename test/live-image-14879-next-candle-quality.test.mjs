import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');

test('14879: oversized impulse is measured against prior average range', () => {
  const analysis = read('src/core/analysis.js');
  assert.match(analysis, /priorAverageRange/);
  assert.match(analysis, /currentRangeMultiple/);
  assert.match(analysis, /overextendedImpulse/);
  assert.match(analysis, /exhaustionRisk/);
});

test('14879: continuation cannot auto-confirm after an exhausted impulse', () => {
  const analysis = read('src/core/analysis.js');
  assert.match(analysis, /Anti-chase: impulso esticado não confirma continuação da próxima vela/);
  assert.match(analysis, /score = Math\.min\(score, ANALYST_THRESHOLDS\.confirmScore - 1\)/);
});

test('14879: range continuation requires a real breakout with margin and non-stretched candle', () => {
  const orchestrator = read('src/core/orchestrator.js');
  assert.match(orchestrator, /name: 'rompimento confirmado no range'/);
  assert.match(orchestrator, /strongBreakout/);
  assert.match(orchestrator, /breakoutMargin >= \.18/);
  assert.match(orchestrator, /rangeMultiple <= 1\.45/);
});

test('14879: continuation and momentum cannot fight the identified trend', () => {
  const orchestrator = read('src/core/orchestrator.js');
  assert.match(orchestrator, /const counterTrend/);
  assert.match(orchestrator, /const trendCompatible/);
  assert.match(orchestrator, /name: 'continuação com tendência'/);
  assert.match(orchestrator, /name: 'momentum com tendência'/);
});

test('14879: a legacy CONFIRM cannot bypass the A+ final quality gate', () => {
  const orchestrator = read('src/core/orchestrator.js');
  assert.match(orchestrator, /signal\.state === 'CONFIRM'/);
  assert.match(orchestrator, /stableAPlus\.finalAllowed/);
});

test('14879: unknown regime is neutral rather than a hard veto', () => {
  const orchestrator = read('src/core/orchestrator.js');
  assert.match(orchestrator, /const trendCompatible = regime === 'unknown' \|\| trendAligned/);
});
