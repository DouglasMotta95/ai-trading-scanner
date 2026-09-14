from pathlib import Path

p = Path('src/background.js')
s = p.read_text()

import_line = "import { resolveSignalHistory, signalPerformance } from './core/signal-outcomes.js';\n"
if import_line not in s:
    needle = "import { readScannerState, updateScannerState, replaceScannerState } from './services/scanner-state-atomic.js';\n"
    assert needle in s
    s = s.replace(needle, needle + import_line, 1)

old_record = '''function localSignalRecord(state) {
  const s = state.signal || {};
  return {
    id: crypto.randomUUID(), at: Date.now(), asset: state.asset || '—', platform: 'CasaTrade', direction: s.direction,
    timeframe: state.analysisTimeframe || s.timeframe || state.timeframe || null,
    expiration: state.targetExpiration || s.targetExpiration || state.expiration || null,
    entryPrice: num(state.price), status: 'confirmed'
  };
}
'''
new_record = '''function localSignalRecord(state) {
  const s = state.signal || {};
  return {
    id: crypto.randomUUID(), at: Date.now(), asset: state.asset || '—', platform: 'CasaTrade', direction: s.direction,
    timeframe: state.analysisTimeframe || s.timeframe || state.timeframe || null,
    expiration: state.targetExpiration || s.targetExpiration || state.expiration || null,
    targetStart: num(s.targetStart), score: Number(s.score || 0), regime: s.regime?.type || null,
    entryPrice: null, exitPrice: null, result: null, status: 'pending', outcomeBasis: 'target_candle_open_close'
  };
}
'''
if old_record in s:
    s = s.replace(old_record, new_record, 1)

marker = '''async function appendSessionHistory(record) {
  const stored = await chrome.storage.session.get(SESSION_HISTORY_KEY);
  const rows = Array.isArray(stored[SESSION_HISTORY_KEY]) ? stored[SESSION_HISTORY_KEY] : [];
  await chrome.storage.session.set({ [SESSION_HISTORY_KEY]: [record, ...rows].slice(0, 50) });
}
'''
resolver = marker + '''
async function resolveSessionHistoryOutcomes(marketState = {}) {
  const stored = await chrome.storage.session.get(SESSION_HISTORY_KEY);
  const rows = Array.isArray(stored[SESSION_HISTORY_KEY]) ? stored[SESSION_HISTORY_KEY] : [];
  if (!rows.length) return [];
  const outcome = resolveSignalHistory(rows, marketState);
  if (!outcome.resolved.length) return [];
  await chrome.storage.session.set({ [SESSION_HISTORY_KEY]: outcome.rows.slice(0, 50) });
  return outcome.resolved;
}
'''
if 'async function resolveSessionHistoryOutcomes' not in s:
    assert marker in s
    s = s.replace(marker, resolver, 1)

old_tail = '''  if (processedSnapshot) await persistCompletedDecisionCache().catch(() => {});
  if (confirmedRecord) {
    await appendSessionHistory(confirmedRecord);
    await telemetryEvent('signal_confirmed', confirmedRecord, settings);
  }
  telemetryHeartbeat(next, settings, becameConfirm);
  return next;
}
'''
new_tail = '''  if (processedSnapshot) await persistCompletedDecisionCache().catch(() => {});
  if (confirmedRecord) {
    await appendSessionHistory(confirmedRecord);
    await telemetryEvent('signal_confirmed', confirmedRecord, settings);
  }
  if (processedSnapshot) {
    const resolvedRecords = await resolveSessionHistoryOutcomes(next).catch(() => []);
    for (const record of resolvedRecords) await telemetryEvent('signal_resolved', record, settings);
  }
  telemetryHeartbeat(next, settings, becameConfirm);
  return next;
}
'''
if old_tail in s:
    s = s.replace(old_tail, new_tail, 1)

old_history = '''  if (message?.type === 'ATS_GET_SESSION_HISTORY') {
    chrome.storage.session.get(SESSION_HISTORY_KEY).then(x => sendResponse({
      ok: true,
      rows: Array.isArray(x[SESSION_HISTORY_KEY]) ? x[SESSION_HISTORY_KEY] : []
    }));
    return true;
  }
'''
new_history = '''  if (message?.type === 'ATS_GET_SESSION_HISTORY') {
    chrome.storage.session.get(SESSION_HISTORY_KEY).then(x => {
      const rows = Array.isArray(x[SESSION_HISTORY_KEY]) ? x[SESSION_HISTORY_KEY] : [];
      sendResponse({ ok: true, rows, performance: signalPerformance(rows) });
    });
    return true;
  }
'''
if old_history in s:
    s = s.replace(old_history, new_history, 1)

required = [
    "resolveSignalHistory, signalPerformance",
    "status: 'pending'",
    "targetStart: num(s.targetStart)",
    "async function resolveSessionHistoryOutcomes",
    "telemetryEvent('signal_resolved'",
    "performance: signalPerformance(rows)"
]
for item in required:
    assert item in s, item
p.write_text(s)

Path('test/demo-outcome-wiring.test.mjs').write_text("""import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('background records pending signals and resolves only exact target-candle outcomes', async () => {
  const source = await readFile(new URL('../src/background.js', import.meta.url), 'utf8');
  assert.match(source, /resolveSignalHistory, signalPerformance/);
  assert.match(source, /targetStart: num\\(s\\.targetStart\\)/);
  assert.match(source, /entryPrice: null, exitPrice: null, result: null, status: 'pending'/);
  assert.match(source, /resolveSessionHistoryOutcomes\\(next\\)/);
  assert.match(source, /telemetryEvent\\('signal_resolved'/);
  assert.match(source, /performance: signalPerformance\\(rows\\)/);
  assert.doesNotMatch(source, /entryPrice: num\\(state\\.price\\), status: 'confirmed'/);
});
""")
