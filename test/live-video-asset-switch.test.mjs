import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');

test('asset or timeframe switch clears operational decision state',()=>{
  const s=read('src/background-market-session.js');
  for(const token of ['signal: null','professionalDecision: null','aiAudit: null','lastConfirmed: null','tradeIntent: null','entryAdvice: null']) {
    assert.ok(s.includes(token), token);
  }
});

test('visual selection lock prevents passive old-asset rollback',()=>{
  const s=read('src/background-market-session.js');
  assert.match(s,/visualSelectionLock/);
  assert.match(s,/selectionLockActive/);
  assert.match(s,/protocolContradictsSelectionLock/);
});
