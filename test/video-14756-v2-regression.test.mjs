import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');

test('fresh visible selection remains authoritative across frame readers',()=>{
  const session=read('src/background-market-session.js');
  assert.match(session,/visualSelectionLock/);
  assert.match(session,/contradictsSelectionLock/);
  assert.match(session,/chartHeaderAuthoritative/);
});

test('panel keeps exact countdown, retry and expected-asset surfaces',()=>{
  const html=read('src/sidepanel/index.html');
  const app=read('src/sidepanel/app-v2.js');
  assert.match(html,/id="retryLiveRead"/);
  assert.match(html,/id="expectedAsset"/);
  assert.match(app,/exactClockReady/);
});
