import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');

test('missing exact clock is never replaced by a local entry-time estimate',()=>{
  const a=read('src/sidepanel/app-v2.js');
  assert.match(a,/There is no operational fallback clock anymore/);
  assert.match(a,/exactClockReady/);
});

test('M1 current entry window remains 30s preparation and 10s final',()=>{
  const o=read('src/core/orchestrator.js');
  assert.match(o,/timeframe === 'M1'[^\n]*pre: 30, decision: 10/);
});
