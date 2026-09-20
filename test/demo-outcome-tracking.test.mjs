import test from 'node:test';
import assert from 'node:assert/strict';
import { captureSignalEntry, resolveSignalOutcome, resolveSignalHistory, signalPerformance } from '../src/core/signal-outcomes.js';

const targetStart = 1_800_200_000_000;
const candle = { time: targetStart, timeframe: 'M1', open: 1.1000, high: 1.1030, low: 1.0990, close: 1.1020 };

test('BUY outcome is resolved only from the exact target candle open/close', () => {
  const record = { id: 'a', asset: 'EUR/USD', timeframe: 'M1', direction: 'BUY', targetStart, status: 'pending', result: null };
  const resolved = resolveSignalOutcome(record, [
    { ...candle, time: targetStart - 60_000, open: 1.2, close: 1.0 },
    candle,
    { ...candle, time: targetStart + 60_000, open: 1.0, close: 0.9 }
  ]);
  assert.equal(resolved.result, 'WIN');
  assert.equal(resolved.entryPrice, 1.1000);
  assert.equal(resolved.exitPrice, 1.1020);
  assert.equal(resolved.outcomeBasis, 'target_candle_open_close');
});

test('SELL outcome resolves correctly and a missing target candle is never replaced by a later candle', () => {
  const sell = { id: 'b', asset: 'GBP/USD', timeframe: 'M1', direction: 'SELL', targetStart, status: 'pending', result: null };
  const win = resolveSignalOutcome(sell, [{ ...candle, open: 1.1020, close: 1.1000 }]);
  assert.equal(win.result, 'WIN');

  const missing = resolveSignalOutcome(sell, [{ ...candle, time: targetStart + 60_000, open: 1.1020, close: 1.0900 }]);
  assert.equal(missing, null);
});

test('live target candle captures entry immediately but is graded only after candle close', () => {
  const record = { id: 'live', asset: 'EUR/USD (OTC)', timeframe: 'M1', direction: 'BUY', targetStart, status: 'pending', result: null };
  const captured = captureSignalEntry(record, [candle]);
  assert.equal(captured.entryPrice, candle.open);
  assert.equal(captured.status, 'pending');

  const early = resolveSignalHistory([record], {
    asset: 'EUR/USD (OTC)',
    candles: [candle],
    serverTime: targetStart + 30_000
  });
  assert.equal(early.rows[0].entryPrice, candle.open);
  assert.equal(early.rows[0].result, null);
  assert.equal(early.resolved.length, 0);

  const closed = resolveSignalHistory(early.rows, {
    asset: 'EUR/USD (OTC)',
    candles: [candle],
    serverTime: targetStart + 60_000
  });
  assert.equal(closed.rows[0].result, 'WIN');
  assert.equal(closed.resolved.length, 1);
});

test('history resolver preserves OTC identity and performance ignores draws in directional win rate', () => {
  const rows = [
    { id: 'buy', asset: 'EUR/USD (OTC)', timeframe: 'M1', direction: 'BUY', targetStart, status: 'pending', result: null },
    { id: 'regular', asset: 'EUR/USD', timeframe: 'M1', direction: 'BUY', targetStart, status: 'pending', result: null }
  ];
  const out = resolveSignalHistory(rows, { asset: 'EUR/USD (OTC)', candles: [candle] });
  assert.equal(out.resolved.length, 1);
  assert.equal(out.rows[0].result, 'WIN');
  assert.equal(out.rows[1].result, null);

  const summary = signalPerformance([
    { result: 'WIN' }, { result: 'LOSS' }, { result: 'WIN' }, { result: 'DRAW' }, { result: null }
  ]);
  assert.deepEqual(summary, {
    signals: 5,
    resolved: 4,
    pending: 1,
    wins: 2,
    losses: 1,
    draws: 1,
    observedWinRate: 66.7
  });
});
