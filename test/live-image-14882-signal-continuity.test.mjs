import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');

test('14882: same-asset frame handoff cannot reset the market session or signal', () => {
  const session = read('src/background-market-session.js');
  assert.match(session, /a shell -> trader frame handoff is NOT a market switch/);
  const handoff = session.indexOf('const traderHandoff');
  const nextFocus = session.indexOf('const previousStableSince', handoff);
  const block = session.slice(handoff, nextFocus);
  const branchStart = block.indexOf('else if (traderHandoff)');
  const handoffBranch = block.slice(branchStart);
  assert.ok(branchStart >= 0);
  assert.doesNotMatch(handoffBranch, /resetForSession\(/);
  assert.match(handoffBranch, /source: 'same-market-trader-handoff'/);
});

test('14882: central orchestrator reset key ignores frame id and frame host', () => {
  const background = read('src/background.js');
  const start = background.indexOf('const marketKey = [');
  const end = background.indexOf("].join('|');", start);
  const block = background.slice(start, end);
  assert.match(block, /snapshot\.asset/);
  assert.match(block, /snapshot\.analysisTimeframe/);
  assert.match(block, /session\.epoch/);
  assert.doesNotMatch(block, /frameId/);
  assert.doesNotMatch(block, /frameHost/);
});

test('14882: fallback signal cycle is keyed to target candle, not 5-second slices', () => {
  const orchestrator = read('src/core/orchestrator.js');
  assert.match(orchestrator, /const targetKey = Math\.round\(rawTarget \/ tfMs\) \* tfMs/);
  assert.doesNotMatch(orchestrator, /Math\.round\(rawTarget \/ 5000\)/);
});

test('14882: opposite direction must remain sustained for at least four seconds', () => {
  const orchestrator = read('src/core/orchestrator.js');
  assert.match(orchestrator, /OPPOSITE_MIN_HOLD_MS = 4000/);
  assert.match(orchestrator, /oppositeHeldFor >= OPPOSITE_MIN_HOLD_MS/);
  assert.match(orchestrator, /OPPOSITE_SWITCH_HITS = 3/);
  assert.match(orchestrator, /FINAL_CANDIDATE_MIN_AGE_MS = 3000/);
});

test('14882: final signal persists through the target entry candle', () => {
  const background = read('src/background.js');
  const app = read('src/sidepanel/app-v2.js');
  assert.match(background, /entryAdvice/);
  assert.match(background, /activeUntil: signalTargetStart \+ tfMs/);
  assert.match(app, /function activeEntryAdvice/);
  assert.match(app, /SINAL DA VELA/);
  assert.match(app, /Não repetir a entrada/);
});

test('14882: named OTC assets such as Vaulta are valid only from trusted visual OTC identity', () => {
  const focused = read('src/content/focused-asset-v2.js');
  const session = read('src/background-market-session.js');
  assert.match(focused, /function namedChartAsset/);
  assert.match(focused, /\(\\s\*OTC\\s\*\)/);
  assert.match(focused, /AMBIGUOUS_NAMED/);
  assert.match(focused, /assetsIn\(value\)\[0\] \|\| namedChartAsset\(value\)/);
  assert.match(session, /named OTC instruments/);
  assert.match(session, /if \(otc && \/\^\[A-Z0-9\]/);
});

test('14882: asset/session reset explicitly clears old entry advice', () => {
  const session = read('src/background-market-session.js');
  const clearStart = session.indexOf('export function clearMarketAuthorityState');
  const resetStart = session.indexOf('export function resetForSession');
  assert.match(session.slice(clearStart, resetStart), /entryAdvice: null/);
  assert.match(session.slice(resetStart, session.indexOf('\nfunction clockRecord', resetStart)), /entryAdvice: null/);
});
