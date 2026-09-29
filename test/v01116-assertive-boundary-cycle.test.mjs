import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');

test('v0.11.116 profile floors and power boundary are inclusive', () => {
  const analysis = read('src/core/analysis.js');
  const orchestrator = read('src/core/orchestrator.js');
  const policy = read('src/background-decision-policy.js');
  const fast = read('src/core/live-fast-decision.js');

  assert.equal((await import('../src/core/analysis.js')).getSignalPolicy('RIGIDO').possibleScore, 58);
  assert.equal((await import('../src/core/analysis.js')).getSignalPolicy('RIGIDO').finalScore, 62);
  assert.equal((await import('../src/core/analysis.js')).getSignalPolicy('MEDIO').possibleScore, 52);
  assert.equal((await import('../src/core/analysis.js')).getSignalPolicy('MEDIO').finalScore, 55);
  assert.equal((await import('../src/core/analysis.js')).getSignalPolicy('SOLTO').possibleScore, 45);
  assert.equal((await import('../src/core/analysis.js')).getSignalPolicy('SOLTO').finalScore, 50);

  assert.match(analysis, /if \(power < 45\)/);
  assert.doesNotMatch(policy, /power\s*>\s*45/);
  assert.doesNotMatch(orchestrator, /power\s*>\s*45/);
  assert.doesNotMatch(fast, /q\.power\s*>\s*45/);
  assert.match(orchestrator, /power >= signalPolicy\.possiblePower/);
  assert.match(orchestrator, /power >= signalPolicy\.finalPower/);
  assert.match(fast, /q\.power >= signalPolicy\.possiblePower/);
  assert.match(fast, /q\.power >= signalPolicy\.finalPower/);
});

test('v0.11.116 final promotion uses only primary technical minimums', () => {
  const orchestrator = read('src/core/orchestrator.js');
  const policy = read('src/background-decision-policy.js');
  const fast = read('src/core/live-fast-decision.js');

  assert.match(orchestrator, /const finalMinimumReady = \['BUY', 'SELL'\]\.includes\(direction\)/);
  assert.match(orchestrator, /score >= signalPolicy\.finalScore/);
  assert.match(orchestrator, /power >= signalPolicy\.finalPower/);
  assert.match(orchestrator, /expirationCompatible\(state, snapshot\)/);
  assert.match(orchestrator, /snapshot\.connection === 'online'/);
  assert.doesNotMatch(orchestrator, /finalMinimumReady[\s\S]{0,500}nextCandleReady/);
  assert.doesNotMatch(orchestrator, /finalMinimumReady[\s\S]{0,500}entryQualityReady/);

  assert.match(policy, /function usableCasaTradeTime/);
  assert.match(policy, /projectedFromLastGood/);
  assert.match(policy, /const assertiveFinalReady = technicalFinalReady/);

  assert.match(fast, /const minimumFinalReady = \['BUY', 'SELL'\]\.includes\(direction\)/);
  assert.match(fast, /if \(minimumFinalReady\)/);
  assert.match(fast, /return enter\(signal, direction, score, seconds, q\)/);
});

test('v0.11.116 retains last-good timing and avoids recovery-loop on usable time', () => {
  const marketSession = read('src/background-market-session.js');
  const background = read('src/background.js');
  const app = read('src/sidepanel/app-v2.js');

  assert.match(marketSession, /marketClockLastGood/);
  assert.match(background, /function projectedClockForAnalysis/);
  assert.match(background, /clockQuality: exact \? 'exact' : 'fallback'/);
  assert.match(background, /const usableClockForHealth = projectedClockForAnalysis/);
  assert.doesNotMatch(background, /gaps\.push\('countdown exato'\)/);

  assert.match(app, /function usableClock/);
  assert.match(app, /return usableClock\(state\) != null/);
  assert.match(app, /Mantendo a última leitura válida/);
  assert.match(app, /function projectedRemaining\(state = \{\}\)/);
});

test('v0.11.116 keeps lateral/doji local triggers from nulling direction', () => {
  const analysis = read('src/core/analysis.js');
  assert.match(analysis, /if \(!direction && breakout\) direction = breakout/);
  assert.match(analysis, /if \(!direction && rejection\) direction = rejection/);
  assert.match(analysis, /continuationDirection && continuationScore >= 60/);
  assert.match(analysis, /if \(lateral && !decisiveLocalSetup\)/);
  assert.match(analysis, /if \(doji && !rejection\)/);
});
