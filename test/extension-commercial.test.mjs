import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');

test('commercial runtime keeps license, account and scanner control wired',()=>{
  const e=read('src/background-entry.js');
  const h=read('src/sidepanel/index.html');
  assert.match(e,/background-control\.js/);
  assert.match(e,/background-dev-owner\.js/);
  assert.match(h,/account-login\.js/);
  assert.match(h,/id="licenseCard"/);
});

test('manual trading remains confirmation-only',()=>{
  const c=read('src/background-control.js');
  assert.match(c,/tradeIntent/);
  assert.doesNotMatch(c,/ATS_EXECUTE_TRADE/);
});
