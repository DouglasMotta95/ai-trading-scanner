import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('background records pending signals and resolves only exact target-candle outcomes', async () => {
  const source = await readFile(new URL('../src/background.js', import.meta.url), 'utf8');
  assert.match(source, /resolveSignalHistory, signalPerformance/);
  assert.match(source, /targetStart: num\(s\.targetStart\)/);
  assert.match(source, /entryPrice: null, exitPrice: null, result: null, status: 'pending'/);
  assert.match(source, /resolveSessionHistoryOutcomes\(next\)/);
  assert.match(source, /telemetryEvent\('signal_resolved'/);
  assert.match(source, /performance: signalPerformance\(rows\)/);
  assert.doesNotMatch(source, /entryPrice: num\(state\.price\), status: 'confirmed'/);
});
