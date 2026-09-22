import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');

test('wrapper uses selected signal policy instead of a fixed 60/70 gate', () => {
  const orchestrator = read('src/core/orchestrator.js');
  assert.match(orchestrator, /getSignalPolicy/);
  assert.doesNotMatch(orchestrator, /const HIGH_CONFIDENCE/);
  assert.match(orchestrator, /score >= finalScore/);
  assert.match(orchestrator, /power >= signalPolicy\.finalPower/);
  assert.match(orchestrator, /signalPolicy\.minimumConfluence/);
});

test('wrapper cannot bypass professional context or reuse a stale opposite final direction', () => {
  const orchestrator = read('src/core/orchestrator.js');
  assert.match(orchestrator, /professional\.contextReady === true && professional\.triggerReady === true/);
  assert.match(orchestrator, /technicalDirection === direction/);
  assert.match(orchestrator, /if \(technicalFinal && quality\.qualifies\)/);
});

test('Mais Sinais keeps its one-second hold after restoring and changing preferences', () => {
  const panel = read('src/sidepanel/app-v2.js');
  assert.match(panel, /profile === 'SOLTO' \? 1 : 2/);
  assert.match(panel, /holdSeconds: profileHoldSeconds\(raw\.sensitivityProfile \|\| 'MEDIO'\)/);
  assert.match(panel, /key === 'sensitivityProfile'.*profileHoldSeconds\(value\)/s);
  assert.doesNotMatch(panel, /raw\.sensitivityProfile[^\n]+=== 'RIGIDO' \? 3 : 2/);
});

test('forced central follow-up is limited to the real M1/M5 final window', () => {
  const background = read('src/background.js');
  assert.match(background, /confirmationWindowSeconds = activeOperation\.timeframe === 'M5' \? 8 : 5/);
  assert.match(background, /seconds <= confirmationWindowSeconds/);
  assert.doesNotMatch(background, /seconds <= activeThresholds\.entryWindowSeconds/);
});

test('package remains manual and has one runtime processSnapshot owner', () => {
  const background = read('src/background.js');
  const market = read('src/background-market-session.js');
  const handoff = read('src/content/trade-handoff-v2.js');
  assert.match(background, /processSnapshot\(snapshot, current\)/);
  assert.doesNotMatch(market, /processSnapshot\(/);
  assert.doesNotMatch(handoff, /\.click\s*\(/);
  assert.doesNotMatch(handoff, /new\s+MouseEvent|dispatchEvent\s*\(/);
});
