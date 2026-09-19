import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { processSnapshot, resetOrchestrator } from '../src/core/orchestrator.js';
import { bullishAPlusRows, snapshotFor, minute } from './helpers/current-a-plus-fixtures.mjs';

const read = path => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('asset readers normalize pair and named OTC CasaTrade instruments', () => {
  const focus = read('src/content/focused-asset-v2.js');
  const session = read('src/background-market-session.js');
  assert.match(focus, /compactFxRe/);
  assert.match(focus, /function namedChartAsset/);
  assert.match(focus, /AMBIGUOUS_NAMED/);
  assert.match(session, /compact\.endsWith\(quote\)/);
  assert.match(session, /named OTC instruments/);
  assert.match(session, /signal: null/);
  assert.match(session, /currentCandle: null/);
});

test('connection recovery does not fail early when runtime injection is healthy', () => {
  const control = read('src/background-control.js');
  const shell = read('src/sidepanel/ui-shell-v2.js');
  assert.match(control, /CONNECT_TIMEOUT_MS = 7000/);
  assert.match(control, /runtimeInjectionHealthy\(current\)/);
  assert.match(control, /recoverFocusedAsset\(tabId\)/);
  assert.match(control, /finalConnectionCheck/);
  assert.match(control, /Falha ao confirmar o ativo ao vivo/);
  assert.match(shell, /FALHA AO CONECTAR/);
  assert.match(shell, /CONECTADO/);
});

test('countdown and operation expiration plan remain separate', () => {
  const clock = read('src/content/market-cycle-clock-v4.js');
  const app = read('src/sidepanel/app-v2.js');
  const html = read('src/sidepanel/index.html');
  assert.match(clock, /if \(expirySemantic && !candleSemantic\) continue/);
  assert.match(clock, /const rolloverWindow =/);
  assert.match(app, /function projectedRemaining/);
  assert.match(app, /requiredExpirationForTimeframe/);
  assert.match(html, /id="heroCountdown"/);
  assert.match(html, /id="heroExpirationPlan"/);
});

test('live quote path populates observed OHLC and recovery remains centralized', () => {
  const session = read('src/background-market-session.js');
  const background = read('src/background.js');
  const chart = read('src/content/chart-frame-market-reader.js');
  assert.match(session, /function observedCurrentCandle/);
  assert.match(session, /source: 'live-price-observed'/);
  assert.match(session, /openReliable: false, rangeReliable: false/);
  assert.match(background, /RECOVERY_AFTER_MS = 4500/);
  assert.match(background, /Recuperando leitura real/);
  assert.match(chart, /setInterval\(tick, 400\)/);
});

test('primary UI exposes one A+ score and one collapsed advanced section', () => {
  const html = read('src/sidepanel/index.html');
  assert.equal((html.match(/<details[^>]*class="advanced-panel"/g) || []).length, 1);
  assert.match(html, /ANÁLISE A\+ • ALTA CONFIANÇA/);
  assert.match(html, /id="technicalConfidence"/);
  assert.match(html, /AVANÇADO ▸/);
  assert.doesNotMatch(html, /id="signalScore"/);
  assert.doesNotMatch(html, /id="timeSyncStatus"/);
});

test('Gemini is final-only and never replaces the technical owner', () => {
  const ai = read('src/background-ai-analysis.js');
  assert.match(ai, /ENTER_BUY/);
  assert.match(ai, /ENTER_SELL/);
  assert.match(ai, /decision\?\.actionable === true/);
  assert.doesNotMatch(ai, /if \(ui === 'POSSIBLE_BUY'/);
});

test('runtime has one technical signal writer and reconnect clears stale handshake errors', () => {
  const entry = read('src/background-entry.js');
  const control = read('src/background-control.js');
  assert.match(entry, /import '.\/background\.js';/);
  assert.doesNotMatch(entry, /background-fast-decision\.js/);
  assert.match(control, /delete diagnostics\.connectionError/);
});

test('observed OHLC remains attached to one market cycle instead of frame handoff identity', () => {
  const session = read('src/background-market-session.js');
  const background = read('src/background.js');
  assert.match(session, /const closeAt = secondsRemaining == null \? null/);
  assert.match(session, /closeAt, available: true/);
  const start = background.indexOf('const marketKey = [');
  const end = background.indexOf("].join('|');", start);
  assert.doesNotMatch(background.slice(start, end), /frameId|frameHost/);
});

test('three consecutive M1 candles get distinct decision cycles and do not inherit a stale lock', () => {
  resetOrchestrator();
  const base = Math.floor(1_706_000_000_000 / minute) * minute;
  const keys = [];
  for (let i = 0; i < 3; i += 1) {
    const bucket = base + i * minute;
    const rows = bullishAPlusRows(bucket);
    const out = processSnapshot(snapshotFor(bucket, 10_000, { rows, secondsRemaining: 50 }), { connection: 'online' });
    keys.push(out.decisionCycle.key);
    assert.equal(out.decisionCycle.locked, null);
  }
  assert.equal(new Set(keys).size, 3);
});

test('current A+ fixture can progress BUILDING -> POSSIBLE -> ENTER', () => {
  resetOrchestrator();
  const bucket = Math.floor(1_707_000_000_000 / minute) * minute;
  const rows = bullishAPlusRows(bucket);
  const building = processSnapshot(snapshotFor(bucket, 35_000, { rows, secondsRemaining: 25 }), { connection: 'online' });
  const possible = processSnapshot(snapshotFor(bucket, 36_000, { rows, secondsRemaining: 24 }), { connection: 'online', ...building });
  const firstFinal = processSnapshot(snapshotFor(bucket, 51_000, { rows, secondsRemaining: 9 }), { connection: 'online', ...possible });
  const confirmed = processSnapshot(snapshotFor(bucket, 52_000, { rows, secondsRemaining: 8 }), { connection: 'online', ...firstFinal });

  assert.equal(building.signal.uiState, 'BUILDING_PATTERN');
  assert.equal(possible.signal.uiState, 'POSSIBLE_BUY');
  assert.notEqual(firstFinal.signal.state, 'CONFIRM');
  assert.equal(confirmed.signal.uiState, 'ENTER_BUY');
  assert.equal(confirmed.decisionCycle.locked, 'ENTER');
});
