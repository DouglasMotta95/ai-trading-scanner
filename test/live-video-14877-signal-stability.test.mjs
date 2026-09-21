import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');

test('video 14877: POSSÍVEL is sticky for the current candle', () => {
  const orchestrator = read('src/core/orchestrator.js');
  assert.match(orchestrator, /Once published, a POSSÍVEL direction is sticky for the rest of this candle/);
  assert.match(orchestrator, /function observeStablePossible\(/);
  assert.match(orchestrator, /POSSIBLE_CONFIRM_HITS = 2/);
  assert.doesNotMatch(orchestrator, /POSSIBLE_HOLD_MS/);
});

test('video 14877: weak/null live ticks do not erase the current candidate', () => {
  const orchestrator = read('src/core/orchestrator.js');
  const start = orchestrator.indexOf('function observeStablePossible');
  const end = orchestrator.indexOf('\nfunction seedCycle', start);
  const block = orchestrator.slice(start, end);
  assert.match(block, /return cycle\.possibleDirection/);
  assert.doesNotMatch(block, /cycle\.possibleDirection = null/);
});

test('video 14877: opposite direction needs sustained stronger evidence to replace candidate', () => {
  const orchestrator = read('src/core/orchestrator.js');
  assert.match(orchestrator, /OPPOSITE_SWITCH_HITS = 3/);
  assert.match(orchestrator, /OPPOSITE_SCORE_MARGIN = 8/);
  assert.match(orchestrator, /cycle\.oppositeHits >= OPPOSITE_SWITCH_HITS/);
  assert.match(orchestrator, /strongerByMargin \|\| replacesStaleCandidate/);
});

test('video 14877: candidate remains visible even above 30 seconds once established', () => {
  const orchestrator = read('src/core/orchestrator.js');
  const start = orchestrator.indexOf('export function processSnapshot');
  const block = orchestrator.slice(start);
  assert.match(block, /if \(secondsRemaining > windows\.decision\)/);
  assert.match(block, /stableDirection\s*\?\s*possibleSignal/);
  assert.doesNotMatch(block, /if \(secondsRemaining > windows\.pre\)[\s\S]{0,300}buildingSignal/);
});

test('video 14877: professional decision is only a mirror of state.signal', () => {
  const policy = read('src/background-decision-policy.js');
  const start = policy.indexOf('function baseDecision');
  const end = policy.indexOf('\nfunction signature', start);
  const block = policy.slice(start, end);
  assert.match(block, /Single authority rule/);
  assert.match(block, /const ui = text\(signal\.uiState\)\.toUpperCase\(\)/);
  assert.doesNotMatch(block, /score >= possibleScore/);
  assert.doesNotMatch(block, /technicalCandidate/);
});

test('video 14877: all visible decision surfaces use the same central signal', () => {
  const app = read('src/sidepanel/app-v2.js');
  const guidance = read('src/sidepanel/signal-guidance-ui.js');
  assert.match(app, /The orchestrator signal is the only decision authority rendered by the UI/);
  assert.match(guidance, /const signal = state\.signal \|\| \{\}/);
  assert.doesNotMatch(guidance, /state\.professionalDecision/);
});

test('video 14877: setup label derives from technical pattern rather than only range context', () => {
  const orchestrator = read('src/core/orchestrator.js');
  assert.match(orchestrator, /function inferSetup/);
  assert.match(orchestrator, /'rejeição'/);
  assert.match(orchestrator, /'continuação'/);
  assert.match(orchestrator, /'momentum'/);
});
