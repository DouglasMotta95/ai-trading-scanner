import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');

test('professional filter scores independent trader-style blocks', () => {
  const analysis = read('src/core/analysis.js');
  for (const block of ['structure','location','trigger','momentum','indicators','quality']) {
    assert.match(analysis, new RegExp(block));
  }
  assert.match(analysis, /contextReady/);
  assert.match(analysis, /positionReady/);
  assert.match(analysis, /triggerReady/);
  assert.match(analysis, /candidateReady = professional\.contextReady && professional\.triggerReady/);
});

test('trend alone cannot become an actionable signal', () => {
  const analysis = read('src/core/analysis.js');
  const central = read('src/core/orchestrator-legacy.js');
  const fast = read('src/core/live-fast-decision.js');
  const policy = read('src/background-decision-policy.js');

  assert.match(analysis, /positionReady = breakout \|\| rejection \|\| nearKeyLevel/);
  assert.match(analysis, /triggerReady = breakout \|\| rejection \|\| continuation/);
  assert.match(central, /professional\.contextReady !== true \|\| professional\.triggerReady !== true/);
  assert.match(fast, /professionalReady = professional\.contextReady === true && professional\.triggerReady === true/);
  assert.match(policy, /professionalContextReady/);
  assert.match(policy, /professionalTriggerReady/);
});

test('manual execution and CasaTrade timing protections remain untouched by the scoring upgrade', () => {
  const handoff = read('src/content/trade-handoff-v2.js');
  const policy = read('src/background-decision-policy.js');
  assert.doesNotMatch(handoff, /\.click\s*\(/);
  assert.match(policy, /EXACT_CLOCK_SOURCES/);
  assert.match(policy, /CasaTradeExpiration/);
});
