import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');

test('sidepanel loads only the current manual handoff, Gemini and diagnostics surfaces',()=>{
  const h=read('src/sidepanel/index.html');
  assert.match(h,/trade-handoff-ui\.js/);
  assert.match(h,/ai-analysis-ui\.js/);
  assert.match(h,/diagnostics-export\.js/);
  assert.doesNotMatch(h,/manual-trade-ui\.js|bankroll-ui\.js|radar-ui\.js/);
});
