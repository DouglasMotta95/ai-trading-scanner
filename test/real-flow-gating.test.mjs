import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

function section(source, start, end) {
  const a = source.indexOf(start);
  const b = source.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, `missing section ${start}`);
  return source.slice(a, b);
}

test('market connection and analysis are hard-gated by an active license', () => {
  const background = read('src/background.js');
  const augment = read('src/background-augment.js');
  const panel = read('src/sidepanel/app.js');

  const connect = section(background, 'async function connectActiveTab()', 'function scanCasaTradeFrame');
  assert.match(connect, /if \(!licenseActive\(scannerState\.license\)\)/);
  assert.ok(connect.indexOf('licenseActive(scannerState.license)') < connect.indexOf('injectReaders(tab.id)'));

  const apply = section(background, 'async function applySnapshot', 'async function directScanActiveTab');
  assert.match(apply, /licenseRequired\(settings\) && !licenseActive\(scannerState\.license\)/);
  assert.ok(apply.indexOf('!licenseActive(scannerState.license)') < apply.indexOf('processSnapshot(enriched, next)'));

  assert.match(augment, /if \(!licenseActive\(scannerState\) \|\| settings\.runtimePaused\) return;/);
  assert.match(panel, /if \(reconnectBusy \|\| !licenseStillValid\(lastState\.license\)\) return;/);
  assert.match(panel, /Nenhum dado de mercado é analisado antes da licença ficar ATIVA/);
});

test('activation only clears the key after a genuinely active response', () => {
  const panel = read('src/sidepanel/app.js');
  const activation = section(panel, "$('activateLicense')?.addEventListener", 'async function prepare');
  assert.match(activation, /const activated = !!result\?\.ok && licenseStillValid\(result\?\.license\)/);
  assert.match(activation, /if \(activated\)[\s\S]*?input\.value = ''/);
  assert.match(activation, /licenseErrorText\(result\?\.error\)/);
  const failureBranch = activation.slice(activation.indexOf('} else {'));
  assert.doesNotMatch(failureBranch, /input\.value\s*=/);
});

test('analysis is locked to the focused CasaTrade asset and waits for focus stability', () => {
  const focus = read('src/content/focused-asset.js');
  const generic = read('src/content/generic-adapter.js');
  const augment = read('src/background-augment.js');
  const background = read('src/background.js');

  assert.match(focus, /__ATS_FOCUSED_ASSET_VALUE__ = asset/);
  assert.match(generic, /explicitFocus = canonicalAsset\(globalThis\.__ATS_FOCUSED_ASSET_VALUE__/);
  assert.match(generic, /if \(!matching\.length\) return null;/);
  assert.match(generic, /const priceRows = \(asset \? sameAssetRows : rows\)/);

  assert.match(augment, /const FOCUS_STABLE_MS = 2000/);
  assert.match(augment, /stableSince/);
  assert.match(augment, /Date\.now\(\) - stableSince < FOCUS_STABLE_MS/);
  assert.match(augment, /resetOrchestrator\(\)/);

  assert.match(background, /const matchedRows = focus \? rows\.filter\(x => sameAsset\(x\.asset, focus\)\) : \[\]/);
  assert.match(background, /focusStableFor\(scannerState, focus\)/);
});
