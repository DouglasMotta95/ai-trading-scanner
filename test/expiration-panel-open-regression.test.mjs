import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');

test('expiration probe reads custom-control attributes and 00:01:00 format', () => {
  const probe = read('src/content/casatrade-expiration-probe.js');
  assert.match(probe, /\[aria-valuenow\]/);
  assert.match(probe, /\[data-value\]/);
  assert.match(probe, /aria-valuetext/);
  assert.match(probe, /Number\(m\[1\]\) \* 3600 \+ Number\(m\[2\]\) \* 60 \+ Number\(m\[3\]\)/);
  assert.match(probe, /expirationFromSemanticElement/);
  assert.match(probe, /if \(seconds > 0 && seconds <= 3600\) return/);
});

test('network probe exports a dedicated expiration control instead of hiding it inside market candidates', () => {
  const network = read('src/content/network-probe.js');
  assert.match(network, /controlExpiration: null/);
  assert.match(network, /recordControlExpiration/);
  assert.match(network, /CONTROL_EXP_KEY/);
  assert.match(network, /controls: stats\.controlExpiration/);
  assert.match(network, /sourceKey: stats\.controlExpiration\.sourceKey/);
});

test('embedded feed promotes fresh network expiration into platform controls', () => {
  const bridge = read('src/content/embedded-feed-bridge.js');
  assert.match(bridge, /networkExpirationConfidence >= 84/);
  assert.match(bridge, /type: 'ATS_PLATFORM_CONTROLS_OBSERVED'/);
  assert.match(bridge, /source: 'casatrade-network-control'/);
});

test('fresh expiration can replace a stale higher-confidence cache', () => {
  const background = read('src/background-platform-controls.js');
  assert.match(background, /const previousStale = !previousAt \|\| Date\.now\(\) - previousAt >= 7000/);
  assert.match(background, /next\[field\] == null \|\| previousStale/);
});

test('panel open gets a fresh read window and silently reinjects current CasaTrade readers', () => {
  const shell = read('src/sidepanel/ui-shell-v2.js');
  const app = read('src/sidepanel/app-v2.js');
  assert.match(shell, /const PANEL_OPENED_AT = Date\.now\(\)/);
  assert.match(shell, /const expirationWaitAge = sessionAge > 0 \? Math\.min\(sessionAge, panelAge\) : panelAge/);
  assert.match(shell, /ATS_REFRESH_TARGET_TAB/);
  assert.match(shell, /refreshLiveReaders\(\)/);
  assert.match(app, /const PANEL_OPENED_AT = Date\.now\(\)/);
  assert.match(app, /return Math\.min\(Math\.max\(0, Date\.now\(\) - at\), panelAge\)/);
});

test('panel refresh targets the registered CasaTrade tab without reconnecting the active tab', () => {
  const background = read('src/background-control.js');
  assert.match(background, /async function refreshTargetTab\(\)/);
  assert.match(background, /const tabId = Number\(state\.targetTabId \|\| 0\)/);
  assert.match(background, /type === 'ATS_REFRESH_TARGET_TAB'/);
});

test('manual entry gate uses expiration-specific freshness', () => {
  const control = read('src/background-control.js');
  assert.match(control, /expirationCheckedAt/);
  assert.match(control, /const controlsFresh = expirationAt > 0 && Date\.now\(\) - expirationAt < 7000/);
});
