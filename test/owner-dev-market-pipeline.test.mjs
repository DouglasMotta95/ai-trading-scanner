import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');

test('owner dev access is honored by every live market handler', () => {
  const market = read('src/background-market-session.js');
  assert.match(market, /license\?\.devMode === true/);
  assert.match(market, /license\?\.plan === 'OWNER_DEV'/);
  assert.match(market, /diagnostics\?\.access\?\.ownerDev === true/);
  assert.match(market, /diagnostics\?\.access\?\.state === 'owner_dev'/);
  const guardedHandlers = ['applyFocus', 'applyClock', 'applyFeed', 'applyChartPrice', 'applyInspector'];
  for (const name of guardedHandlers) {
    const start = market.indexOf(`async function ${name}`);
    assert.ok(start >= 0, `missing handler ${name}`);
    const next = market.indexOf('\nasync function ', start + 1);
    const body = market.slice(start, next > start ? next : market.length);
    assert.match(body, /licenseActive\(state\)/, `${name} must use the shared owner-aware gate`);
  }
});
