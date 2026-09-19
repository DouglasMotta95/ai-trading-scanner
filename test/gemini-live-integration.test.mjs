import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');
test('gemini-live-integration.test.mjs: Gemini is final-only second opinion',()=>{const s=read('src/background-ai-analysis.js'),h=read('src/sidepanel/index.html');assert.match(s,/ENTER_BUY/);assert.match(s,/ENTER_SELL/);assert.match(h,/GEMINI • SEGUNDA LEITURA/);assert.match(h,/SEM EXECUÇÃO AUTOMÁTICA/);});
