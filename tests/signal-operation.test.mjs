import test from 'node:test';
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
