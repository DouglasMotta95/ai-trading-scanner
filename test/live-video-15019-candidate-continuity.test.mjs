import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');

test('15019: POSSIVEL candidate survives brief weak ticks in the final window', () => {
  const src = read('src/core/orchestrator.js');
  assert.match(src, /DECISION_WEAK_HOLD_MS = 2500/);
  assert.match(src, /POSSIBLE_WEAK_HOLD_MS = 2500/);
  assert.match(src, /cycle\.decisionWeakSince/);
  assert.match(src, /cycle\.possibleWeakSince/);
  assert.match(src, /weakForMs < DECISION_WEAK_HOLD_MS/);
  assert.match(src, /weakForMs < POSSIBLE_WEAK_HOLD_MS/);
  assert.match(src, /DECISION_HIT_GAP_MS = 7000/);
  assert.match(src, /CONFIRM_HITS = 2/);
});

test('15019: professional hold uses the stable technical candle key', () => {
  const src = read('src/background-decision-policy.js');
  assert.match(src, /const technicalCycleKey = text\(state\.decisionCycle\?\.key\)/);
  assert.match(src, /if \(technicalCycleKey\) return technicalCycleKey/);
  assert.match(src, /state\.diagnostics\?\.marketClock\?\.closeAt/);
});

test('15019: build is v0.11.45 and keeps diagnostic section available', () => {
  const manifest = JSON.parse(read('manifest.json'));
  const panel = read('src/sidepanel/ui-shell-v2.js');
  assert.equal(manifest.version, '0.11.45');
  assert.equal(manifest.version_name, '0.11.45-candidate-continuity-final-window');
  assert.match(panel, /7\. BLOQUEIO DO CANDIDATO/);
});
