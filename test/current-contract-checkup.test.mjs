import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { processSnapshot, resetOrchestrator } from '../src/core/orchestrator.js';

const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const manifest = JSON.parse(read('manifest.json'));
const minute = 60_000;

function aPlusHistory(bucket, count = 60, direction = 'BUY') {
  const sign = direction === 'SELL' ? -1 : 1;
  const rows = [];
  let price = 1.05;
  for (let i = count - 1; i >= 0; i -= 1) {
    const open = price;
    const close = open + sign * 0.0011;
    rows.push({
      time: bucket - i * minute,
      open,
      high: Math.max(open, close) + 0.00035,
      low: Math.min(open, close) - 0.00035,
      close,
      timeframe: 'M1'
    });
    price = close;
  }
  return rows;
}

function snap(bucket, seconds, rows, extra = {}) {
  const current = rows.at(-1);
  return processSnapshot({
    platformId: 'casatrade',
    asset: 'EUR/USD (OTC)',
    price: current.close,
    timeframe: 'M1',
    analysisTimeframe: 'M1',
    connection: 'online',
    serverTime: bucket + seconds * 1000,
    candles: rows,
    ...extra
  }, { connection: 'online' });
}

test('current manifest is the v0.11.50 M5 clock state stability build', () => {
  assert.equal(manifest.version, '0.11.50');
  assert.equal(manifest.version_name, '0.11.50-m5-clock-state-stability');
  assert.equal(manifest.manifest_version, 3);
});

test('runtime keeps one central market and signal owner', () => {
  const entry = read('src/background-entry.js');
  assert.match(entry, /background-market-session\.js/);
  assert.match(entry, /background\.js/);
  assert.doesNotMatch(entry, /background-fast-decision\.js/);
  assert.doesNotMatch(entry, /background-augment\.js/);
  assert.doesNotMatch(entry, /background-integrity\.js/);
});

test('current A+ contract supports M1 and M5 without a legacy NORMAL profile', () => {
  const html = read('src/sidepanel/index.html');
  const app = read('src/sidepanel/app-v2.js');
  const policy = read('src/background-decision-policy.js');
  assert.match(html, /id="operatingTimeframe"/);
  assert.match(html, /M1 • expiração 1 min/);
  assert.match(html, /M5 • expiração 5 min/);
  assert.match(app, /analystMode: 'A_PLUS'/);
  assert.match(policy, /mode: 'A_PLUS'/);
});

test('current UI keeps one principal next-candle decision and Gemini as second opinion', () => {
  const html = read('src/sidepanel/index.html');
  assert.equal((html.match(/id="decisionCard"/g) || []).length, 1);
  assert.match(html, /ANÁLISE A\+ • ALTA CONFIANÇA/);
  assert.match(html, /GEMINI • SEGUNDA LEITURA/);
  assert.match(html, /SEM EXECUÇÃO AUTOMÁTICA/);
});

test('current exact-time authority never authorizes entry from a local estimate', () => {
  const app = read('src/sidepanel/app-v2.js');
  const policy = read('src/background-decision-policy.js');
  for (const source of ['trader-dom-countdown', 'network-server-cycle']) {
    assert.match(app, new RegExp(source));
    assert.match(policy, new RegExp(source));
  }
  assert.match(app, /There is no operational fallback clock anymore/);
});

test('current connection recovery does not fail immediately when injection is healthy', () => {
  const control = read('src/background-control.js');
  assert.match(control, /runtimeInjectionHealthy\(current\)/);
  assert.match(control, /recoverFocusedAsset\(tabId\)/);
  assert.match(control, /stage: 'recovering_live_asset'/);
  assert.match(control, /finalConnectionCheck/);
});

test('current focus authority hard-resets operational state on market switch', () => {
  const session = read('src/background-market-session.js');
  assert.match(session, /clearMarketAuthorityState/);
  assert.match(session, /signal: null/);
  assert.match(session, /lastConfirmed: null/);
  assert.match(session, /tradeIntent: null/);
});

test('current expiration plan follows selected operation timeframe', () => {
  const control = read('src/background-control.js');
  const app = read('src/sidepanel/app-v2.js');
  assert.match(control, /expirationForOperatingTimeframe/);
  assert.match(app, /requiredExpirationForTimeframe/);
  assert.match(app, /'M1' \? '60s' : '300s'/);
});

test('mobile POSSIBLE hysteresis tolerates a 5-6 second throttled observation gap', () => {
  const orchestrator = read('src/core/orchestrator.js');
  assert.match(orchestrator, /POSSIBLE_HIT_GAP_MS = 8000/);
});

test('A+ candidate hysteresis requires two weak observations before hiding POSSIBLE', () => {
  const orchestrator = read('src/core/orchestrator.js');
  assert.match(orchestrator, /function observeStableAPlusCandidate/);
  assert.match(orchestrator, /cycle\.aPlusWeakHits >= 2/);
  assert.match(orchestrator, /stableAPlusCandidateAllowed/);
});

test('A+ fixture with sufficient history can progress beyond history warmup', () => {
  resetOrchestrator();
  const bucket = Math.floor(1_800_000_000_000 / minute) * minute;
  const rows = aPlusHistory(bucket);
  const first = snap(bucket, 35, rows);
  const second = snap(bucket, 41, rows);
  assert.notEqual(first.signal?.phase, 'HISTORY');
  assert.notEqual(second.signal?.phase, 'HISTORY');
  assert.ok(['BUILDING','POSSIBLE','FINAL'].includes(second.signal?.phase));
});

test('manual trade path remains confirmation-only and never executes CasaTrade automatically', () => {
  const background = read('src/background.js');
  const control = read('src/background-control.js');
  assert.doesNotMatch(background, /ATS_EXECUTE_TRADE/);
  assert.doesNotMatch(control, /ATS_EXECUTE_TRADE/);
  assert.match(control, /tradeIntent/);
});

test('diagnostics remain available without exposing authentication secrets', () => {
  const diag = read('src/sidepanel/diagnostics-export.js');
  assert.match(diag, /COPIAR DIAGNÓSTICO/);
  assert.doesNotMatch(diag, /GEMINI_API_KEY/);
});
