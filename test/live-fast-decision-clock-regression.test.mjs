import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');

test('legacy fast-decision module still prefers explicit CasaTrade clock if invoked in isolation', () => {
  const background = read('src/background-fast-decision.js');
  const core = read('src/core/live-fast-decision.js');
  assert.match(background, /secondsRemaining:\s*observed\.diagnostics\?\.marketClock\?\.secondsRemaining/);
  assert.match(core, /Number\(context\.secondsRemaining \?\? signal\.secondsRemaining \?\? 0\)/);
  assert.match(background, /targetStart:\s*observed\.diagnostics\?\.marketClock\?\.closeAt/);
});

test('legacy fast-decision module cannot override the current A+ orchestrator runtime', () => {
  const entry = read('src/background-entry.js');
  const central = read('src/background.js');
  const orchestrator = read('src/core/orchestrator.js');
  assert.doesNotMatch(entry, /background-fast-decision\.js/);
  assert.match(entry, /import '.\/background\.js';/);
  assert.match(central, /Single owner of technical analysis/);
  assert.match(orchestrator, /stableAPlusCandidateAllowed/);
  assert.match(orchestrator, /aPlus\.finalAllowed/);
});
