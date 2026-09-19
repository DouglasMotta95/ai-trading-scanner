import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');

test('obsolete fast-decision runtime is not loaded; central orchestrator owns final window',()=>{
  const e=read('src/background-entry.js');
  const o=read('src/core/orchestrator.js');
  assert.doesNotMatch(e,/background-fast-decision\.js/);
  assert.match(e,/background\.js/);
  assert.match(o,/timeframe === 'M1'[^\n]*decision: 10/);
  assert.match(o,/timeframe === 'M5'[^\n]*decision: 20/);
});
