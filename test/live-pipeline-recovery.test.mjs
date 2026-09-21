import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');

test('Build 5 wires owner access, exact clock projection and expiration probe into runtime', () => {
  const manifest = JSON.parse(read('manifest.json'));
  const entry = read('src/background-entry.js');
  const injector = read('src/background-modern-injector.js');
  const html = read('src/sidepanel/index.html');
  const isolated = manifest.content_scripts.find(group => group.js?.includes('src/content/market-cycle-clock-v4.js'))?.js || [];

  assert.ok(entry.includes("import './background-dev-owner.js';"));
  assert.ok(isolated.includes('src/content/market-clock-projector.js'));
  assert.ok(isolated.includes('src/content/casatrade-expiration-probe.js'));
  assert.ok(injector.includes("'src/content/market-clock-projector.js'"));
  assert.ok(injector.includes("'src/content/casatrade-expiration-probe.js'"));
  assert.ok(html.includes('diagnostics-live-extra.js'));
  assert.equal(manifest.version_name, '0.11.13-build5-live-pipeline');
});

test('owner dev guard requires explicit ownerDevMode and never infers bypass from unpacked install type', () => {
  const source = read('src/background-dev-owner.js');
  assert.match(source, /settings\?\.ownerDevMode === true/);
  assert.doesNotMatch(source, /!chrome\.runtime\.getManifest\(\)\.update_url/);
  assert.match(source, /status: 'active'/);
  assert.match(source, /plan: 'OWNER_DEV'/);
  assert.match(source, /chrome\.storage\?\.onChanged/);
});

test('local clock projector is disabled so only CasaTrade can authorize M1 timing', () => {
  const source = read('src/content/market-clock-projector.js');
  assert.match(source, /enabled: false/);
  assert.match(source, /authoritative-casatrade-clock-only/);
  assert.doesNotMatch(source, /type:\s*['"]ATS_MARKET_CLOCK_V2['"]/);
  assert.doesNotMatch(source, /exact-local-projector/);
  assert.doesNotMatch(source, /setInterval/);
});

test('live diagnostic reports overlay, Gemini/token state and platform timing without leaking token value', () => {
  const source = read('src/sidepanel/diagnostics-live-extra.js');
  assert.match(source, /clientTokenPresent/);
  assert.match(source, /overlayEnabled/);
  assert.match(source, /platformControls/);
  assert.match(source, /clockFresh/);
  assert.doesNotMatch(source, /clientToken:\s*local\.atsClientToken/);
});
