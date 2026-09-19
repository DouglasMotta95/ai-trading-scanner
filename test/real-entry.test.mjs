import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  processSnapshot,
  resetOrchestrator,
  serializeCompletedDecisions,
  restoreCompletedDecisions
} from '../src/core/orchestrator.js';

const minute = 60_000;
const baseBucket = Math.floor(1_701_000_000_000 / minute) * minute;
const closed = bucket => Array.from({ length: 39 }, (_, index) => {
  const offset = 39 - index;
  const open = 1 + index * .002;
  const close = open + .0016;
  return { time: bucket - offset * minute, open, high: close + .00045, low: open - .00035, close, timeframe: 'M1' };
});

function strongSnapshot(bucket, serverTime) {
  const history = closed(bucket);
  return {
    platformId: 'casatrade', asset: 'EUR/USD (OTC)', price: 1.11,
    timeframe: 'M1', analysisTimeframe: 'M1', connection: 'online',
    serverTime,
    candles: [...history, { time: bucket, open: 1.078, high: 1.115, low: 1.075, close: 1.11, timeframe: 'M1' }]
  };
}

function confirmAt(bucket) {
  const history = closed(bucket);
  const state = { connection: 'online' };
  const firstPossible = processSnapshot(strongSnapshot(bucket, bucket + 35_000), state);
  assert.notEqual(firstPossible.signal.state, 'WATCH');
  const possible = processSnapshot(strongSnapshot(bucket, bucket + 36_000), state);
  assert.equal(possible.signal.state, 'WATCH');
  assert.equal(possible.signal.uiState, 'POSSIBLE_BUY');
  const firstFinal = processSnapshot(strongSnapshot(bucket, bucket + 51_000), state);
  assert.notEqual(firstFinal.signal.state, 'CONFIRM');
  const final = processSnapshot(strongSnapshot(bucket, bucket + 52_000), state);
  assert.equal(final.signal.state, 'CONFIRM');
  assert.equal(final.signal.uiState, 'ENTER_BUY');
  return history;
}

test('persisted lastConfirmed from an older session is never revived implicitly', () => {
  resetOrchestrator();
  const bucket = baseBucket;
  const out = processSnapshot({
    platformId: 'casatrade', asset: 'EUR/USD (OTC)', price: 1.079,
    timeframe: 'M1', analysisTimeframe: 'M1', connection: 'online',
    serverTime: bucket + 5_000,
    candles: [{ time: bucket, open: 1.078, high: 1.08, low: 1.077, close: 1.079, timeframe: 'M1' }]
  }, { connection: 'online', lastConfirmed: { state: 'CONFIRM', direction: 'SELL', score: 100, asset: 'EUR/USD (OTC)', timeframe: 'M1', time: bucket - minute } });
  assert.equal(out.lastConfirmed, null);
});

test('confirmed signal records the real target-candle opening price after rollover', () => {
  resetOrchestrator();
  const bucket = baseBucket + 10 * minute;
  const history = confirmAt(bucket);
  const realOpen = 1.1095;
  const laterQuote = 1.112;
  const next = processSnapshot({
    platformId: 'casatrade', asset: 'EUR/USD (OTC)', price: laterQuote,
    timeframe: 'M1', analysisTimeframe: 'M1', connection: 'online', serverTime: bucket + minute + 5_000,
    candles: [...history, { time: bucket, open: 1.078, high: 1.115, low: 1.075, close: 1.11, timeframe: 'M1' }, { time: bucket + minute, open: realOpen, high: 1.113, low: 1.109, close: laterQuote, timeframe: 'M1' }]
  }, { connection: 'online' });
  assert.equal(next.lastConfirmed.state, 'CONFIRM');
  assert.equal(next.lastConfirmed.entryConfirmed, true);
  assert.equal(next.lastConfirmed.entryStatus, 'confirmed');
  assert.equal(next.lastConfirmed.entryPrice, realOpen);
  assert.notEqual(next.lastConfirmed.entryPrice, laterQuote);
  assert.equal(next.lastConfirmed.entryTime, bucket + minute);
  assert.equal(next.lastConfirmed.capturedAt, bucket + minute + 5_000);
});

