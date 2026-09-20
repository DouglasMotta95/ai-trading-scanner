import test from 'node:test';
import assert from 'node:assert/strict';
import { updateSignalJournal } from '../src/core/signal-journal.js';

const TF = 60_000;
const START = Date.UTC(2026, 8, 20, 17, 0, 0);

function issued(direction = 'BUY') {
  return {
    asset: 'EUR/USD (OTC)',
    direction,
    targetStart: START,
    activeUntil: START + TF,
    issuedAt: START - 8_000,
    setup: 'continuação',
    regime: 'uptrend',
    score: 58,
    qualityScore: 61
  };
}

test('signal is recorded before the target candle starts without inventing an entry quote', () => {
  const rows = updateSignalJournal({
    previousRows: [],
    snapshot: { asset: 'EUR/USD (OTC)', candles: [] },
    issued: issued('BUY'),
    tfMs: TF,
    now: START - 5_000
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'PENDING_ENTRY');
  assert.equal(rows[0].entryPrice, null);
  assert.equal(rows[0].resolved, false);
});

test('at the new candle boundary the target candle OPEN is frozen as the entry quote', () => {
  const pending = updateSignalJournal({
    previousRows: [],
    snapshot: { asset: 'EUR/USD (OTC)', candles: [] },
    issued: issued('BUY'),
    tfMs: TF,
    now: START - 2_000
  });
  const rows = updateSignalJournal({
    previousRows: pending,
    snapshot: {
      asset: 'EUR/USD (OTC)',
      price: 1.10008,
      candles: [{ time: START, open: 1.10000, high: 1.10010, low: 1.09998, close: 1.10008 }]
    },
    tfMs: TF,
    now: START + 900
  });
  assert.equal(rows[0].status, 'ACTIVE');
  assert.equal(rows[0].entryPrice, 1.1);
  assert.equal(rows[0].entryQuote, 1.1);
  assert.equal(rows[0].entryCapturedAt, START);
  assert.equal(rows[0].entrySource, 'target-candle-open');
  assert.equal(rows[0].resolved, false);
});

test('BUY resolves WIN from the frozen entry quote when target candle closes above it', () => {
  const active = updateSignalJournal({
    previousRows: [],
    snapshot: {
      asset: 'EUR/USD (OTC)',
      candles: [{ time: START, open: 1.1, high: 1.1004, low: 1.0999, close: 1.1002 }]
    },
    issued: issued('BUY'),
    tfMs: TF,
    now: START + 1_000
  });
  const resolved = updateSignalJournal({
    previousRows: active,
    snapshot: {
      asset: 'EUR/USD (OTC)',
      candles: [{ time: START, open: 1.1, high: 1.1008, low: 1.0999, close: 1.1006 }]
    },
    tfMs: TF,
    now: START + TF + 100
  });
  assert.equal(resolved[0].entryPrice, 1.1);
  assert.equal(resolved[0].exitPrice, 1.1006);
  assert.equal(resolved[0].outcome, 'WIN');
  assert.equal(resolved[0].resolved, true);
});

test('BUY resolves RED when close is below saved entry and SELL resolves WIN for the same move', () => {
  const candle = [{ time: START, open: 1.1, high: 1.1001, low: 1.0992, close: 1.0994 }];

  const buy = updateSignalJournal({
    previousRows: [],
    snapshot: { asset: 'EUR/USD (OTC)', candles: candle },
    issued: issued('BUY'),
    tfMs: TF,
    now: START + TF + 100
  });
  assert.equal(buy[0].outcome, 'RED');

  const sell = updateSignalJournal({
    previousRows: [],
    snapshot: { asset: 'EUR/USD (OTC)', candles: candle },
    issued: issued('SELL'),
    tfMs: TF,
    now: START + TF + 100
  });
  assert.equal(sell[0].outcome, 'WIN');
});

test('equal close and entry is DRAW', () => {
  const rows = updateSignalJournal({
    previousRows: [],
    snapshot: {
      asset: 'EUR/USD (OTC)',
      candles: [{ time: START, open: 1.1, high: 1.1002, low: 1.0998, close: 1.1 }]
    },
    issued: issued('SELL'),
    tfMs: TF,
    now: START + TF + 100
  });
  assert.equal(rows[0].outcome, 'DRAW');
});
