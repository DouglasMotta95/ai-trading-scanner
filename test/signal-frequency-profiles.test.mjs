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