test('skipped target candle never uses a later candle as the entry price', () => {
  resetOrchestrator();
  const bucket = baseBucket + 20 * minute;
  const history = confirmAt(bucket);
  const lateBucket = bucket + 2 * minute;
  const late = processSnapshot({
    platformId: 'casatrade', asset: 'EUR/USD (OTC)', price: 9.99,
    timeframe: 'M1', analysisTimeframe: 'M1', connection: 'online', serverTime: lateBucket + 5_000,
    candles: [...history, { time: bucket, open: 1.078, high: 1.115, low: 1.075, close: 1.11, timeframe: 'M1' }, { time: lateBucket, open: 9.90, high: 10.00, low: 9.80, close: 9.99, timeframe: 'M1' }]
  }, { connection: 'online' });
  assert.equal(late.lastConfirmed.state, 'CONFIRM');
  assert.equal(late.lastConfirmed.entryConfirmed, false);
  assert.equal(late.lastConfirmed.entryStatus, 'unconfirmed');
  assert.equal(late.lastConfirmed.entryPrice, null);
  assert.equal(late.lastConfirmed.entryTime, null);
  assert.equal(late.lastConfirmed.capturedAt, null);
  assert.match(late.lastConfirmed.entryReason, /não confirmado/i);
});

test('completed decisions can be serialized and restored after a worker restart', () => {
  resetOrchestrator();
  const bucket = baseBucket + 30 * minute;
  const history = confirmAt(bucket);
  const realOpen = 1.1095;
  const completed = processSnapshot({
    platformId: 'casatrade', asset: 'EUR/USD (OTC)', price: 1.112,
    timeframe: 'M1', analysisTimeframe: 'M1', connection: 'online', serverTime: bucket + minute + 5_000,
    candles: [...history, { time: bucket, open: 1.078, high: 1.115, low: 1.075, close: 1.11, timeframe: 'M1' }, { time: bucket + minute, open: realOpen, high: 1.113, low: 1.109, close: 1.112, timeframe: 'M1' }]
  }, { connection: 'online' });
  assert.equal(completed.lastConfirmed.entryPrice, realOpen);
  const persisted = serializeCompletedDecisions();
  assert.equal(persisted.length, 1);
  resetOrchestrator();
  restoreCompletedDecisions(persisted);
  const restored = processSnapshot({
    platformId: 'casatrade', asset: 'EUR/USD (OTC)', price: 1.111,
    timeframe: 'M1', analysisTimeframe: 'M1', connection: 'online', serverTime: bucket + minute + 20_000,
    candles: [...history, { time: bucket, open: 1.078, high: 1.115, low: 1.075, close: 1.11, timeframe: 'M1' }, { time: bucket + minute, open: realOpen, high: 1.113, low: 1.109, close: 1.111, timeframe: 'M1' }]
  }, { connection: 'online' });
  assert.equal(restored.lastConfirmed.entryPrice, realOpen);
  assert.equal(restored.lastConfirmed.entryConfirmed, true);
});

test('manual operation card is the single visible execution record and obsolete duplicate entry surface is not mounted', () => {
  const html = fs.readFileSync(new URL('../src/sidepanel/index.html', import.meta.url), 'utf8');
  const manual = fs.readFileSync(new URL('../src/sidepanel/manual-trade-ui.js', import.meta.url), 'utf8');
  assert.match(html, /manual-trade-ui\.js/);
  assert.doesNotMatch(html, /real-entry\.js|ENTRADA REAL|id="targetTime"/i);
  assert.match(manual, /OPERAÇÃO MANUAL/);
  assert.match(manual, /manualTradeEntry/);
  assert.match(manual, /manualTradeExit/);
  assert.match(manual, /manualTradeResult/);
  assert.match(manual, /matchedSignal/);
  assert.match(manual, /MANUAL \/ FORA DO TIMING/);
});
