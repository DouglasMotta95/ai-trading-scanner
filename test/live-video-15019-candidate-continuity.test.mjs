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

test('15019: candle key is stable for the whole target candle, not a 5-second slice', () => {
  const src = read('src/core/orchestrator.js');
  assert.match(src, /const tfMs = timeframeMs\(timeframe\)/);
  assert.match(src, /bucket \+ tfMs/);
  assert.match(src, /Math\.round\(rawTarget \/ tfMs\) \* tfMs/);
  assert.doesNotMatch(src, /Math\.round\(rawTarget \/ 5000\) \* 5000/);
});

test('15019: transport frame handoff cannot reset technical candidate state', () => {
  const background = read('src/background.js');
  const session = read('src/background-market-session.js');
  const marketKeyBlock = background.match(/const marketKey = \[[\s\S]*?\]\.join\('\|'\);/)?.[0] || '';
  assert.ok(marketKeyBlock);
  assert.doesNotMatch(marketKeyBlock, /frameId|frameHost/);
  assert.match(session, /const realAssetMismatch/);
  assert.match(session, /if \(assetChanged \|\| realAssetMismatch\)/);
  assert.match(session, /else if \(traderHandoff\)/);
  assert.match(session, /source: 'same-market-trader-handoff'/);
  assert.match(session, /transferindo autoridade do frame sem reiniciar o sinal/);
});

test('15019: professional hold follows technical hysteresis instead of dropping 82 to raw weak tick immediately', () => {
  const src = read('src/background-decision-policy.js');
  assert.match(src, /const technicalCycleKey = text\(state\.decisionCycle\?\.key\)/);
  assert.match(src, /if \(technicalCycleKey\) return technicalCycleKey/);
  assert.match(src, /const continuityActive = technicalCandidate && sameCandidate/);
  assert.match(src, /const effectiveScore = continuityActive \? Math\.max\(score, previousScore\) : score/);
  assert.match(src, /effectiveDirectionalPower/);
  assert.match(src, /effectiveScore < possibleScore/);
  assert.match(src, /technicalFinal && effectiveScore >= finalScore/);
});

test('15019: signal thresholds stay unchanged', () => {
  const src = read('src/core/analysis.js');
  assert.match(src, /MEDIO:[\s\S]*?possibleScore: 40,[\s\S]*?confirmScore: 52,[\s\S]*?finalScore: 52,[\s\S]*?entryWindowSeconds: 12,[\s\S]*?holdSeconds: 2/);
  assert.match(src, /RIGIDO:[\s\S]*?possibleScore: 44,[\s\S]*?confirmScore: 58,[\s\S]*?entryWindowSeconds: 10/);
});

test('15019: build is v0.11.46 and keeps blocker diagnostics available', () => {
  const manifest = JSON.parse(read('manifest.json'));
  const panel = read('src/sidepanel/ui-shell-v2.js');
  assert.equal(manifest.version, '0.11.46');
  assert.equal(manifest.version_name, '0.11.46-video15019-full-continuity');
  assert.match(panel, /7\. BLOQUEIO DO CANDIDATO/);
});
