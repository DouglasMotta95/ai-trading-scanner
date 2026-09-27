import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');

test('expiration probe searches the whole visible CasaTrade text around the Expiração label', () => {
  const source = read('src/content/casatrade-expiration-probe.js');
  assert.match(source, /function bodyExpiration\(\)/);
  assert.match(source, /slice\(0, 1200000\)/);
  assert.match(source, /const markerRe = \/\(\?:expiracao\|expiry\|expiration\)\/g/);
  assert.match(source, /body-explicit-unique/);
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


test('Android visual fallback pairs a visible Expiração text node with a rendered duration', () => {
  const source = read('src/content/casatrade-expiration-probe.js');
  assert.match(source, /function visibleTextRows\(\)/);
  assert.match(source, /document\.createTreeWalker/);
  assert.match(source, /function expirationFromRenderedText\(all = \[\]\)/);
  assert.match(source, /rendered-text-label-pair/);
});


test('v0.11.82 keeps an explicit user expiration declaration valid beyond seven seconds', () => {
  const panel = read('src/sidepanel/app-v2.js');
  assert.match(panel, /const manualValue = normExp\(controls\.userDeclaredExpiration \|\| ''\);/);
  assert.match(panel, /const manualFresh = !!manualValue;/);
  assert.doesNotMatch(panel, /manualFresh = observedAt > 0 && Date\.now\(\) - observedAt < 7000/);
  assert.match(panel, /A user declaration is session state, not a short-lived observation/);
});

test('v0.11.82 restores a saved expiration declaration after reconnect without manual reselection', () => {
  const shell = read('src/sidepanel/ui-shell-v2.js');
  assert.match(shell, /dataset\.atsRestoredExpiration/);
  assert.match(shell, /restoreSessionKey/);
  assert.match(shell, /expirationSelect\.dispatchEvent\(new Event\('change', \{ bubbles: true \}\)\)/);
  assert.match(shell, /Programmatic restoration does not fire <select>'s change event/);
});
