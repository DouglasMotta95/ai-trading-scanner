import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = path => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('single-frame CasaTrade can recover focused asset from direct pair or explicit user selection', () => {
  const bridge = read('src/content/focused-asset-alias-bridge.js');
  assert.match(bridge, /function directPairFromText/);
  assert.match(bridge, /visible-direct-pair/);
  assert.match(bridge, /upperChartArea\(el\)/);
  assert.match(bridge, /user-selected-alias/);
  assert.match(bridge, /text\.length <= 24 && !\/\[\\d%\]\//);
  assert.match(bridge, /chartScoped: true, chartFound: true/);
});

test('primary next-candle decision and Gemini status are promoted to the top of the side panel', () => {
  const ui = read('src/sidepanel/ai-analysis-ui.js');
  assert.match(ui, /syncStrip\.after\(decisionCard\)/);
  assert.match(ui, /decisionCard\.after\(card\)/);
  assert.match(ui, /aiTopStatus/);
  assert.match(ui, /IA EM ESPERA/);
  assert.match(ui, /IA ANALISANDO/);
});
