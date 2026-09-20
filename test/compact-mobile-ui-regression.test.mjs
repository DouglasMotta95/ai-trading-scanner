import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read = p => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');

test('compact-mobile-ui-regression.test.mjs: current compact UI exposes one decision and advanced diagnostics',()=>{const h=read('src/sidepanel/index.html');assert.equal((h.match(/id="decisionCard"/g)||[]).length,1);assert.match(h,/id="operatingTimeframe"/);assert.match(h,/id="advancedPanel"/);assert.match(h,/GEMINI • SEGUNDA LEITURA/);});
