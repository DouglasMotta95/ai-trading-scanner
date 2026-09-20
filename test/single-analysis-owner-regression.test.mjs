import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');

test('background.js is the single central technical analysis owner',()=>{
  const entry=read('src/background-entry.js');
  const bg=read('src/background.js');
  assert.match(entry,/background\.js/);
  assert.doesNotMatch(entry,/background-fast-decision\.js/);
  assert.match(bg,/analysisRunning/);
  assert.match(bg,/pendingAfterRun/);
  assert.match(bg,/__ATS_RUN_CENTRAL_ANALYSIS__/);
});

test('burst updates coalesce and final-window follow-up is centrally scheduled',()=>{
  const bg=read('src/background.js');
  assert.match(bg,/scheduleAnalysis/);
  assert.match(bg,/needsConfirmationFollowup/);
  assert.match(bg,/if \(pendingAfterRun\)/);
  assert.match(bg,/if \(needsConfirmationFollowup\) scheduleAnalysis\(true\)/);
});
