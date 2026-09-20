import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');

test('trusted sibling clock may cross CasaTrade frame hosts when market identity matches',()=>{
  const session=read('src/background-market-session.js');
  const start=session.indexOf('function clockMatchesFocus');
  const end=session.indexOf('function exactClock',start);
  const block=session.slice(start,end);
  assert.match(block,/sameMarket\(clock\.asset, focus\.asset\)/);
  assert.doesNotMatch(block,/clock\.frameId.*focus\.frameId/);
  assert.doesNotMatch(block,/clock\.frameHost.*focus\.frameHost/);
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

test('central analyzer accepts trusted cross-host clock for the same focused market',()=>{
  const background=read('src/background.js');
  const start=background.indexOf('function consolidatedSnapshot');
  const end=background.indexOf('function rawInputSignature',start);
  const block=background.slice(start,end);
  assert.match(block,/sameMarket\(clock\.asset, asset\)/);
  assert.doesNotMatch(block,/clock\.frameId.*focus\.frameId/);
  assert.doesNotMatch(block,/clock\.frameHost.*focus\.frameHost/);
});

test('sidepanel readiness follows market identity instead of transport host equality',()=>{
  const app=read('src/sidepanel/app-v2.js');
  const start=app.indexOf('function clockBaseReady');
  const end=app.indexOf('function exactClockReady',start);
  const block=app.slice(start,end);
  assert.match(block,/sameMarket\(clock\.asset, state\.asset\)/);
  assert.doesNotMatch(block,/clock\.frameId.*focus\.frameId/);
  assert.doesNotMatch(block,/clock\.frameHost.*focus\.frameHost/);
});
