import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');

test('focused asset handshake does not reference removed changed flag',()=>{
  const s=read('src/background-market-session.js');
  assert.doesNotMatch(s,/stableSince:\s*changed\s*\?/);
  assert.match(s,/stableSince:\s*assetChanged\s*\?\s*now\s*:\s*previousStableSince/);
});

test('trusted CasaTrade chart focus is written as reliable chart-scoped focus',()=>{
  const s=read('src/background-market-session.js');
  assert.match(s,/trustedChartFrame: true/);
  assert.match(s,/chartScoped: true/);
  assert.match(s,/frameRole: incomingEmbeddedTrader \? 'trader-frame' : 'casa-chart-frame'/);
});

test('connection recovery still retries focused asset before final timeout',()=>{
  const c=read('src/background-control.js');
  assert.match(c,/recoverFocusedAsset\(tabId\)/);
  assert.match(c,/finalConnectionCheck/);
});
