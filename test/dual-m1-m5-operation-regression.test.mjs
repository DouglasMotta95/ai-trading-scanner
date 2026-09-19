import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read = p => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');

test('dual-m1-m5-operation-regression.test.mjs: current runtime contract is wired',()=>{const e=read('src/background-entry.js'),h=read('src/sidepanel/index.html');assert.match(e,/background-market-session\.js/);assert.match(e,/background-control\.js/);assert.match(h,/id="decisionCard"/);});
