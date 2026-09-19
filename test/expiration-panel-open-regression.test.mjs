import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read = p => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');

test('expiration-panel-open-regression.test.mjs: current CasaTrade clock uses explicit live authorities',()=>{const s=read('src/content/market-cycle-clock-v4.js');assert.match(s,/trader-dom-countdown/);assert.match(s,/network-server-cycle/);assert.doesNotMatch(s,/\|\|\s*'M1'/);});
test('expiration-panel-open-regression.test.mjs: expiration plan supports the current M1\/M5 contract',()=>{const s=read('src/background-control.js');assert.match(s,/expirationForOperatingTimeframe/);assert.match(s,/M1.*60s|60s.*M1/s);assert.match(s,/300s/);});
