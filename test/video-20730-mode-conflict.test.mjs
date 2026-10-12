import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');

test('mode conflicts only consume per-field CasaTrade readings from the focused frame', () => {
  const panel = read('src/sidepanel/app-v2.js');
  const controls = read('src/background-platform-controls.js');

  assert.match(panel, /const focusFrame = Number\(focus\.frameId\)/);
  assert.match(panel, /const frameId = Number\(observed\.frameIds\?\.\[field\]\)/);
  assert.match(panel, /const source = clean\(observed\.sourceByField\?\.\[field\] \|\| ''\)/);
  assert.match(panel, /frameId === focusFrame \|\| \(frameId === 0 && focus\.embeddedTrader === true\)/);
  assert.match(panel, /now - at >= 0 && now - at < 15000/);

  assert.match(controls, /frameId: Number\(sender\.frameId \|\| 0\)/);
  assert.match(controls, /next\.sourceByField\[field\] = incomingSource/);
  assert.match(controls, /next\.frameIds\[field\] =/);
});

test('mode-conflict evidence does not rely on the merged global source label', () => {
  const panel = read('src/sidepanel/app-v2.js');
  const start = panel.indexOf('function freshCasaTradeControlEvidence(');
  const end = panel.indexOf('\nfunction casaTradeTimeframeEvidence(', start);
  assert.ok(start >= 0 && end > start);
  const helper = panel.slice(start, end);
  assert.doesNotMatch(helper, /const source = clean\(observed\.source\)/);
  assert.match(helper, /observed\.sourceByField\?\.\[field\]/);
  assert.match(helper, /if \(!tf && !exp\) return null/);
});

test('hidden mode-conflict banner is actually removed from layout when aligned', () => {
  const html = read('src/sidepanel/index.html');
  assert.match(html, /\.mode-conflict-banner\[hidden\]\s*\{\s*display:\s*none\s*;?\s*\}/);
  assert.match(html, /id="modeConflictBanner"[^>]*hidden/);
});

test('video 20730 fix increments package version and leaves execution gates present', () => {
  const manifest = JSON.parse(read('manifest.json'));
  const pkg = JSON.parse(read('package.json'));
  const panel = read('src/sidepanel/app-v2.js');
  assert.equal(manifest.version, '0.12.6');
  assert.equal(pkg.version, manifest.version);
  assert.equal(manifest.version_name, '0.12.6-active-asset-analysis-recovery');
  assert.match(panel, /if \(!exactClockReady\(state\)\) return false/);
  assert.match(panel, /const canBuy = !alignment\.conflict && model\.actionable/);
});
