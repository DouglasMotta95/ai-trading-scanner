import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');

test('connection recovery can probe all CasaTrade frames for the focused asset',()=>{
  const c=read('src/background-control.js');
  assert.match(c,/directFocusedAssetProbe/);
  assert.match(c,/allFrames: true/);
  assert.match(c,/__ATS_FOCUSED_ASSET_META__/);
  assert.match(c,/applyMarketFocus/);
});
