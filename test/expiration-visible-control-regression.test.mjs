import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');

test('expiration probe searches the whole visible CasaTrade text around the Expiração label', () => {
  const source = read('src/content/casatrade-expiration-probe.js');
  assert.match(source, /function bodyExpiration\(\)/);
  assert.match(source, /slice\(0, 1200000\)/);
  assert.match(source, /body\.indexOf\(marker, from\)/);
  assert.match(source, /index \+ marker\.length/);
});

test('expiration probe can pair a visible Expiração label with a nearby 1 min value', () => {
  const source = read('src/content/casatrade-expiration-probe.js');
  assert.match(source, /function expirationControlByLabel\(all = \[\]\)/);
  assert.match(source, /expiracao\|expiry\|expiration/);
  assert.match(source, /sameContainer/);
  assert.match(source, /horizontalGap > 560/);
  assert.match(source, /selectedLike\(el\)/);
});

test('real CasaTrade expiration invalidates the temporary manual fallback immediately', () => {
  const controls = read('src/background-platform-controls.js');
  assert.match(controls, /const invalidatedDeclared = realFresh && declared \? declared : null/);
  assert.match(controls, /const effectiveDeclared = invalidatedDeclared \? null : declared/);
  assert.match(controls, /userDeclaredExpiration: resolved\.authority\.invalidatedDeclared \? null/);
  assert.match(controls, /manualInvalidated: authority\.invalidatedDeclared \|\| null/);
  assert.match(controls, /divergence: false/);
});

test('expiration probe also accepts a real duration immediately before the Expiração label', () => {
  const source = read('src/content/casatrade-expiration-probe.js');
  assert.match(source, /const reversed = spaced\.match/);
  assert.match(source, /Responsive layouts can reverse DOM\/text order/);
  assert.match(source, /r\.right < lr\.left/);
  assert.match(source, /parseExpiration/);
  assert.doesNotMatch(source, /expiration:\s*['"]60s['"]/);
});
