import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');

test('video fix replaces sticky focus behavior while keeping guarded legacy compatibility entry', () => {
  const manifest = JSON.parse(read('manifest.json'));
  const scripts = manifest.content_scripts.flatMap(row => row.js || []);
  const v2 = scripts.indexOf('src/content/focused-asset-v2.js');
  const legacy = scripts.indexOf('src/content/focused-asset.js');
  assert.ok(v2 >= 0 && legacy > v2);
  const focus = read('src/content/focused-asset-v2.js');
  assert.match(focus, /__ATS_FOCUSED_ASSET_TRACKER__ = true/);
  assert.match(focus, /setTimeout\(\(\) => publishScan\(true\), 90\)/);
  assert.match(focus, /interaction-scan/);
  assert.doesNotMatch(focus, /let userSelection\s*=/);
  assert.match(focus, /ATS_VISUAL_FOCUS_V2/);
});

test('asset mismatch is a hard safety reset, not a connected stale signal', () => {
  const integrity = read('src/background-integrity.js');
  for (const field of ["connection: 'connecting'",'price: null','candles: []','currentCandle: null','signal: null','lastConfirmed: null','tradeIntent: null','lastSeen: null','timeframe: null','analysisTimeframe: null','expiration: null','targetExpiration: null']) {
    assert.ok(integrity.includes(field), `missing mismatch reset field: ${field}`);
  }
  assert.match(integrity, /state\.asset && !sameAsset\(state\.asset, focus\)/);
  assert.match(integrity, /resetOrchestrator\(\)/);
});

test('candle countdown has a moving phase fallback and supports absolute expiry clock', () => {
  const clock = read('src/content/market-clock-sync.js');
  assert.match(clock, /function phaseCountdown\(tf\)/);
  assert.match(clock, /\(Date\.now\(\) \/ 1000\) % span/);
  assert.match(clock, /absolute = local\.match/);
  assert.match(clock, /ATS_MARKET_CLOCK_V2/);
});

test('corrected clock feeds the same orchestrator so POSSIBLE can resolve inside final 10 seconds', () => {
  const integrity = read('src/background-integrity.js');
  const orchestrator = read('src/core/orchestrator.js');
  assert.match(integrity, /processSnapshot\(snapshot, state\)/);
  assert.match(orchestrator, /if \(secondsRemaining <= 10\)/);
  assert.match(orchestrator, /ANALYST_THRESHOLDS\.confirmScore/);
});

test('overlay v2 runs first in real embedded trader frame and guards the legacy overlay', () => {
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

test('background entry loads integrity layer and approved trading thresholds remain untouched', () => {
  const entry = read('src/background-entry.js');
  const analysis = read('src/core/analysis.js');
  assert.match(entry, /background-integrity\.js/);
  assert.match(analysis, /possibleScore:\s*44/);
  assert.match(analysis, /confirmScore:\s*58/);
  assert.match(analysis, /candleStrength:\s*62/);
  assert.match(analysis, /rejectionStrength:\s*50/);
});
