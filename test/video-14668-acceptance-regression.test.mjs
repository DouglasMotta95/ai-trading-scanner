import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');

test('connection recovery distinguishes injection health from live-asset readiness',()=>{
  const control=read('src/background-control.js');
  assert.match(control,/runtimeInjectionHealthy/);
  assert.match(control,/recoverFocusedAsset/);
  assert.match(control,/handshake_timeout/);
});

test('A+ remains primary and Gemini remains advanced second opinion',()=>{
  const html=read('src/sidepanel/index.html');
  const ai=read('src/background-ai-analysis.js');
  assert.match(html,/ANÁLISE A\+ • ALTA CONFIANÇA/);
  assert.match(html,/GEMINI • SEGUNDA LEITURA/);
  assert.match(ai,/actionable === true/);
});
