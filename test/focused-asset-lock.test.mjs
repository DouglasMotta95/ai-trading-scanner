import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');

test('current focused-asset lock is owned by background-market-session',()=>{
  const s=read('src/background-market-session.js');
  assert.match(s,/visualSelectionLock/);
  assert.match(s,/selectionLockActive/);
  assert.match(s,/freshVisualFocus/);
});

test('session switch clears stale price/history/signal state',()=>{
  const s=read('src/background-market-session.js');
  for(const token of ['price: null','candles: []','marketHistory: {}','signal: null','lastConfirmed: null']) assert.ok(s.includes(token),token);
});
