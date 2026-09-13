import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { processSnapshot, resetOrchestrator } from '../src/core/orchestrator.js';

const minute = 60_000;
const baseBucket = Math.floor(1_701_000_000_000 / minute) * minute;
const closed = bucket => [
  { time: bucket - 4 * minute, open: 1.00, high: 1.02, low: .99, close: 1.018, timeframe: 'M1' },
  { time: bucket - 3 * minute, open: 1.018, high: 1.04, low: 1.01, close: 1.038, timeframe: 'M1' },
  { time: bucket - 2 * minute, open: 1.038, high: 1.06, low: 1.03, close: 1.058, timeframe: 'M1' },
  { time: bucket - minute, open: 1.058, high: 1.08, low: 1.05, close: 1.078, timeframe: 'M1' }
];

test('persisted lastConfirmed from an older session is never revived', () => {
  resetOrchestrator();
  const bucket = baseBucket;
  const out = processSnapshot({
    platformId: 'casatrade', asset: 'EUR/USD (OTC)', price: 1.079,
    timeframe: 'M1', analysisTimeframe: 'M1', connection: 'online',
    serverTime: bucket + 5_000,
    candles: [{ time: bucket, open: 1.078, high: 1.08, low: 1.077, close: 1.079, timeframe: 'M1' }]
  }, {
    connection: 'online',
    lastConfirmed: { state: 'CONFIRM', direction: 'SELL', score: 100, asset: 'EUR/USD (OTC)', timeframe: 'M1', time: bucket - minute }
  });
  assert.equal(out.lastConfirmed, null);
});

test('confirmed signal records the real target-candle opening price after rollover', () => {
  resetOrchestrator();
  const bucket = baseBucket + 10 * minute;
  const history = closed(bucket);
  const final = processSnapshot({
    platformId: 'casatrade', asset: 'EUR/USD (OTC)', price: 1.11,
    timeframe: 'M1', analysisTimeframe: 'M1', connection: 'online',
    serverTime: bucket + 55_000,
    candles: [...history, { time: bucket, open: 1.078, high: 1.115, low: 1.075, close: 1.11, timeframe: 'M1' }]
  }, { connection: 'online' });
  assert.equal(final.signal.state, 'CONFIRM');

  const realOpen = 1.1095;
  const laterQuote = 1.112;
  const next = processSnapshot({
    platformId: 'casatrade', asset: 'EUR/USD (OTC)', price: laterQuote,
    timeframe: 'M1', analysisTimeframe: 'M1', connection: 'online',
    serverTime: bucket + minute + 5_000,
    candles: [
      ...history,
      { time: bucket, open: 1.078, high: 1.115, low: 1.075, close: 1.11, timeframe: 'M1' },
      { time: bucket + minute, open: realOpen, high: 1.113, low: 1.109, close: laterQuote, timeframe: 'M1' }
    ]
  }, { connection: 'online' });

  assert.equal(next.lastConfirmed.state, 'CONFIRM');
  assert.equal(next.lastConfirmed.entryPrice, realOpen);
  assert.notEqual(next.lastConfirmed.entryPrice, laterQuote);
  assert.equal(next.lastConfirmed.entryTime, bucket + minute);
  assert.equal(next.lastConfirmed.capturedAt, bucket + minute + 5_000);
});

test('side panel labels and renders only a real entry price', () => {
  const html = fs.readFileSync(new URL('../src/sidepanel/index.html', import.meta.url), 'utf8');
  const js = fs.readFileSync(new URL('../src/sidepanel/real-entry.js', import.meta.url), 'utf8');
  assert.match(html, /Entrada real/);
  assert.match(html, /real-entry\.js/);
  assert.match(js, /AGUARDANDO ABERTURA REAL/);
  assert.match(js, /lastConfirmed\?\.entryPrice/);
  assert.doesNotMatch(js, /targetLabel/);
});
