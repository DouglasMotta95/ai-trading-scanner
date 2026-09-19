import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read = p => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');

test('asset-quality.test.mjs: current market session owns focused asset state',()=>{const s=read('src/background-market-session.js');assert.match(s,/clearMarketAuthorityState/);assert.match(s,/focusedAsset/);assert.match(s,/signal: null/);assert.match(s,/tradeIntent: null/);});
test('asset-quality.test.mjs: runtime loads the single market-session owner',()=>{const s=read('src/background-entry.js');assert.match(s,/background-market-session\.js/);assert.match(s,/background\.js/);assert.doesNotMatch(s,/background-fast-decision\.js/);});
