import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');

test('simple flow no longer blocks decisions on expiration', () => {
  const policy = read('src/background-decision-policy.js');
  const start = policy.indexOf('function baseDecision');
  const end = policy.indexOf('\nfunction signature', start);
  const block = policy.slice(start, end);
  assert.doesNotMatch(block, /CasaTradeExpiration\(/);
  assert.match(block, /expirationReady: true/);
  assert.match(block, /Single authority rule/);
  assert.doesNotMatch(block, /score >= possibleScore/);
});

test('orchestrator latches POSSÍVEL for the candle instead of dropping to AGUARDAR on weak ticks', () => {
  const orchestrator = read('src/core/orchestrator.js');
  assert.match(orchestrator, /function observeStablePossible\(/);
  assert.match(orchestrator, /Once published, a POSSÍVEL direction is sticky for the rest of this candle/);
  assert.match(orchestrator, /POSSIBLE_CONFIRM_HITS = 2/);
  assert.match(orchestrator, /OPPOSITE_SWITCH_HITS = 3/);
  assert.match(orchestrator, /OPPOSITE_SCORE_MARGIN = 8/);
  assert.match(orchestrator, /stableDirection\s*\?\s*possibleSignal/);
});

test('opposite direction cannot replace current candidate without sustained stronger evidence', () => {
  const orchestrator = read('src/core/orchestrator.js');
  const start = orchestrator.indexOf('function observeStablePossible');
  const end = orchestrator.indexOf('\nfunction seedCycle', start);
  const block = orchestrator.slice(start, end);
  assert.match(block, /cycle\.oppositeHits >= OPPOSITE_SWITCH_HITS/);
  assert.match(block, /strongerByMargin \|\| replacesStaleCandidate/);
  assert.match(block, /rawScore >= Math\.max\(ANALYST_THRESHOLDS\.confirmScore, Number\(cycle\.possibleScore/);
});

test('final entry windows are calibrated separately for M1 and M5', () => {
  const orchestrator = read('src/core/orchestrator.js');
  assert.match(orchestrator, /timeframe === 'M1'.*decision: 10/);
  assert.match(orchestrator, /timeframe === 'M5'.*decision: 20/);
  assert.match(orchestrator, /secondsRemaining > windows\.decision/);
});

test('sidepanel shows expiration as operation plan without restoring old expiration gate', () => {
  const html = read('src/sidepanel/index.html');
  const policy = read('src/background-decision-policy.js');
  assert.match(html, /id="operatingTimeframe"/);
  assert.match(html, /id="heroExpirationPlan"/);
  assert.match(html, /M5 • expiração 5 min/);
  const start = policy.indexOf('function baseDecision');
  const end = policy.indexOf('\nfunction signature', start);
  assert.doesNotMatch(policy.slice(start, end), /CasaTradeExpiration\(/);
});

test('connection shell never falls back to EXPIRAÇÃO PENDENTE', () => {
  const shell = read('src/sidepanel/ui-shell-v2.js');
  const start = shell.indexOf('function renderShell');
  const end = shell.indexOf('\nasync function connectNow', start);
  const block = shell.slice(start, end);
  assert.doesNotMatch(block, /EXPIRAÇÃO PENDENTE/);
  assert.doesNotMatch(block, /AJUSTE A EXPIRAÇÃO/);
  assert.match(block, /CONECTADO — ANALISANDO SINAL/);
});

test('all user-facing decision cards consume the orchestrator signal instead of reclassifying by score', () => {
  const app = read('src/sidepanel/app-v2.js');
  const guidance = read('src/sidepanel/signal-guidance-ui.js');
  const appStart = app.indexOf('function decisionModel');
  const appEnd = app.indexOf('\nfunction setText', appStart);
  const appBlock = app.slice(appStart, appEnd);
  assert.match(appBlock, /const signal = state\.signal \|\| \{\}/);
  assert.doesNotMatch(appBlock, /score >= 44/);
  assert.match(guidance, /const signal = state\.signal \|\| \{\}/);
  assert.doesNotMatch(guidance, /const decision = state\.professionalDecision/);
});

test('manual entry readiness depends on final central signal and current asset', () => {
  const control = read('src/background-control.js');
  const start = control.indexOf('function exactTradeReady');
  const end = control.indexOf('\nasync function manualIntent', start);
  const block = control.slice(start, end);
  assert.match(block, /\['ENTER_BUY','ENTER_SELL'\]\.includes\(ui\)/);
  assert.match(block, /sameAsset\(focus\.asset, state\.asset\)/);
  assert.doesNotMatch(block, /professionalDecision/);
  const manualStart = control.indexOf('async function manualIntent');
  const manualEnd = control.indexOf('\nasync function setScanner', manualStart);
  assert.doesNotMatch(control.slice(manualStart, manualEnd), /professional_signal_not_confirmed/);
});

test('retry refreshes asset readers without running the expiration probe', () => {
  const control = read('src/background-control.js');
  const start = control.indexOf('async function refreshTargetTab');
  const end = control.indexOf('\nasync function connectActiveTab', start);
  const block = control.slice(start, end);
  assert.match(block, /injectModern\(tabId\)/);
  assert.match(block, /forceLiveControlRead\(tabId\)/);
  assert.doesNotMatch(block, /readAndCommitDirectExpiration/);
});

test('setup shown with POSSÍVEL is a technical setup, not merely market regime', () => {
  const orchestrator = read('src/core/orchestrator.js');
  assert.match(orchestrator, /function inferSetup\(/);
  assert.match(orchestrator, /return 'rejeição'/);
  assert.match(orchestrator, /return 'continuação'/);
  assert.match(orchestrator, /return 'momentum'/);
  assert.match(orchestrator, /setup: cycle\.setup \|\| signal\.setup \|\| null/);
});
