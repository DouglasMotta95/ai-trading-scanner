import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { processSnapshot, resetOrchestrator } from '../src/core/orchestrator.js';

const read = path => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const minute = 60_000;
const aPlusBullishRows = bucket => Array.from({ length: 40 }, (_, index) => {
  const offset = 39 - index;
  const open = 1 + index * .002;
  const close = open + .0016;
  return { time: bucket - offset * minute, open, high: close + .00045, low: open - .00035, close, timeframe: 'M1' };
});

function bullishRows(bucket) { return aPlusBullishRows(bucket); }

function snap(bucket, elapsed, remaining) {
  const rows = bullishRows(bucket);
  return {
    platformId: 'casatrade', platformName: 'CasaTrade', connection: 'online',
    asset: 'AUD/CAD (OTC)', price: rows.at(-1).close,
    timeframe: 'M1', analysisTimeframe: 'M1',
    expiration: '60s', targetExpiration: '60s',
    serverTime: bucket + elapsed, secondsRemaining: remaining, candles: rows,
    capabilities: { structuredQuotes: true, candles: true }
  };
}

test('asset readers normalize direct, compact and OTC CasaTrade instruments', () => {
  const standalone = read('src/content/standalone-instrument-probe.js');
  const focus = read('src/content/focused-asset-v2.js');
  const session = read('src/background-market-session.js');

  assert.match(standalone, /AUDCAD|compact|endsWith\(quote\)/);
  assert.match(standalone, /USDT','USD','EUR','GBP','JPY','CAD','AUD','CHF','NZD','BTC','ETH/);
  assert.match(focus, /compactFxRe/);
  assert.match(session, /compact\.endsWith\(quote\)/);
  assert.match(session, /marketHistory: \{\}/);
  assert.match(session, /signal: null/);
  assert.match(session, /currentCandle: null/);
});

test('connection handshake times out instead of remaining in indefinite syncing state', () => {
  const control = read('src/background-control.js');
  const shell = read('src/sidepanel/ui-shell-v2.js');

  assert.match(control, /CONNECT_TIMEOUT_MS = 7000/);
  assert.match(control, /handshakeReady/);
  assert.match(control, /rows\.length >= 10/);
  assert.match(shell, /rows\.length >= 10/);
  assert.match(control, /Falha ao conectar — tentar novamente/);
  assert.match(shell, /CONECTADO/);
  assert.match(shell, /DESCONECTADO/);
  assert.doesNotMatch(shell, /setBadge\('connectionBadge', 'SINCRONIZANDO'/);
});

test('countdown and expiration remain separate and rollover is explicitly guarded', () => {
  const clock = read('src/content/market-cycle-clock-v4.js');
  const expiration = read('src/content/casatrade-expiration-probe.js');
  const app = read('src/sidepanel/app-v2.js');

  assert.match(clock, /if \(expirySemantic && !candleSemantic\) continue/);
  assert.match(clock, /const rolloverWindow =/);
  assert.match(clock, /row\.seconds >= limit - 2/);
  assert.match(expiration, /\\d\\{1,4\\}.*s\\|seg/);
  assert.match(expiration, /minuto/);
  assert.match(app, /function projectedRemaining/);
  assert.match(app, /setInterval\(\(\) => \{/);
});

test('live quote path populates real observed OHLC and recovers missing readers', () => {
  const session = read('src/background-market-session.js');
  const background = read('src/background.js');
  const chart = read('src/content/chart-frame-market-reader.js');

  assert.match(session, /function observedCurrentCandle/);
  assert.match(session, /source: 'live-price-observed'/);
  assert.match(session, /openReliable: false, rangeReliable: false/);
  assert.match(background, /RECOVERY_AFTER_MS = 4500/);
  assert.match(background, /rows\.length < 10/);
  assert.match(background, /Recuperando leitura real/);
  assert.match(chart, /setInterval\(tick, 400\)/);
});

test('primary UI has one stable technical score and one collapsed advanced section', () => {
  const html = read('src/sidepanel/index.html');
  assert.equal((html.match(/<details[^>]*class="advanced-panel"/g) || []).length, 1);
  assert.match(html, /ANÁLISE TÉCNICA/);
  assert.match(html, /id="technicalConfidence"/);
  assert.match(html, /id="timeSyncStatus"/);
  assert.doesNotMatch(html, /GATILHO TÉCNICO/);
  assert.doesNotMatch(html, /id="signalScore"/);
  assert.match(html, /AVANÇADO ▸/);
  assert.match(html, /boot-guard\.js/);
});

test('Gemini is final-only and never starts on POSSIBLE', () => {
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

test('observed OHLC stays anchored to one CasaTrade candle close', () => {
  const session = read('src/background-market-session.js');
  assert.match(session, /const closeAt = secondsRemaining == null \? null/);
  assert.match(session, /closeAt, available: true/);
  assert.match(session, /Math\.round\(closeAt \/ 5000\) \* 5000/);
});

test('three consecutive M1 candles get distinct decision cycles and do not inherit a stale lock', () => {
  resetOrchestrator();
  const base = Math.floor(1_706_000_000_000 / minute) * minute;
  const keys = [];
  for (let i = 0; i < 3; i += 1) {
    const bucket = base + i * minute;
    const out = processSnapshot(snap(bucket, 10_000, 50), { connection: 'online' });
    keys.push(out.decisionCycle.key);
    assert.equal(out.decisionCycle.locked, null);
  }
  assert.equal(new Set(keys).size, 3);
});

test('five simulated minutes allow AGUARDAR/POSSIBLE to reach ENTER when a valid pattern exists', () => {
  resetOrchestrator();
  const base = Math.floor(1_707_000_000_000 / minute) * minute;
  const states = [];
  let confirmed = null;

  for (let i = 0; i < 5; i += 1) {
    const bucket = base + i * minute;
    const first = processSnapshot(snap(bucket, 50_000, 10), { connection: 'online' });
    states.push(first.signal?.uiState);
    const second = processSnapshot(snap(bucket, 51_000, 9), { connection: 'online', ...first });
    states.push(second.signal?.uiState);
    if (second.signal?.state === 'CONFIRM') { confirmed = second; break; }
  }

  assert.ok(states.some(value => value === 'DECIDING' || String(value || '').startsWith('POSSIBLE_') || value === 'WAIT'));
  assert.ok(confirmed, `expected a confirmed entry within simulated 5 minutes; states=${states.join(',')}`);
  assert.match(confirmed.signal.uiState, /^ENTER_(BUY|SELL)$/);
  assert.equal(confirmed.decisionCycle.locked, 'ENTER');
});
