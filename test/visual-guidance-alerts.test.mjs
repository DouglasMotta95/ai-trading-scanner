import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { analyzeCandles, waitingFor } from '../src/core/analysis.js';

const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');

const rows = [
  { open: 1.1000, high: 1.1040, low: 1.0990, close: 1.1030 },
  { open: 1.1030, high: 1.1060, low: 1.1020, close: 1.1050 },
  { open: 1.1050, high: 1.1080, low: 1.1040, close: 1.1070 },
  { open: 1.1070, high: 1.1100, low: 1.1060, close: 1.1090 },
  { open: 1.1090, high: 1.1098, low: 1.1082, close: 1.1094 }
];

test('analysis exposes the exact recent breakout levels and structured waitingFor guidance', () => {
  const result = analyzeCandles(rows, rows);
  assert.equal(result.recent.breakoutHigh, 1.1100);
  assert.equal(result.recent.breakoutLow, 1.0990);
  assert.equal(result.analytics.breakoutHigh, 1.1100);
  assert.equal(result.analytics.breakoutLow, 1.0990);
  assert.ok(result.waitingFor && typeof result.waitingFor === 'object');
  assert.match(result.waitingFor.text, /^Aguardando /);
  assert.ok(['breakout','rejection','power','candle_strength','continuation','possible_score','confirm_score','stability'].includes(result.waitingFor.type));
  const direct = waitingFor(result.recent, result.direction, result.score);
  assert.equal(direct.type, result.waitingFor.type);
});

test('overlay is optional, click-through and consumes scanner analysis instead of creating a second signal engine', () => {
  const manifest = JSON.parse(read('manifest.json'));
  const overlay = read('src/content/analysis-visual-overlay.js');
  const background = read('src/background.js');
  const isolatedScripts = manifest.content_scripts.flatMap(row => row.js || []);
  assert.ok(isolatedScripts.includes('src/content/analysis-visual-overlay.js'));
  assert.match(background, /analysis-visual-overlay\.js/);
  assert.match(overlay, /pointerEvents = 'none'/);
  assert.match(overlay, /ATS_READ_SCANNER_STATE/);
  assert.match(overlay, /response\?\.targeted === false \? null/);
  assert.match(background, /senderTabId === state\.targetTabId/);
  assert.match(overlay, /analytics\.breakoutHigh/);
  assert.match(overlay, /analytics\.breakoutLow/);
  assert.match(overlay, /overlayEnabled: false/);
  assert.match(overlay, /if \(!yFor\)[\s\S]*root\.hidden = true/);
  assert.doesNotMatch(overlay, /scannerState\?\.candles\.slice\(-10\)/);
  assert.doesNotMatch(overlay, /processSnapshot|analyzeCandles/);
});

test('sidepanel has three OFF-by-default controls and deduplicates sounds on principal-state transitions', () => {
  const html = read('src/sidepanel/index.html');
  const app = read('src/sidepanel/app.js');
  for (const id of ['overlayToggle','possibleSoundToggle','confirmSoundToggle']) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(app, /overlayEnabled: false/);
  assert.match(app, /possibleSoundEnabled: false/);
  assert.match(app, /confirmSoundEnabled: false/);
  assert.match(app, /if \(key === lastAudiblePrincipalKey\) return;/);
  assert.match(app, /POSSIBLE_BUY.*POSSIBLE_SELL/);
  assert.match(app, /ENTER_BUY.*ENTER_SELL/);
  assert.match(app, /playSignalTone\('possible'\)/);
  assert.match(app, /playSignalTone\('confirm'\)/);
});

test('sidepanel unwraps ATS_READ_SCANNER_STATE response envelope before rendering', () => {
  const app = read('src/sidepanel/app.js');
  assert.match(app, /const scannerState = state\?\.state \|\| \{\};/);
  assert.match(app, /const rendered = \{ \.\.\.scannerState, license \};/);
});
