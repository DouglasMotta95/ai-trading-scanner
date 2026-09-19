import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mergeRadarSnapshot, marketId } from '../src/core/asset-radar.js';
import { assessEntryConfidence } from '../src/core/entry-confidence.js';
import { shadowMetrics } from '../src/core/shadow-calibration.js';

const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const candle = (open, close, pad = .0004) => ({ open, high: Math.max(open, close) + pad, low: Math.min(open, close) - pad, close });

test('radar ranks observed assets but never marks a non-opened market actionable', () => {
  const payload = {
    candidates: [
      { asset: 'GBP/USD (OTC)', price: 1.25, selected: true, confidence: 90 },
      { asset: 'EUR/USD', price: 1.10, selected: false, confidence: 80 }
    ],
    recentCandles: {
      'GBP/USD (OTC)': [candle(1.20,1.21),candle(1.21,1.22),candle(1.22,1.23),candle(1.23,1.24),candle(1.24,1.25)],
      'EUR/USD': [candle(1.10,1.101),candle(1.101,1.102),candle(1.102,1.103),candle(1.103,1.104)]
    }
  };
  const snapshot = mergeRadarSnapshot({}, payload, 'GBP/USD (OTC)', 1000);
  assert.equal(snapshot.rows.length, 2);
  assert.equal(snapshot.rows.find(row => row.asset === 'GBP/USD (OTC)')?.focused, true);
  assert.equal(snapshot.rows.find(row => row.asset === 'EUR/USD')?.actionable, false);
  assert.equal(snapshot.rows.every(row => row.actionable === false), true);
});

test('radar identity keeps OTC separate from the regular market', () => {
  assert.notEqual(marketId('EUR/USD'), marketId('EUR/USD (OTC)'));
  assert.equal(marketId('eur_usd otc'), 'EUR/USD (OTC)');
});

test('entry confidence is technical and does not pretend to be calibrated probability', () => {
  const state = {
    asset: 'GBP/USD',
    candles: [candle(1,1.01),candle(1.01,1.02),candle(1.02,1.03),candle(1.03,1.04)],
    currentCandle: candle(1.04,1.05),
    signal: {
      uiState: 'POSSIBLE_BUY', analysisDirection: 'BUY', analysisScore: 66,
      analytics: { buyPower: 72, sellPower: 28, currentStrength: 74, momentumScore: 70, continuationScore: 68, rejectionStrength: 52 }
    }
  };
  const confidence = assessEntryConfidence(state);
  assert.ok(confidence.score >= 60);
  assert.equal(confidence.calibratedProbability, null);
  assert.match(confidence.note, /não representa probabilidade estatística/i);
});

test('validation reports real entry performance, skipped opportunities and breakdowns', () => {
  const rows = [
    { decision:'ENTER', result:'WIN', asset:'EUR/USD', setup:'breakout' },
    { decision:'ENTER', result:'LOSS', asset:'EUR/USD', setup:'breakout', outcomeReason:'ROMPIMENTO FALHOU' },
    { decision:'ENTER', result:'WIN', asset:'GBP/USD (OTC)', setup:'rejection' },
    { decision:'SKIP', result:'WIN', asset:'GBP/USD', setup:'continuation' },
    { decision:'SKIP', result:'LOSS', asset:'GBP/USD', setup:'continuation' }
  ];
  const metrics = shadowMetrics(rows);
  assert.equal(metrics.entries, 3);
  assert.equal(metrics.entryWins, 2);
  assert.equal(metrics.entryLosses, 1);
  assert.equal(metrics.skippedWouldWin, 1);
  assert.equal(metrics.skippedWouldLose, 1);
  assert.ok(metrics.byAsset.length >= 2);
  assert.ok(metrics.bySetup.length >= 2);
  assert.equal(metrics.lossesByReason[0].reason, 'ROMPIMENTO FALHOU');
});

test('compact sidepanel keeps the decision surface and intentionally omits legacy radar/validation panels', () => {
  const html = read('src/sidepanel/index.html');
  const shell = read('src/sidepanel/ui-shell-v2.js');
  for (const id of ['connectScanner','syncStrip','triggerCard','technicalConfidence']) assert.match(html, new RegExp(`id="${id}"`));
  assert.doesNotMatch(html, /id="assetRadarList"/);
  assert.doesNotMatch(html, /id="validationWinRate"/);
  assert.match(shell, /ATS_CONNECT_ACTIVE_TAB/);
});

test('service worker wires radar without replacing the single market authority', () => {
  const entry = read('src/background-entry.js');
  const radar = read('src/background-asset-radar.js');
  assert.match(entry, /background-market-session\.js/);
  assert.match(entry, /background-asset-radar\.js/);
  assert.match(radar, /ATS_EMBEDDED_FEED/);
  assert.match(radar, /ATS_GET_ASSET_RADAR/);
  assert.doesNotMatch(radar, /processSnapshot|updateScannerState/);
});
