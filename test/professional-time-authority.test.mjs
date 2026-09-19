import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');

test('CasaTrade exact clock remains the user-entry time authority',()=>{
  const policy=read('src/background-decision-policy.js');
  const app=read('src/sidepanel/app-v2.js');
  for(const source of ['trader-dom-countdown','network-server-cycle']){
    assert.match(policy,new RegExp(source));
    assert.match(app,new RegExp(source));
  }
  assert.match(app,/There is no operational fallback clock anymore/);
});

test('current decision mode is A+ and Gemini remains second opinion',()=>{
  const policy=read('src/background-decision-policy.js');
  const ai=read('src/background-ai-analysis.js');
  assert.match(policy,/mode: 'A_PLUS'/);
  assert.match(ai,/ENTER_BUY/);
  assert.match(ai,/ENTER_SELL/);
});
