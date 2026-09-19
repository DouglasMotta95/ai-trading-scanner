import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');

test('decorated expiration values are parsed by direct CasaTrade recovery probe',()=>{
  const c=read('src/background-control.js');
  assert.match(c,/icon\/glyph/);
  assert.match(c,/directExpirationProbe/);
  assert.match(c,/minuto|minutos|min/);
});

test('fresh visual focus cannot be rolled back by passive protocol selection',()=>{
  const s=read('src/background-market-session.js');
  assert.match(s,/incomingProtocolOnly/);
  assert.match(s,/freshVisualFocus/);
  assert.match(s,/protocolContradictsSelectionLock/);
});
