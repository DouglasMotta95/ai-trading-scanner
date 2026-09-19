import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');

test('same-host sibling clock frame does not invalidate focused market identity',()=>{
  const session=read('src/background-market-session.js');
  const start=session.indexOf('function clockMatchesFocus');
  const end=session.indexOf('function exactClock',start);
  const block=session.slice(start,end);
  assert.match(block,/frameHost/);
  assert.doesNotMatch(block,/clock\.frameId.*focus\.frameId/);
});

test('clock frame difference alone does not trigger a session reset',()=>{
  const session=read('src/background-market-session.js');
  const start=session.indexOf('const sessionChanged =',session.indexOf('export async function applyClock'));
  const end=session.indexOf('let next = state',start);
  const block=session.slice(start,end);
  assert.match(block,/session\.asset/);
  assert.match(block,/session\.timeframe/);
  assert.doesNotMatch(block,/session\.frameId/);
});

test('central analyzer accepts trusted same-host clock from sibling frame',()=>{
  const background=read('src/background.js');
  const start=background.indexOf('function consolidatedSnapshot');
  const end=background.indexOf('function rawInputSignature',start);
  const block=background.slice(start,end);
  assert.match(block,/clock\.frameHost/);
  assert.doesNotMatch(block,/clock\.frameId.*focus\.frameId/);
});

test('sidepanel readiness mirrors same-host sibling-frame rule',()=>{
  const app=read('src/sidepanel/app-v2.js');
  const start=app.indexOf('function clockBaseReady');
  const end=app.indexOf('function exactClockReady',start);
  const block=app.slice(start,end);
  assert.match(block,/clock\.frameHost/);
  assert.doesNotMatch(block,/clock\.frameId.*focus\.frameId/);
});
