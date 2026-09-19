import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');

test('expiration probe searches the whole visible CasaTrade text around the Expiração label', () => {
  const source = read('src/content/casatrade-expiration-probe.js');
  assert.match(source, /function bodyExpiration\(\)/);
  assert.match(source, /slice\(0, 260000\)/);
  assert.match(source, /body\.indexOf\(marker, from\)/);
  assert.match(source, /index \+ marker\.length/);
});

test('expiration probe can pair a visible Expiração label with a nearby 1 min value', () => {
  const source = read('src/content/casatrade-expiration-probe.js');
  assert.match(source, /function expirationControlByLabel\(all = \[\]\)/);
  assert.match(source, /expiracao\|expiry\|expiration/);
  assert.match(source, /sameContainer/);
  assert.match(source, /horizontalGap > 560/);
  assert.match(source, /selectedLike\(el\)/);
});

test('expiration probe also accepts a real duration immediately before the Expiração label', () => {
  const source = read('src/content/casatrade-expiration-probe.js');
  assert.match(source, /const reversed = spaced\.match/);
  assert.match(source, /Responsive layouts can reverse DOM\/text order/);
  assert.match(source, /r\.right < lr\.left/);
  assert.match(source, /parseExpiration/);
  assert.doesNotMatch(source, /expiration:\s*['"]60s['"]/);
});


test('v0.11.30 expiration reader uses rendered marker and platform-sync continuously publishes visible controls', () => {
  const probe = read('src/content/casatrade-expiration-probe.js');
  const sync = read('src/content/platform-sync.js');
  assert.match(probe, /function renderedMarkerExpiration\(\)/);
  assert.match(probe, /__ats_rendered_market__/);
  assert.match(probe, /rendered-market-marker/);
  assert.match(sync, /async function publishVisibleControls\(force = false\)/);
  assert.match(sync, /type: 'ATS_PLATFORM_CONTROLS_OBSERVED'/);
  assert.match(sync, /setInterval\(\(\) => publishVisibleControls\(true\)/);
});

test('expiration dirty detector no longer treats a broad ancestor containing Expiração as a control click', () => {
  const probe = read('src/content/casatrade-expiration-probe.js');
  const start = probe.indexOf('function expirationInteractionTarget');
  const end = probe.indexOf('\n  function scan()', start);
  const block = probe.slice(start, end);
  assert.match(block, /depth < 3/);
  assert.match(block, /own.length <= 90/);
  assert.match(block, /parentOwn.length <= 140/);
  assert.doesNotMatch(block, /semanticText\(node\)/);
});


test('expiration reader can anchor the selected duration to the trade panel below Valor', () => {
  const probe = read('src/content/casatrade-expiration-probe.js');
  assert.match(probe, /function tradePanelExpirationByAmount\(all = \[\]\)/);
  assert.match(probe, /function isAmountLabel\(el\)/);
  assert.match(probe, /trade-panel-below-amount/);
  assert.match(probe, /periodo da vela\|periodo de vela/);
  assert.match(probe, /countdown\|contagem\|fechamento da vela/);
});

test('timeframe reader requires candle-period semantics and rejects generic chart Período', () => {
  const probe = read('src/content/casatrade-expiration-probe.js');
  const start = probe.indexOf('function selectedTimeframe');
  const end = probe.indexOf('\n  const EXPIRATION_TRANSIENT_CACHE_MS', start);
  const block = probe.slice(start, end);
  assert.match(block, /const candleSemantic/);
  assert.match(block, /const chartRangeOnly/);
  assert.match(block, /periodo da vela\|periodo de vela\|candle period\|candle interval/);
  assert.match(block, /if \(!candleSemantic \|\| chartRangeOnly\) continue/);
});


test('expiration dirty recheck never erases an already confirmed CasaTrade duration by itself', () => {
  const background = read('src/background-platform-controls.js');
  const probe = read('src/content/casatrade-expiration-probe.js');
  const mergeStart = background.indexOf('function mergeObserved');
  const mergeEnd = background.indexOf('\nfunction analystPrefs', mergeStart);
  const merge = background.slice(mergeStart, mergeEnd);
  assert.match(merge, /expirationRecheckPendingAt/);
  assert.match(merge, /must not erase|Keep the last confirmed expiration/);
  assert.doesNotMatch(merge, /incoming\.expirationDirty[^\n]*[\s\S]{0,220}next\.expiration\s*=\s*null/);
  assert.match(probe, /function expirationFromInteraction\(event\)/);
  assert.match(probe, /source: 'casatrade-expiration-interaction'/);
  assert.match(probe, /expiration: interactedValue/);
});

test('reconnecting the same CasaTrade tab preserves a previously confirmed expiration', () => {
  const control = read('src/background-control.js');
  assert.match(control, /Reconnecting the same CasaTrade tab must not erase a platform control/);
  assert.match(control, /sameTab && confirmedExpiration && confirmedExpirationAt > 0/);
  assert.match(control, /platformControls: current\.platformControls/);
  assert.match(control, /targetExpiration: confirmedExpiration/);
});


test('mobile expiration dropdown keeps context so a bare 1 min option can confirm 60s', () => {
  const probe = read('src/content/casatrade-expiration-probe.js');
  assert.match(probe, /expirationInteractionWindowUntil/);
  assert.match(probe, /expirationInteractionWindowUntil = now \+ 5000/);
  assert.match(probe, /expirationFromInteraction\(event, insideOpenExpiration\)/);
  assert.match(probe, /if \(allowUnscoped\) return value/);
});


test('retry bypasses the fragile content-message expiration pipeline with a direct all-frame probe', () => {
  const control = read('src/background-control.js');
  assert.match(control, /async function directExpirationProbe\(tabId\)/);
  assert.match(control, /target: \{ tabId, allFrames: true \}/);
  assert.match(control, /background-direct-expiration-probe/);
  assert.match(control, /const directExpiration = await directExpirationProbe\(tabId\)/);
  assert.match(control, /await commitDirectExpiration\(tabId, directExpiration\)/);
});

test('direct expiration authority is written into the central platformControls state', () => {
  const control = read('src/background-control.js');
  const start = control.indexOf('async function commitDirectExpiration');
  const end = control.indexOf('\nasync function forceLiveControlRead', start);
  const block = control.slice(start, end);
  assert.match(block, /expirationCheckedAt: now/);
  assert.match(block, /liveAuthority: true/);
  assert.match(block, /targetExpiration: expiration/);
  assert.match(block, /expiration: expiration/);
  assert.match(block, /actual: expiration/);
});

test('sidepanel no longer depends exclusively on platformControls.observed.expiration', () => {
  const shell = read('src/sidepanel/ui-shell-v2.js');
  assert.match(shell, /function confirmedExpiration\(state = \{\}\)/);
  assert.match(shell, /state\.diagnostics\?\.expirationGuard\?\.actual/);
  assert.match(shell, /state\.targetExpiration/);
  assert.match(shell, /expirationAuthority\.confirmed/);
});
