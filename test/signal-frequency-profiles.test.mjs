import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { getThresholds, getSignalPolicy } from '../src/core/analysis.js';

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
  assert.ok(frequent.finalPower < balanced.finalPower);
  assert.ok(balanced.finalPower < selective.finalPower);
  assert.ok(frequent.minimumStructure < balanced.minimumStructure);
  assert.ok(balanced.minimumStructure < selective.minimumStructure);
});

test('all rhythms keep context, location and trigger mandatory', () => {
  const analysis = read('src/core/analysis.js');
  assert.match(analysis, /positionReady = .*location >= policy\.minimumLocation/);
  assert.match(analysis, /triggerReady = .*trigger >= policy\.minimumTrigger/);
  assert.match(analysis, /contextReady = structure >= policy\.minimumStructure && positionReady/);
  assert.match(analysis, /candidateReady = professional\.contextReady && professional\.triggerReady/);
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
  assert.match(html, /região válida|gatilho|confirmações extras/i);
  const loose = getThresholds('SOLTO');
  assert.equal(loose.holdSeconds, 1);
});
