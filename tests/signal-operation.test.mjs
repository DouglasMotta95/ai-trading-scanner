import test from 'node:test';
import { readFileSync } from 'node:fs';
import { getSignalPolicy, getThresholds } from '../src/core/analysis.js';
import { decisionQuality } from '../src/core/orchestrator.js';
import { evaluateProfileEntryGate } from '../src/core/profile-entry-gates.js';
import assert from 'node:assert/strict';
import {
  createActiveSignalOperation,
  reconcileActiveSignalOperation,
  signalOperationHolds,
  operationDecision
} from '../src/core/signal-operation.js';
import { resolveSignalHistory } from '../src/core/signal-outcomes.js';

const minute = 60_000;
const base = 1_800_000_000_000;

test('confirmed entry is held on one target candle until outcome is resolved', () => {
  const state = {
    asset: 'EUR/USD (OTC)', analysisTimeframe: 'M1',
    signal: { uiState: 'ENTER_BUY', direction: 'BUY', targetStart: base, score: 88 }
  };
  const operation = createActiveSignalOperation(state, {
    uiState: 'ENTER_BUY', direction: 'BUY', actionable: true, score: 88, timeframe: 'M1'
  }, base - 5_000);
  assert.ok(operation);
  assert.equal(operation.targetStart, base);
  assert.equal(operation.targetEnd, base + minute);
  assert.equal(signalOperationHolds(operation), true);

  const beforeResult = reconcileActiveSignalOperation(operation, [], base + minute + 500);
  assert.equal(beforeResult.status, 'SETTLING');
  assert.equal(signalOperationHolds(beforeResult), true);

  const completed = reconcileActiveSignalOperation(operation, [{
    id: operation.signalId, asset: operation.asset, timeframe: 'M1', direction: 'BUY',
    targetStart: base, entryPrice: 1.1050, exitPrice: 1.1047,
    result: 'LOSS', status: 'resolved', resolvedAt: base + minute + 100
  }], base + minute + 500);
  assert.equal(completed.status, 'COMPLETED');
  assert.equal(completed.candleOpenPrice, 1.1050);
  assert.equal(completed.candleClosePrice, 1.1047);
  assert.equal(completed.result, 'LOSS');
  assert.equal(signalOperationHolds(completed), false);
});

test('entry stops being actionable after the grace window but monitoring remains locked', () => {
  const operation = {
    id: 'op', asset: 'EUR/USD (OTC)', timeframe: 'M1', direction: 'SELL',
    targetStart: base, targetEnd: base + minute, status: 'IN_PROGRESS', candleOpenPrice: 1.1050
  };
  assert.equal(operationDecision({}, operation, base + 5_000).actionable, true);
  const monitoring = operationDecision({}, operation, base + 10_000);
  assert.equal(monitoring.uiState, 'OPERATION_ACTIVE_SELL');
  assert.equal(monitoring.actionable, false);
  assert.match(monitoring.reason, /OPERAÇÃO EM ANDAMENTO/);
});

test('signal outcome is graded by target candle open-to-close only after close', () => {
  const asset = 'EUR/USD (OTC)';
  const record = {
    id: asset + '|M1|' + base + '|BUY', asset, timeframe: 'M1',
    direction: 'BUY', targetStart: base, entryPrice: null, exitPrice: null, result: null, status: 'pending'
  };
  const candles = [{ time: base, open: 1.1050, high: 1.1060, low: 1.1040, close: 1.1047 }];
  const inProgress = resolveSignalHistory([record], { asset, candles, serverTime: base + minute - 1 });
  assert.equal(inProgress.rows[0].entryPrice, 1.1050);
  assert.equal(inProgress.rows[0].result, null);

  const closed = resolveSignalHistory(inProgress.rows, { asset, candles, serverTime: base + minute + 1 });
  assert.equal(closed.rows[0].entryPrice, 1.1050);
  assert.equal(closed.rows[0].exitPrice, 1.1047);
  assert.equal(closed.rows[0].result, 'LOSS');
  assert.equal(closed.rows[0].outcomeBasis, 'target_candle_open_close');
});

test('v0.12.13 shared profile gate controls actual final eligibility; power exactly 45 is accepted', () => {
  const cases = [
    ['RIGIDO', 58, 62],
    ['MEDIO', 52, 55],
    ['SOLTO', 45, 50]
  ];
  for (const [profile, possibleScore, finalScore] of cases) {
    const policy = getSignalPolicy(profile);
    assert.equal(policy.possibleScore, possibleScore);
    assert.equal(policy.finalScore, finalScore);
    assert.equal(policy.possiblePower, 45);
    assert.equal(policy.finalPower, 45);
    const result = evaluateProfileEntryGate({
      profile, direction: 'BUY', score: finalScore, buyPower: 45,
      secondsRemaining: 10, timeframe: 'M1'
    });
    assert.equal(result.candidate, true, profile + ' candidate must pass at power=45');
    assert.equal(result.finalEligible, true, profile + ' final threshold must pass at power=45');
  }
});

test('v0.12.11 manual M1 expiration and live countdown fallback are explicit, while manual execution remains unchanged', () => {
  const policy = readFileSync(new URL('../src/background-decision-policy.js', import.meta.url), 'utf8');
  const panel = readFileSync(new URL('../src/sidepanel/app-v2.js', import.meta.url), 'utf8');
  const background = readFileSync(new URL('../src/background.js', import.meta.url), 'utf8');
  assert.match(policy, /controls\.userDeclaredExpiration[\s\S]{0,200}executionPreferences\?\.expiration/);
  assert.match(policy, /'EXPIRAÇÃO MANUAL ACEITA – usando 1 min'/);
  assert.match(policy, /export function runningCasaTradeCountdown/);
  assert.match(panel, /function runningCountdownAvailable/);
  assert.doesNotMatch(panel, /COUNTDOWN REAL PENDENTE[^\n]*\n[\s\S]{0,80}return false/);
  assert.match(background, /freshRunningClock/);
  assert.match(panel, /Entrada MANUAL|entrada MANUAL|manual/i);
  assert.doesNotMatch(background, /click\(['"](?:COMPRAR|VENDER|BUY|SELL)/i);
});
