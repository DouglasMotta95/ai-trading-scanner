import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { assessAssetQuality } from '../src/core/asset-quality.js';

const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');

function candle(open, close, pad = 0.0004) {
  return { open, high: Math.max(open, close) + pad, low: Math.min(open, close) - pad, close };
}

function stateWith(candles, analytics = {}, extraSignal = {}) {
  return {
    asset: 'GBP/USD (OTC)',
    candles: candles.slice(0, -1),
    currentCandle: candles.at(-1),
    signal: {
      uiState: 'BUILDING_PATTERN',
      analysisDirection: 'BUY',
      analysisScore: 52,
      analytics,
      regime: { type: 'uptrend' },
      ...extraSignal
    }
  };
}

test('clean opened asset is rated good without changing the entry decision', () => {
  const candles = [
    candle(1.2000, 1.2020), candle(1.2020, 1.2042), candle(1.2042, 1.2065),
    candle(1.2065, 1.2090), candle(1.2090, 1.2118), candle(1.2118, 1.2148)
  ];
  const quality = assessAssetQuality(stateWith(candles, {
    buyPower: 72, sellPower: 28, currentStrength: 79,
    momentumDirection: 'BUY', momentumScore: 76,
    continuationDirection: 'BUY', continuationScore: 78,
    trendDirection: 'BUY', lossOfStrength: 12
  }));
  assert.equal(quality.status, 'GOOD');
  assert.equal(quality.tradable, true);
  assert.equal(quality.action, 'PROCURAR ENTRADA');
  assert.equal(quality.bias, 'COMPRADOR');
  assert.ok(quality.score >= 68);
});

test('sideways opened asset is explicitly rated poor so the user can move on', () => {
  const candles = [
    candle(1.2000, 1.2002, .0010), candle(1.2002, 1.1999, .0010),
    candle(1.1999, 1.2001, .0010), candle(1.2001, 1.1998, .0010),
    candle(1.1998, 1.2000, .0010), candle(1.2000, 1.1999, .0010)
  ];
  const quality = assessAssetQuality(stateWith(candles, {
    buyPower: 49, sellPower: 51, currentStrength: 12,
    momentumDirection: 'SELL', momentumScore: 15, trendDirection: null, lossOfStrength: 45
  }, { analysisDirection: null, regime: { type: 'range' } }));
  assert.equal(quality.status, 'POOR');
  assert.equal(quality.action, 'PROCURE OUTRO ATIVO');
  assert.equal(quality.tradable, false);
  assert.match(quality.context, /LATERAL|COMPRIMIDO/);
});

test('many green candles plus weakening is marked stretched, never auto-converted into a sell call', () => {
  const candles = [
    candle(1.1000, 1.1030), candle(1.1030, 1.1060), candle(1.1060, 1.1090),
    candle(1.1090, 1.1120), candle(1.1120, 1.1150), candle(1.1150, 1.1152, .0015)
  ];
  const quality = assessAssetQuality(stateWith(candles, {
    buyPower: 61, sellPower: 39, currentStrength: 18,
    momentumDirection: 'BUY', momentumScore: 52,
    continuationDirection: 'BUY', continuationScore: 48,
    trendDirection: 'BUY', lossOfStrength: 78
  }));
  assert.equal(quality.status, 'WATCH');
  assert.equal(quality.action, 'AGUARDAR GATILHO');
  assert.equal(quality.bias, 'COMPRADOR');
  assert.match(quality.label, /ALTA ESTICADA/);
  assert.match(quality.reason, /Não inverter só porque subiu\/caiu muito/);
});

test('side panel exposes opened-asset quality before the next-candle decision', () => {
  const html = read('src/sidepanel/index.html');
  const ui = read('src/sidepanel/asset-quality-ui.js');
  const quality = read('src/core/asset-quality.js');
  const qualityIndex = html.indexOf('id="assetQualityCard"');
  const decisionIndex = html.indexOf('id="decisionCard"');
  assert.ok(qualityIndex >= 0 && decisionIndex > qualityIndex);
  for (const id of ['assetQualityTitle','assetQualityBadge','assetQualityScore','assetQualityContext','assetQualityBias','assetQualityReason']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /type="module" src="asset-quality-ui\.js"/);
  assert.match(ui, /assessAssetQuality/);
  assert.match(ui, /ATS_READ_SCANNER_STATE/);
  assert.match(ui, /chrome\.storage\.onChanged/);
  assert.doesNotMatch(ui, /updateScannerState|processSnapshot/);
  assert.match(quality, /ATIVO BOM PARA TRABALHAR/);
  assert.match(quality, /PROCURE OUTRO ATIVO/);
  assert.match(quality, /ALTA ESTICADA/);
});
