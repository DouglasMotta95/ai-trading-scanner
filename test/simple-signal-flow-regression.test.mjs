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
  assert.match(block, /POSSIBLE_BUY/);
  assert.match(block, /seconds > 10/);
  assert.match(block, /ENTRAR AGORA/);
});

test('sidepanel removes expiration and Tempo CasaTrade as visible gates', () => {
  const html = read('src/sidepanel/index.html');
  assert.doesNotMatch(html, />EXPIRAÇÃO </);
  assert.doesNotMatch(html, /TEMPO CASATRADE/);
  assert.match(html, /ENTRADA FINAL <b>~10s<\/b>/);
  assert.match(html, /Pré-sinal primeiro; entrada final quando o padrão confirmar perto de 10s/);
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

test('manual entry readiness depends on final signal and current asset, not expiration', () => {
  const control = read('src/background-control.js');
  const start = control.indexOf('function exactTradeReady');
  const end = control.indexOf('\nasync function manualIntent', start);
  const block = control.slice(start, end);
  assert.match(block, /professional\.actionable !== true/);
  assert.match(block, /sameAsset\(focus\.asset, state\.asset\)/);
  assert.doesNotMatch(block, /actualExpiration/);
  assert.doesNotMatch(block, /expirationCheckedAt/);
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
