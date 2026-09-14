import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');

test('focused asset is sourced only from the embedded trader chart frame', () => {
  const focus = read('src/content/focused-asset-v2.js');
  assert.match(focus, /if \(!traderHost\(host\)\) return/);
  assert.match(focus, /function chartRect\(\)/);
  assert.match(focus, /function nearChart\(rect, chart\)/);
  assert.match(focus, /chartScoped: true/);
  assert.match(focus, /frameRole: 'trader-frame'/);
  assert.doesNotMatch(focus, /type:\s*'ATS_FOCUSED_ASSET'/);
  assert.doesNotMatch(focus, /casa-shell/);
});

test('ambiguous simultaneous asset labels are rejected instead of guessing a pair', () => {
  const focus = read('src/content/focused-asset-v2.js');
  assert.match(focus, /const second = winners\[1\] \|\| null/);
  assert.match(focus, /if \(gap < \(first\.explicit \? 120 : 280\)\) return null/);
  assert.match(focus, /assets\.length !== 1/);
});

test('background accepts focus only from the trusted embedded chart frame', () => {
  const integrity = read('src/background-integrity.js');
  assert.match(integrity, /const embeddedTrader = sender\.frameId !== 0 && traderHost\(frameHost\) && casaHost\(topHost\)/);
  assert.match(integrity, /message\.chartScoped !== true/);
  assert.match(integrity, /message\.frameRole !== 'trader-frame'/);
  assert.match(integrity, /authority: 'visible-chart-frame'/);
});

test('asset mismatch or missing chart authority is a hard safety reset', () => {
  const integrity = read('src/background-integrity.js');
  for (const field of ["connection: 'connecting'",'price: null','candles: []','currentCandle: null','signal: null','lastConfirmed: null','tradeIntent: null','lastSeen: null']) {
    assert.ok(integrity.includes(field), `missing reset field: ${field}`);
  }
  assert.match(integrity, /awaiting_visible_chart_asset/);
  assert.match(integrity, /asset_mismatch_blocked/);
  assert.match(integrity, /chrome\.storage\.onChanged\.addListener/);
});

test('clock uses only exact CasaTrade DOM countdown and has no synthetic phase fallback', () => {
  const clock = read('src/content/market-clock-sync.js');
  assert.match(clock, /if \(!traderHost\(host\)\) return/);
  assert.match(clock, /hora de compra\|buy time\|entry time/);
  assert.match(clock, /clockSource: 'trader-dom-countdown'/);
  assert.match(clock, /clockSource: 'trader-dom-unavailable'/);
  assert.match(clock, /verified: true/);
  assert.match(clock, /available: false/);
  assert.doesNotMatch(clock, /function phaseCountdown/);
  assert.doesNotMatch(clock, /timeframe-phase/);
});

test('clock is accepted only from the same authoritative frame as the visible asset', () => {
  const integrity = read('src/background-integrity.js');
  assert.match(integrity, /Number\(focusMeta\?\.frameId\) === Number\(sender\.frameId\)/);
  assert.match(integrity, /clean\(message\.clockSource\) === 'trader-dom-countdown'/);
  assert.match(integrity, /message\.verified === true/);
  assert.match(integrity, /awaiting_exact_clock/);
});

test('signals with missing or mismatched CasaTrade clock are removed immediately', () => {
  const integrity = read('src/background-integrity.js');
  assert.match(integrity, /signalClockMismatch/);
  assert.match(integrity, /signal_blocked_without_exact_clock/);
  assert.match(integrity, /signalSeconds !== clockSeconds/);
  assert.match(integrity, /CLOCK_FRESH_MS = 1400/);
});

test('exact clock feeds the same orchestrator used for next-candle prediction', () => {
  const integrity = read('src/background-integrity.js');
  const orchestrator = read('src/core/orchestrator.js');
  assert.match(integrity, /clockVerified: true/);
  assert.match(integrity, /processSnapshot\(snapshot, state\)/);
  assert.match(orchestrator, /if \(secondsRemaining <= 10\)/);
  assert.match(orchestrator, /ANALYST_THRESHOLDS\.confirmScore/);
});

test('overlay v2 remains wired before the guarded legacy overlay', () => {
  const manifest = JSON.parse(read('manifest.json'));
  const scripts = manifest.content_scripts.flatMap(row => row.js || []);
  const v2 = scripts.indexOf('src/content/analysis-visual-overlay-v2.js');
  const legacy = scripts.indexOf('src/content/analysis-visual-overlay.js');
  assert.ok(v2 >= 0 && legacy > v2);
  const overlay = read('src/content/analysis-visual-overlay-v2.js');
  assert.match(overlay, /__ATS_ANALYSIS_VISUAL_OVERLAY__ = true/);
  assert.match(overlay, /casatraders\.online/);
  assert.match(overlay, /ivcasatraders\.online/);
  for (const label of ['Preço atual','Resistência','Suporte','Gatilho compra ↑','Gatilho venda ↓','Aguardando']) assert.ok(overlay.includes(label), `missing overlay label ${label}`);
  assert.match(overlay, /pointerEvents: 'none'/);
});

test('approved trading thresholds remain untouched', () => {
  const entry = read('src/background-entry.js');
  const analysis = read('src/core/analysis.js');
  assert.match(entry, /background-integrity\.js/);
  assert.match(analysis, /possibleScore:\s*44/);
  assert.match(analysis, /confirmScore:\s*58/);
  assert.match(analysis, /candleStrength:\s*62/);
  assert.match(analysis, /rejectionStrength:\s*50/);
});
