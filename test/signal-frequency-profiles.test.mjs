import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { getThresholds, getSignalPolicy, calculateEntryQuality } from '../src/core/analysis.js';

const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');

test('signal rhythm profiles are materially different', () => {
  const frequent = getSignalPolicy('SOLTO');
  const balanced = getSignalPolicy('MEDIO');
  const selective = getSignalPolicy('RIGIDO');

  assert.equal(frequent.label, 'MAIS SINAIS');
  assert.equal(balanced.label, 'EQUILIBRADO');
  assert.equal(selective.label, 'MAIS SELETIVO');

  assert.ok(frequent.possibleScore < balanced.possibleScore);
  assert.ok(balanced.possibleScore < selective.possibleScore);
  assert.ok(frequent.finalScore < balanced.finalScore);
  assert.ok(balanced.finalScore < selective.finalScore);
  assert.equal(frequent.possibleScore, 45);
  assert.equal(balanced.possibleScore, 52);
  assert.equal(selective.possibleScore, 58);
  assert.equal(frequent.finalScore, 50);
  assert.equal(balanced.finalScore, 55);
  assert.equal(selective.finalScore, 62);
  assert.equal(frequent.possiblePower, 45);
  assert.equal(balanced.possiblePower, 45);
  assert.equal(selective.possiblePower, 45);
  assert.equal(frequent.finalPower, 45);
  assert.equal(balanced.finalPower, 45);
  assert.equal(selective.finalPower, 45);
  assert.ok(frequent.minimumStructure < balanced.minimumStructure);
  assert.ok(balanced.minimumStructure < selective.minimumStructure);
});

test('entry floor is score + clear direction + directional power', () => {
  const analysis = read('src/core/analysis.js');
  const orchestrator = read('src/core/orchestrator.js');
  const policy = read('src/background-decision-policy.js');
  assert.match(analysis, /possiblePower: 45/);
  assert.match(analysis, /finalPower: 45/);
  assert.match(orchestrator, /score >= signalPolicy\.possibleScore/);
  assert.match(orchestrator, /power >= 45/);
  assert.match(policy, /score >= possibleScore/);
  assert.match(policy, /directionalPower >= 45/);
});

test('fixed 60/70 gate no longer overrides the selected rhythm', () => {
  const policy = read('src/background-decision-policy.js');
  const fast = read('src/core/live-fast-decision.js');
  assert.doesNotMatch(policy, /const HIGH_CONFIDENCE/);
  assert.doesNotMatch(fast, /const HIGH_CONFIDENCE/);
  assert.match(policy, /getSignalPolicy/);
  assert.match(fast, /getSignalPolicy/);
  assert.match(fast, /score >= signalPolicy\.finalScore/);
});

test('panel exposes user-facing rhythm names while keeping stored compatibility values', () => {
  const html = read('src/sidepanel/index.html');
  assert.match(html, /value="SOLTO">MAIS SINAIS/);
  assert.match(html, /value="MEDIO" selected>EQUILIBRADO/);
  assert.match(html, /value="RIGIDO">MAIS SELETIVO/);
  assert.match(html, /RÍGIDO: 58\/62|MÉDIO: 52\/55|SOLTO: 45\/50/i);
  const loose = getThresholds('SOLTO');
  assert.equal(loose.holdSeconds, 1);
});


test('possible candidate survives a short timing recheck without becoming actionable', () => {
  const policy = read('src/background-decision-policy.js');
  assert.match(policy, /if \(!time\.ready && previousPossible && technicalCoreStillReady\)/);
  assert.match(policy, /pré-sinal preservado enquanto a CasaTrade reconfirma o tempo/i);
  assert.match(policy, /actionable: false/);
});

test('panel keeps the live link through a short reader gap and uses directional colors for possible signals', () => {
  const app = read('src/sidepanel/app-v2.js');
  const shell = read('src/sidepanel/ui-shell-v2.js');
  const css = read('src/sidepanel/styles.css');
  assert.match(app, /const FOCUS_FRESH_MS = 12000/);
  assert.match(app, /tone: earlyDirection === 'BUY' \? 'possible-buy' : 'possible-sell'/);
  assert.match(app, /tone: possibleDirection === 'BUY' \? 'possible-buy' : 'possible-sell'/);
  assert.match(app, /tone: 'possible-buy'/);
  assert.match(app, /tone: 'possible-sell'/);
  assert.match(app, /POSSÍVEL COMPRA/);
  assert.match(app, /POSSÍVEL VENDA/);
  assert.match(shell, /sessionHeartbeat/);
  assert.match(shell, /dataFresh \|\| sessionHeartbeat \|\| exactClockAlive/);
  assert.match(css, /decision-banner\.possible-buy/);
  assert.match(css, /decision-banner\.possible-sell/);
  assert.match(css, /decision-card\.possible-buy/);
  assert.match(css, /decision-card\.possible-sell/);
});


