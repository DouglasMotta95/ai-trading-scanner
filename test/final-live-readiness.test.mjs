import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');
test('final-live-readiness.test.mjs: market-session is current focus authority',()=>{const s=read('src/background-market-session.js'),e=read('src/background-entry.js');assert.match(s,/clearMarketAuthorityState/);assert.match(s,/focusedAsset/);assert.match(e,/background-market-session\.js/);assert.doesNotMatch(e,/background-fast-decision\.js/);});
