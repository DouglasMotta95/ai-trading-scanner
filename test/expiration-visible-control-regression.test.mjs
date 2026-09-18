import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');

test('expiration probe searches the whole visible CasaTrade text around the Expiração label', () => {
  const source = read('src/content/casatrade-expiration-probe.js');
  assert.match(source, /function bodyExpiration\(\)/);
  assert.match(source, /slice\(0, 220000\)/);
  assert.match(source, /body\.indexOf\(marker, from\)/);
  assert.match(source, /index \\+ 360/);
});

test('expiration probe can pair a visible Expiração label with a nearby 1 min value', () => {
  const source = read('src/content/casatrade-expiration-probe.js');
  assert.match(source, /function nearbyExpiration\(all = \[\]\)/);
  assert.match(source, /expiracao\|expiry\|expiration/);
  assert.match(source, /sameControlBand/);
  assert.match(source, /horizontal <= 520/);
});

test('expiration probe also accepts a real duration immediately before the Expiração label', () => {
  const source = read('src/content/casatrade-expiration-probe.js');
  assert.match(source, /function expirationAroundLabel\(raw = ''\)/);
  assert.match(source, /Math\.max\(0, index - 180\)/);
  assert.match(source, /matches\.at\(-1\)/);
  assert.match(source, /const reversed = expirationValue\(token\)/);
  assert.match(source, /r\.right < lr\.left/);
  assert.doesNotMatch(source, /expiration:\s*['"]60s['"]/);
});
