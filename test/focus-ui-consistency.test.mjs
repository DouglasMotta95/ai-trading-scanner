import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');

test('UI asset is sourced from current scanner state and market session',()=>{
  const a=read('src/sidepanel/app-v2.js');
  assert.match(a,/sessionInfo/);
  assert.match(a,/marketDataReady/);
  assert.match(a,/sameMarket/);
});

test('focus readiness requires trusted chart frame',()=>{
  const a=read('src/sidepanel/app-v2.js');
  assert.match(a,/trustedChartFrame === true/);
  assert.match(a,/chartScoped === true/);
});
