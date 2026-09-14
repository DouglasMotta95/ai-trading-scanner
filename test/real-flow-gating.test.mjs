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

  assert.match(augment, /if \(settings\.runtimePaused\) return;/);
  assert.match(augment, /updateScannerState\(scannerState => \{[\s\S]*?if \(!licenseActive\(scannerState\)\) return;/);
  assert.match(panel, /if \(reconnectBusy \|\| !licenseStillValid\(lastState\.license\)\) return;/);
  assert.match(panel, /ATIVAÇÃO NECESSÁRIA/);
  assert.match(panel, /Ative a licença para iniciar a análise/);
});

test('completed decisions persist in local storage but are scoped to the browser session', () => {
  const background = read('src/background.js');
  const orchestrator = read('src/core/orchestrator.js');

  assert.match(background, /COMPLETED_DECISIONS_KEY = 'atsCompletedDecisions'/);
  assert.match(background, /RUNTIME_SESSION_KEY = 'atsRuntimeSessionId'/);
  assert.match(background, /storageSessionGet\(RUNTIME_SESSION_KEY\)/);
  assert.match(background, /storageLocalGet\(COMPLETED_DECISIONS_KEY\)/);
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

test('focus stability remains a preference while the visible chart frame is authoritative', () => {
  const focus = read('src/content/focused-asset-v2.js');
  const generic = read('src/content/generic-adapter.js');
  const augment = read('src/background-augment.js');
  const background = read('src/background.js');
  const panel = read('src/sidepanel/app.js');

  assert.match(focus, /__ATS_FOCUSED_ASSET_META__/);
  assert.match(focus, /reliable: true/);
  assert.match(focus, /chartScoped: true/);
  assert.match(focus, /frameRole: 'trader-frame'/);
  assert.match(focus, /candidateSamples >= 2 && stableFor >= 220/);

  assert.match(generic, /const domChoice = bestDomAsset\(rows\)/);
  assert.match(generic, /const anyNetwork = bestNetworkQuote\(''\)/);
  assert.match(generic, /const focusSupported = focusFresh/);
  assert.doesNotMatch(generic, /if \(!explicitFocus\) return;/);

  assert.match(augment, /const FOCUS_STABLE_MS = 2000/);
  assert.match(augment, /const focusStable =/);
  assert.match(augment, /return updateScannerState\(scannerState =>/);
  assert.match(augment, /const frameMatchesFocus =/);
  assert.match(augment, /if \(!frameMatchesFocus\) return/);
  assert.match(augment, /const candidate = chooseCandidate\(payload, focus\)/);
  assert.match(augment, /if \(!candidate \|\| !sameAsset\(candidate\.asset, focus\)\) return/);
  assert.match(augment, /const clock = authoritativeClock\(scannerState, asset, sender\)/);
  assert.match(augment, /if \(!clock\) return base/);
  assert.doesNotMatch(augment, /Date\.now\(\) - stableSince < FOCUS_STABLE_MS\) return/);

  const apply = section(background, 'async function applySnapshot', 'async function directScanActiveTab');
  assert.match(apply, /resolveMarketEvidence\(snapshot, scannerState/);
  assert.match(apply, /stage: 'confirming_asset'/);
  assert.match(apply, /stage: 'reading_price'/);
  assert.match(apply, /connection: 'online'/);
  assert.match(apply, /const next = await updateScannerState\(async scannerState =>/);
  assert.match(apply, /processSnapshot\(enriched, candidate\)/);
  assert.match(apply, /requiredCandles: 2/);
  assert.doesNotMatch(apply, /const focusReady =/);

  assert.match(panel, /reading_history/);
  assert.match(panel, /analyzing_current/);
  assert.match(panel, /diagnosing_next_candle/);
  assert.match(panel, /function principalState/);
  assert.match(panel, /POSSÍVEL COMPRA/);
  assert.match(panel, /ENTRAR NA PRÓXIMA VELA: COMPRA/);
  assert.doesNotMatch(panel, /DIAGNÓSTICO: AGUARDAR/);
});
