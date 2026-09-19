import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../src/background-decision-policy.js', import.meta.url), 'utf8');

test('professional policy mirrors the orchestrator signal instead of applying a second confluence veto', () => {
  const start = source.indexOf('function baseDecision');
  const end = source.indexOf('\nfunction signature', start);
  const block = source.slice(start, end);
  assert.match(block, /Single authority rule/);
  assert.match(block, /if \(ui === 'ENTER_BUY' \|\| ui === 'ENTER_SELL'\)/);
  assert.match(block, /if \(ui === 'POSSIBLE_BUY' \|\| ui === 'POSSIBLE_SELL'\)/);
  assert.doesNotMatch(block, /requiredFactors|possibleScore|finalScore/);
});

test('A+ profile is owned by the technical engine and exposed as the current professional profile', () => {
  assert.match(source, /mode: 'A_PLUS'/);
  assert.match(source, /profile: pref\.mode/);
  assert.match(source, /operatingTimeframe/);
});
