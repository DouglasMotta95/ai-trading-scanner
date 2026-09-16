import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');

test('an explicit visual asset switch cannot be rolled back by stale protocol-selected state', () => {
  const protocol = read('src/content/focused-asset-protocol.js');
  assert.match(protocol, /function visualBlocksProtocolRollback\(asset\)/);
  assert.match(protocol, /source === 'user-selected-transition' \|\| meta\.interactionHint === true/);
  assert.match(protocol, /if \(explicitTransition\) return !same\(current, asset\)/);
  assert.match(protocol, /if \(visualBlocksProtocolRollback\(winner\.asset\)\) return/);
  assert.doesNotMatch(protocol, /transition \? 8000/);
});

test('inactive license clears stale market state and cannot restart the scanner', () => {
  const control = read('src/background-control.js');
  const clearStart = control.indexOf('function clearMarket');
  const clearEnd = control.indexOf('\nfunction licenseBlockedDiagnostics', clearStart);
  const clearMarket = control.slice(clearStart, clearEnd);
  for (const expected of [
    "scanner: 'idle'",
    "connection: 'offline'",
    'asset: null',
    'price: null',
    'candles: []',
    'marketHistory: {}',
    'signal: null',
    'lastSeen: null'
  ]) assert.ok(clearMarket.includes(expected), `missing license-block cleanup: ${expected}`);

  assert.match(control, /async function validate\(\)[\s\S]*?activeLicense\(license\)[\s\S]*?clearMarket\(current/);
  assert.match(control, /async function setScanner\(enabled = false\)[\s\S]*?enabled && !activeLicense\(state\.license\)/);
  assert.match(control, /error: 'license_required'/);
  assert.match(control, /await updateScannerState\(current => activeLicense\(license\)[\s\S]*?clearMarket\(current/);
});

test('safe diagnostic exposes license and freshness status without license key or tokens', () => {
  const diagnostics = read('src/sidepanel/diagnostics-export.js');
  assert.match(diagnostics, /licensed,/);
  assert.match(diagnostics, /licenseStatus,/);
  assert.match(diagnostics, /licenseError:/);
  assert.match(diagnostics, /syncPending:/);
  assert.match(diagnostics, /marketFresh:/);
  assert.match(diagnostics, /clockFresh:/);
  assert.doesNotMatch(diagnostics, /licenseKey\s*:/);
  assert.doesNotMatch(diagnostics, /clientToken\s*:/);
});
