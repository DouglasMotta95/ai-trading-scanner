import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');

test('14879: legacy technical confirmation cannot bypass A+ next-candle quality',()=>{
  const o=read('src/core/orchestrator.js');
  const start=o.indexOf("if (signal.state === 'CONFIRM'");
  const block=o.slice(start,start+2200);
  assert.match(block,/decisionQuality/);
  assert.match(block,/aPlusAssessment/);
  assert.match(block,/aPlus\.finalAllowed/);
});

test('14879: stretched impulse remains an explicit anti-chase blocker',()=>{
  const a=read('src/core/analysis.js');
  const o=read('src/core/orchestrator.js');
  assert.match(a,/exhaustionRisk/);
  assert.match(o,/exhaustion-risk/);
});
