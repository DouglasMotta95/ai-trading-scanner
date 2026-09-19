import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');

test('current alert pipeline supports notification preferences without auto-trading',()=>{
  const h=read('src/sidepanel/index.html');
  const a=read('src/background-system-alerts.js');
  assert.match(h,/id="notificationToggle"/);
  assert.match(h,/id="alertLevel"/);
  assert.match(a,/notification|alert/i);
  assert.doesNotMatch(a,/ATS_EXECUTE_TRADE/);
});
