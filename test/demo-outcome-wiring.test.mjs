import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('background records one pending signal and resolves exact target-candle outcomes only after close', async () => {
  const source = await readFile(new URL('../src/background.js', import.meta.url), 'utf8');
  assert.match(source, /resolveSignalHistory, signalPerformance/);
  assert.match(source, /function reconcileSignalHistory/);
  assert.match(source, /targetStart = num\(signal\.targetStart \?\? next\.decisionCycle\?\.targetStart\)/);
  assert.match(source, /entryPrice: null,/);
  assert.match(source, /result: null,/);
  assert.match(source, /status: 'pending'/);
  assert.match(source, /resolveSignalHistory\(rows,/);
  assert.match(source, /serverTime: snapshot\.serverTime/);
  assert.match(source, /telemetryEvent\('signal_resolved'/);
  assert.match(source, /performance: history\.performance/);
  assert.doesNotMatch(source, /entryPrice: num\(state\.price\), status: 'confirmed'/);
});
