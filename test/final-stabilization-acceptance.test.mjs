import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { processSnapshot, resetOrchestrator } from '../src/core/orchestrator.js';
import { minute, m1Snapshot, lockedCycle } from './helpers/current-fixtures.mjs';
const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');

test('final ENTER is latched for the active decision cycle',()=>{
  resetOrchestrator();
  const bucket=Math.floor(1_814_000_000_000/minute)*minute;
  const a=processSnapshot(m1Snapshot(bucket,54_000),{connection:'online',decisionCycle:lockedCycle(bucket)});
  const b=processSnapshot(m1Snapshot(bucket,58_000),{connection:'online',decisionCycle:a.decisionCycle});
  assert.equal(a.signal.uiState,'ENTER_BUY');
  assert.equal(b.signal.uiState,'ENTER_BUY');
});

test('connection recovery and current A+ UI surfaces remain present',()=>{
  const c=read('src/background-control.js');
  const h=read('src/sidepanel/index.html');
  assert.match(c,/handshakeReady/);
  assert.match(c,/recoverFocusedAsset/);
  assert.match(h,/ANÁLISE A\+ • ALTA CONFIANÇA/);
});
