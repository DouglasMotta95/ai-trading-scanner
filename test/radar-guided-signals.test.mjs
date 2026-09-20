import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');

test('current compact product intentionally replaces old radar panels with one decision plus asset quality',()=>{
  const h=read('src/sidepanel/index.html');
  assert.match(h,/id="decisionCard"/);
  assert.match(h,/id="assetQualityCard"/);
  assert.doesNotMatch(h,/id="assetRadarList"|radar-ui\.js/);
});
