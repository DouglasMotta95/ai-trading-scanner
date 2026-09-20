import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');

test('exact CasaTrade clock may be bound from trusted top control frame to the focused market frame', () => {
  const reader = read('src/content/market-cycle-clock-v4.js');
  const session = read('src/background-market-session.js');

  assert.match(reader, /const casaControlFrame = casaHost\(host\) && window === window\.top/);
  assert.match(reader, /crossFrameControl: casaControlFrame && !sameFocusFrame/);
  assert.match(reader, /boundFocusFrameId: Number\(focus\.frameId\)/);

  assert.match(session, /const crossFrameControl = message\.crossFrameControl === true/);
  assert.match(session, /info\.casaOwnedChart === true/);
  assert.match(session, /Number\(info\.frameId\) === 0/);
  assert.match(session, /boundFocusFrameId/);
  assert.match(session, /boundFocusFrameHost/);
});

test('central analysis and decision policy accept only a clock bound to the current focus', () => {
  const background = read('src/background.js');
  const policy = read('src/background-decision-policy.js');
  for (const source of [background, policy]) {
    assert.match(source, /function|const clockBoundToFocus/);
    assert.match(source, /clock\.crossFrameControl === true/);
    assert.match(source, /clock\.boundFocusFrameId/);
    assert.match(source, /clock\.boundFocusFrameHost/);
  }
});

test('feed bridge and platform sync are restartable after extension reload', () => {
  const feed = read('src/content/embedded-feed-bridge.js');
  const platform = read('src/content/platform-sync.js');

  assert.doesNotMatch(feed, /if \(globalThis\.__ATS_EMBEDDED_FEED_BRIDGE__\) return/);
  assert.match(feed, /__ATS_EMBEDDED_FEED_BRIDGE_RUNTIME__/);
  assert.match(feed, /removeEventListener\('message', networkMessageHandler\)/);

  assert.doesNotMatch(platform, /if \(globalThis\.__ATS_PLATFORM_SYNC__\) return/);
  assert.match(platform, /__ATS_PLATFORM_SYNC_RUNTIME__/);
  assert.match(platform, /removeListener\(runtimeMessageHandler\)/);
  assert.match(platform, /publishVisibleControls/);
  assert.match(platform, /ATS_PLATFORM_CONTROLS_OBSERVED/);
});

test('market focus and clock have one runtime writer', () => {
  const owner = read('src/background-market-session.js');
  const integrity = read('src/background-integrity.js');

  assert.match(owner, /message\?\.type === 'ATS_VISUAL_FOCUS_V2'/);
  assert.match(owner, /message\?\.type === 'ATS_MARKET_CLOCK_V2'/);
  assert.doesNotMatch(integrity, /message\?\.type === 'ATS_VISUAL_FOCUS_V2'/);
  assert.doesNotMatch(integrity, /message\?\.type === 'ATS_MARKET_CLOCK_V2'/);
});

test('all user-facing timing gates accept the same bound exact clock contract', () => {
  for (const path of [
    'src/sidepanel/app-v2.js',
    'src/sidepanel/ui-shell-v2.js',
    'src/sidepanel/signal-guidance-ui.js',
    'src/sidepanel/live-integrity-ui.js',
    'src/sidepanel/trade-handoff-ui.js',
    'src/background-control.js'
  ]) {
    const source = read(path);
    assert.match(source, /crossFrameControl/);
    assert.match(source, /boundFocusFrameId/);
    assert.match(source, /boundFocusFrameHost/);
  }
});
