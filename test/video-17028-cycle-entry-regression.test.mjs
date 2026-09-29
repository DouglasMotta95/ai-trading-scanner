import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');

test('v0.11.107 anchors the live cycle to CasaTrade exact close time', () => {
  const background = read('src/background.js');
  const orchestrator = read('src/core/orchestrator.js');

  assert.match(background, /const exactClockCloseAt = exactClock/);
  assert.match(background, /const authoritativeCloseAt = exactClockCloseAt != null/);
  assert.match(background, /currentCandleStart = authoritativeCloseAt != null/);
  assert.match(background, /nextCandleStart = authoritativeCloseAt != null/);

  assert.match(orchestrator, /const candidates = \[/);
  assert.match(orchestrator, /num\(snapshot\.nextCandleStart\)/);
  assert.match(orchestrator, /if \(target <= now \+ 250\)/);
  assert.match(orchestrator, /target \+= Math\.max\(1, steps\) \* tfMs/);
});

test('v0.11.107 never presents a signal while connection is not online', () => {
  const policy = read('src/background-decision-policy.js');
  const panel = read('src/sidepanel/app-v2.js');

  assert.match(policy, /if \(state\.connection !== 'online'\)/);
  assert.match(policy, /aguardando conexão online antes de liberar qualquer entrada/);
  assert.match(panel, /if \(state\.connection !== 'online'\)/);
  assert.match(panel, /CONECTANDO À CASATRADE/);
  assert.match(panel, /actionable: false/);
});

test('v0.11.107 manual click can bind shortly before the scheduled candle', async () => {
  const { createManualTrade } = await import('../src/core/manual-trades.js');
  const targetStart = 1_800_000_000_000;
  const state = {
    asset: 'NZD/USD (OTC)',
    analysisTimeframe: 'M1',
    price: 0.57495,
    signal: {
      id: 'unused',
      direction: 'SELL',
      uiState: 'ENTER_SELL',
      state: 'CONFIRM',
      targetStart
    },
    decisionCycle: { locked: 'ENTER', direction: 'SELL', targetStart, score: 72 }
  };

  const early = createManualTrade(
    state,
    { direction: 'SELL', clickedAt: targetStart - 5000, label: 'VENDER' },
    targetStart - 5000,
    'trade-early'
  );
  assert.equal(early.matchedSignal, true);
  assert.equal(early.signalId, 'NZD/USD (OTC)|M1|' + targetStart + '|SELL');

  const tooLate = createManualTrade(
    state,
    { direction: 'SELL', clickedAt: targetStart + 9000, label: 'VENDER' },
    targetStart + 9000,
    'trade-late'
  );
  assert.equal(tooLate.matchedSignal, false);
});

test('v0.11.107 manual click mirrors the execution price into the signal ledger', () => {
  const background = read('src/background-manual-trades.js');
  assert.match(background, /manualClickAt: trade\.clickedAt/);
  assert.match(background, /manualEntryPrice: trade\.entryPrice/);
  assert.match(background, /entrySource: 'manual-click'/);
  assert.match(background, /signalLinked/);
});
