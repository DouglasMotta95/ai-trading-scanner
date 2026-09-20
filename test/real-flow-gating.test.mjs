import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');

test('visible chart frame and central consolidated snapshot are the current market gates',()=>{
  const s=read('src/background-market-session.js');
  const b=read('src/background.js');
  assert.match(s,/trustedChartFrame/);
  assert.match(s,/chartScoped/);
  assert.match(b,/consolidatedSnapshot/);
  assert.match(b,/sameMarket\(focus\.asset, asset\)/);
});
