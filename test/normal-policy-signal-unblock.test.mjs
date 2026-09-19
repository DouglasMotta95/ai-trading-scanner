import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');

test('professional decision policy mirrors the central orchestrator signal instead of applying a second score gate', () => {
  const source = read('src/background-decision-policy.js');
  const start = source.indexOf('function baseDecision');
  const end = source.indexOf('\nfunction signature', start);
  const block = source.slice(start, end);
  assert.match(block, /Single authority rule/);
  assert.match(block, /const ui = text\(signal\.uiState\)\.toUpperCase\(\)/);
  assert.doesNotMatch(block, /technicalCandidate|possibleScore|additionalConfluenceReady|requiredFactors/);
});

test('A+ high-confidence gating lives in the orchestrator before professionalDecision mirrors it', () => {
  const orchestrator = read('src/core/orchestrator.js');
  const engine = read('src/core/high-confidence.js');
  assert.match(orchestrator, /stableAPlusCandidateAllowed/);
  assert.match(orchestrator, /aPlus\.finalAllowed/);
  assert.match(engine, /candidateAllowed/);
  assert.match(engine, /finalAllowed/);
  assert.match(engine, /enterScore/);
});
