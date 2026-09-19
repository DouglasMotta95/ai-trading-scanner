import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');

test('live readiness requires focused asset, price, clock and current market identity',()=>{
  const b=read('src/background.js');
  assert.match(b,/focus\.reliable !== true/);
  assert.match(b,/focus\.trustedChartFrame !== true/);
  assert.match(b,/ALLOWED_CLOCK_SOURCES/);
  assert.match(b,/sameMarket\(clock\.asset, asset\)/);
});

test('connection recovery can re-acquire focused asset before final timeout',()=>{
  const c=read('src/background-control.js');
  assert.match(c,/recoverFocusedAsset/);
  assert.match(c,/finalConnectionCheck/);
});
