import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../src/background-decision-policy.js', import.meta.url), 'utf8');

test('NORMAL trusts a technical candidate instead of applying a second confluence veto', () => {
  assert.match(source, /const additionalConfluenceReady = pref\.mode !== 'A_PLUS' \|\| factors\.count >= requiredFactors/);
  assert.match(source, /score < possibleScore \|\| !additionalConfluenceReady/);
  assert.match(source, /technicalFinal && score >= finalScore && additionalConfluenceReady/);
  assert.doesNotMatch(source, /score < possibleScore \|\| factors\.count < requiredFactors/);
  assert.doesNotMatch(source, /technicalFinal && score >= finalScore && factors\.count >= requiredFactors/);
});

test('A+ keeps its explicit extra three-factor gate', () => {
  assert.match(source, /const requiredFactors = pref\.mode === 'A_PLUS' \? 3 : 2/);
  assert.match(source, /pref\.mode !== 'A_PLUS' \|\| factors\.count >= requiredFactors/);
});
