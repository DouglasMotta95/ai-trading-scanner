import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');

test('real CasaTrade feed expiration is promoted to platformControls for M1 entry gating', () => {
  const source = read('src/background-market-session.js');
  assert.match(source, /const observedExpiration = normExp\(candidate\.expiration/);
  assert.match(source, /expiration:\s*observedExpiration/);
  assert.match(source, /platformControls,/);
  assert.match(source, /aligned:\s*\(timeframe \|\| state\.analysisTimeframe \|\| state\.timeframe\) === 'M1' && observedExpiration === '60s'/);
  assert.match(source, /expirationSource:/);
});

test('feed expiration never comes from a saved preference', () => {
  const source = read('src/background-market-session.js');
  const start = source.indexOf('async function applyFeed');
  const end = source.indexOf('\nasync function applyChartPrice', start);
  const applyFeed = source.slice(start, end);
  assert.doesNotMatch(applyFeed, /preferredExpiration/);
  assert.doesNotMatch(applyFeed, /executionPreferences/);
});
