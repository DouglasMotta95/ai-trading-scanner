import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');

test('root cause: visible market identity is protected by explicit selection lock',()=>{
  const s=read('src/background-market-session.js');
  assert.match(s,/visualSelectionLock/);
  assert.match(s,/chartHeaderAuthoritative/);
  assert.match(s,/protocolContradictsSelectionLock/);
});

test('root cause: market switch hard-resets data and decision state',()=>{
  const s=read('src/background-market-session.js');
  for(const token of ['asset: null','price: null','marketHistory: {}','signal: null','entryAdvice: null']) assert.ok(s.includes(token),token);
});

test('root cause: candle-close clock is separate from expiry/duration controls',()=>{
  const c=read('src/content/market-cycle-clock-v4.js');
  assert.match(c,/candle-close/);
  assert.match(c,/expirySemantic/);
});

test('root cause: user-facing entry requires exact clock readiness',()=>{
  const a=read('src/sidepanel/app-v2.js');
  assert.match(a,/exactClockReady/);
  assert.match(a,/There is no operational fallback clock anymore/);
});

test('root cause: one central technical owner drives decision state',()=>{
  const e=read('src/background-entry.js');
  assert.match(e,/background\.js/);
  assert.doesNotMatch(e,/background-fast-decision\.js/);
});

test('root cause: A+ hysteresis protects published POSSIBLE state',()=>{
  const o=read('src/core/orchestrator.js');
  assert.match(o,/POSSIBLE_HIT_GAP_MS = 8000/);
  assert.match(o,/observeStableAPlusCandidate/);
});
