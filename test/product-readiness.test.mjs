import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');

test('current sidepanel loads account connector and diagnostics',()=>{
  const h=read('src/sidepanel/index.html');
  assert.match(h,/account-login\.js/);
  assert.match(h,/diagnostics-export\.js/);
});

test('backend keeps production session secret checks and serialized payment locks',()=>{
  const s=read('backend/src/server.js');
  assert.match(s,/SESSION_SECRET/);
  assert.match(s,/at least 32 characters in production/);
  assert.match(s,/paymentLocks/);
  assert.match(s,/orderLocks/);
  assert.match(s,/setPaymentEvent\(eventKey, 'processing'/);
  assert.match(s,/setPaymentEvent\(eventKey, 'completed'/);
  assert.equal(JSON.parse(read('backend/package.json')).version,'0.11.25');
});
