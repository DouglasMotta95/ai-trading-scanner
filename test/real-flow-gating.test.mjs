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

test('market connection restores or validates cached license before rejecting access', () => {
  const background = read('src/background.js');
  const augment = read('src/background-augment.js');
  const panel = read('src/sidepanel/app.js');

  const connect = section(background, 'async function connectActiveTab()', 'function scanCasaTradeFrame');
  assert.match(connect, /restoreCachedLicense\(\)/);
  assert.match(connect, /syncLicense\(settings, scannerState, true\)/);
  assert.match(connect, /NON_RESTORABLE_LICENSE_STATUSES/);
  const restoreIndex = connect.indexOf('restoreCachedLicense()');
  const finalGateIndex = connect.lastIndexOf('if (!licenseActive(scannerState.license))');
  assert.ok(restoreIndex >= 0 && restoreIndex < finalGateIndex);
  assert.ok(finalGateIndex < connect.indexOf('injectReaders(tab.id)'));

  const apply = section(background, 'async function applySnapshot', 'async function directScanActiveTab');
  assert.match(apply, /licenseRequired\(settings\) && !licenseActive\(scannerState\.license\)/);
  assert.ok(apply.indexOf('!licenseActive(scannerState.license)') < apply.indexOf('processSnapshot(enriched, candidate)'));
  assert.match(apply, /updateScannerState\(async scannerState =>/);

  assert.match(augment, /if \(settings\.runtimePaused\) return;/);
  assert.match(augment, /updateScannerState\(scannerState => \{[\s\S]*?if \(!licenseActive\(scannerState\)\) return;/);
  assert.match(panel, /if \(reconnectBusy \|\| !licenseStillValid\(lastState\.license\)\) return;/);
  assert.match(panel, /Nenhum dado de mercado é analisado antes da licença ficar ATIVA/);
});

test('completed decisions persist in local storage but are scoped to the browser session', () => {
  const background = read('src/background.js');
  const orchestrator = read('src/core/orchestrator.js');

  assert.match(background, /COMPLETED_DECISIONS_KEY = 'atsCompletedDecisions'/);
  assert.match(background, /RUNTIME_SESSION_KEY = 'atsRuntimeSessionId'/);
  assert.match(background, /chrome\.storage\.session\.get\(RUNTIME_SESSION_KEY\)/);
  assert.match(background, /chrome\.storage\.local\.get\(COMPLETED_DECISIONS_KEY\)/);
  assert.match(background, /\[COMPLETED_DECISIONS_KEY\]: \{ sessionId, rows, updatedAt: Date\.now\(\) \}/);
  assert.match(background, /restoreCompletedDecisions\(cached\.rows\)/);
  assert.match(background, /serializeCompletedDecisions\(\)/);
  assert.match(background, /await ensureCompletedDecisionCache\(\)/);
  assert.match(background, /await persistCompletedDecisionCache\(\)\.catch/);
  assert.match(orchestrator, /export function serializeCompletedDecisions/);
  assert.match(orchestrator, /export function restoreCompletedDecisions/);
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

test('analysis prioritizes reliable focused CasaTrade asset and allows safe corroborated fallback', () => {
  const focus = read('src/content/focused-asset.js');
  const generic = read('src/content/generic-adapter.js');
  const augment = read('src/background-augment.js');
  const background = read('src/background.js');

  assert.match(focus, /globalThis\.__ATS_FOCUSED_ASSET_META__ =/);
  assert.match(focus, /const reliable = Number\(candidate\.score \|\| 0\) >= RELIABLE_SCORE/);
  assert.match(focus, /candidateSamples >= CONSISTENT_SAMPLES/);
  assert.match(focus, /if \(reliable \|\| sameAsset\(previousGlobal, candidate\.asset\)\)/);
  assert.match(focus, /globalThis\.__ATS_FOCUSED_ASSET_VALUE__ = candidate\.asset/);

  assert.match(generic, /explicitFocus = canonicalAsset\(globalThis\.__ATS_FOCUSED_ASSET_VALUE__/);
  assert.match(generic, /const focusMeta = globalThis\.__ATS_FOCUSED_ASSET_META__ \|\| \{\}/);
  assert.match(generic, /const focusSupported = !!explicitFocus/);
  assert.match(generic, /const anyNetwork = bestNetworkQuote\(''\)/);

  assert.match(augment, /const FOCUS_STABLE_MS = 2000/);
  assert.match(augment, /const FOCUS_CHANGE_MIN_SCORE = 70/);
  assert.match(augment, /return updateScannerState\(scannerState =>/);
  assert.match(augment, /const focusedCandidate = focus \? chooseCandidate\(payload, focus\) : null/);
  assert.match(augment, /const fallbackCandidate = focusedCandidate \|\| chooseCandidate\(payload, ''\)/);

  assert.match(background, /resolveMarketEvidence\(snapshot, scannerState/);
  assert.match(background, /const next = await updateScannerState\(async scannerState =>/);
  assert.match(background, /function evidenceFocusGate\(/);
  assert.match(background, /return marketHistoryFor\(state, asset\)/);
});