test('network transport rotation does not clear the live market authority', () => {
  const session = read('src/background-market-session.js');
  assert.match(session, /network-context-rotated/);
  assert.doesNotMatch(session, /return clearMarketAuthorityState\(state, \{[\s\S]*network-context-change/);
  assert.match(session, /Keep the proven market session alive/);
  assert.match(session, /existingFocusFresh/);
  assert.match(session, /12000/);
});


test('next-candle pressure is an entry-only gate and does not replace signal thresholds', () => {
  const analysis = read('src/core/analysis.js');
  const orchestrator = read('src/core/orchestrator.js');
  const fast = read('src/core/live-fast-decision.js');
  assert.match(analysis, /export function nextCandleContinuation/);
  assert.match(analysis, /const entryQuality = calculateEntryQuality/);
  assert.match(analysis, /ready: readyWithQuality|ready: readyWithQuality/);
  assert.match(orchestrator, /const nextCandleReady/);
  assert.match(orchestrator, /&& nextCandleReady/);
  assert.match(orchestrator, /entryQualityReady/);
  assert.match(fast, /q\.nextCandleReady === true/);
  assert.match(fast, /score >= signalPolicy\.finalScore/);
});


test('v0.11.99 derives next-candle pressure from raw OHLC and preserves live-session fallback', () => {
  const analysis = read('src/core/analysis.js');
  const control = read('src/background-control.js');
  assert.match(analysis, /const open = Number\(last\.open\)/);
  assert.match(analysis, /const bodyStrength = clamp\(\(body \/ range\) \* 100\)/);
  assert.match(analysis, /const entryQuality = calculateEntryQuality/);
  assert.match(analysis, /entryQuality\.ready === true/);
  assert.match(analysis, /continuationDirection: evidence\.continuationDirection/);
  assert.match(control, /transient focus-reader blink/);
  assert.match(control, /candlesReady/);
});


test('entry quality admits a short clean candle and blocks borderline/tiny noisy entries', () => {
  const shortClean = calculateEntryQuality({
    buyPower: 58,
    sellPower: 44,
    momentumDirection: null,
    nextCandle: {
      pressure: 58,
      opposingPressure: 44,
      favorableClose: 67,
      bodyStrength: 16,
      opposingWick: 28,
      previousAlignment: 0.67,
      momentumAligned: false,
      momentumScore: 35
    },
    breakout: 'BUY'
  }, 'BUY');

  assert.equal(shortClean.ready, true);
  assert.ok(shortClean.score >= 57);
  assert.ok(shortClean.directionalEdge >= 12);

  const borderline = calculateEntryQuality({
    buyPower: 54,
    sellPower: 51,
    nextCandle: {
      pressure: 54,
      opposingPressure: 51,
      favorableClose: 58,
      bodyStrength: 16,
      opposingWick: 45,
      previousAlignment: 0,
      momentumAligned: false,
      momentumScore: 20
    }
  }, 'BUY');

  assert.equal(borderline.ready, false);
  assert.equal(borderline.borderline, true);
  assert.ok(borderline.directionalEdge < 8);
});

test('next-candle entry-quality path uses scoped continuation evidence', () => {
  const analysis = read('src/core/analysis.js');
  assert.match(analysis, /continuationDirection: evidence\.continuationDirection/);
  assert.match(analysis, /continuationScore: Number\(evidence\.continuationScore \|\| 0\)/);
  assert.match(analysis, /entryQuality\.ready === true/);
});


test('v0.11.104 keeps the operational ledger runtime-safe and ENTER-only', () => {
  const background = read('src/background.js');
  const emissionBlock = background.match(/function performanceEmission[\\s\\S]*?\\n}\\n\\nfunction performanceFeedAdvancedPastTarget/);
  assert.ok(emissionBlock, 'performanceEmission block must exist');
  assert.match(emissionBlock[0], /const professional = state\.professionalDecision \|\| \{\};/);
  assert.doesNotMatch(emissionBlock[0], /const professional = next\.professionalDecision/);
  assert.match(emissionBlock[0], /const type = 'ENTER'/);
  assert.match(background, /\['ENTER_BUY','ENTER_SELL'\]\.includes\(professionalUi\)/);
  assert.match(background, /filter\(row => clean\(row\?\.type\)\.toUpperCase\(\) !== 'POSSIBLE'\)/);
});

test('operation outcome uses the target candle open and resolves only after its close', () => {
  const outcomes = read('src/core/signal-outcomes.js');
  assert.match(outcomes, /entryPrice: open/);
  assert.match(outcomes, /entryStatus: 'confirmed'/);
  assert.match(outcomes, /outcomeBasis: 'target_candle_open_close'/);
  assert.match(outcomes, /now < targetStart \+ timeframeMs\(record\.timeframe\)/);
});
