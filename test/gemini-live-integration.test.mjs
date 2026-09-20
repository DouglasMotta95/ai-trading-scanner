import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');

test('current build wires Gemini only through server-side gateway',()=>{
  const m=JSON.parse(read('manifest.json'));
  const e=read('src/background-entry.js');
  const client=read('src/services/ai-analysis.js');
  assert.equal(m.version,'0.11.51');
  assert.match(e,/background-ai-analysis\.js/);
  assert.match(client,/\/v1\/ai\/analyze/);
  assert.doesNotMatch(client,/GEMINI_API_KEY|generativelanguage\.googleapis\.com/);
});

test('Gemini remains final-only second opinion in the panel',()=>{
  const ai=read('src/background-ai-analysis.js');
  const h=read('src/sidepanel/index.html');
  assert.match(ai,/ENTER_BUY/);
  assert.match(ai,/ENTER_SELL/);
  assert.match(h,/GEMINI • SEGUNDA LEITURA/);
  assert.match(h,/SEM EXECUÇÃO AUTOMÁTICA/);
});
