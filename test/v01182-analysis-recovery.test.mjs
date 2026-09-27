import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { exactCasaTradeTime } from '../src/background-decision-policy.js';

const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');

function baseState() {
  return {
    asset: 'EUR/USD (OTC)',
    price: 1.12788,
    lastSeen: Date.now(),
    analysisTimeframe: 'M1',
    currentCandle: {
      asset: 'EUR/USD (OTC)',
      time: Math.floor(Date.now() / 60000) * 60000,
      open: 1.1277,
      high: 1.1281,
      low: 1.1276,
      close: 1.12788
    },
    diagnostics: {
      focusedAsset: {
        asset: 'EUR/USD (OTC)',
        reliable: true,
        chartScoped: true,
        trustedChartFrame: true,
        visualAuthority: true,
        embeddedTrader: true,
        at: Date.now(),
        frameId: 7,
        frameHost: 'trade.casatrade.com'
      }
    },
    signal: {
      secondsRemaining: 15,
      currentCandle: null
    },
    analystPreferences: {
      operationMode: 'M1'
    }
  };
}

test('v0.11.82: exact CasaTrade time remains authoritative', () => {
  const state = baseState();
  const now = Date.now();
  state.diagnostics.marketClock = {
    asset: state.asset,
    timeframe: 'M1',
    secondsRemaining: 15,
    verified: true,
    available: true,
    role: 'candle-close',
    source: 'trader-dom-countdown',
    at: now,
    frameId: 7,
    frameHost: 'trade.casatrade.com'
  };
  const result = exactCasaTradeTime(state);
  assert.equal(result.ready, true);
  assert.equal(result.authoritative, true);
  assert.equal(result.source, 'trader-dom-countdown');
});

test('v0.11.82: missing exact clock does not stop technical timing analysis', () => {
  const state = baseState();
  const result = exactCasaTradeTime(state);
  assert.equal(result.ready, true);
  assert.equal(result.authoritative, false);
  assert.equal(result.source, 'derived-candle-boundary');
  assert.ok(result.secondsRemaining > 0 && result.secondsRemaining <= 60);
});

test('v0.11.82: policy never promotes a derived clock directly to actionable entry', () => {
  const policy = read('src/background-decision-policy.js');
  assert.match(policy, /time\.authoritative !== true/);
  assert.match(policy, /actionable: false/);
  assert.match(policy, /countdown exato da CasaTrade/);
});

test('v0.11.82: technical score is independent from exact timing presentation', () => {
  const guidance = read('src/sidepanel/signal-guidance-ui.js');
  assert.match(guidance, /function analysisReady\(state = \{\}\) \{[\s\S]*return marketReady\(state\);/);
  assert.doesNotMatch(guidance, /O score só aparece depois de/);
});

test('v0.11.82: direct DOM expiration probe can pair separated visible label and value', () => {
  const control = read('src/background-control.js');
  assert.match(control, /renderedExpirationRows/);
  assert.match(control, /rendered-label-pair/);
  assert.match(control, /const labels = renderedRows\.filter/);
});

test('v0.11.82: build versions are aligned', () => {
  const manifest = JSON.parse(read('manifest.json'));
  const root = JSON.parse(read('package.json'));
  const backend = JSON.parse(read('backend/package.json'));
  assert.equal(manifest.version, '0.11.82');
  assert.equal(manifest.version_name, '0.11.82-casatrade-analysis-recovery');
  assert.equal(root.version, '0.11.82');
  assert.equal(backend.version, '0.11.82');
  assert.match(read('backend/src/server.js'), /const VERSION = '0\.11\.82'/);
  assert.match(read('backend/src/server.js'), /EXTENSION_LATEST_VERSION = String\(process\.env\.EXTENSION_LATEST_VERSION \|\| '0\.11\.82'\)/);
});
