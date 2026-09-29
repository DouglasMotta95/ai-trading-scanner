import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');

test('critical CasaTrade readers are restartable after unpacked-extension reload', () => {
  const runtime = read('src/content/runtime-message-compat.js');
  assert.doesNotMatch(runtime, /if \(globalThis\.__ATS_RUNTIME_MESSAGE_COMPAT__\) return/);

  for (const path of [
    'src/content/focused-asset-v2.js',
    'src/content/focused-asset-alias-bridge.js',
    'src/content/focused-asset-protocol.js',
    'src/content/chart-frame-market-reader.js',
    'src/content/market-cycle-clock-v4.js',
    'src/content/casatrade-ui-observer-v2.js',
    'src/content/casatrade-expiration-probe.js'
  ]) {
    const source = read(path);
    assert.doesNotMatch(source, /if \(globalThis\.__ATS_[A-Z0-9_]+\) return;/, path);
    assert.match(source, /teardown\(\)/, path);
  }
});

test('modern injector kicks focus, controls, expiration, price and candle clock immediately', () => {
  const source = read('src/background-modern-injector.js');
  for (const hook of [
    '__ATS_FORCE_ALIAS_FOCUS_SCAN__',
    '__ATS_FORCE_FOCUS_SCAN__',
    '__ATS_FORCE_UI_CONTROL_SCAN__',
    '__ATS_FORCE_EXPIRATION_SCAN__',
    '__ATS_FORCE_CHART_PRICE_SCAN__',
    '__ATS_FORCE_MARKET_CLOCK_SCAN__'
  ]) assert.ok(source.includes(hook), hook);
  assert.match(source, /missingCritical/);
  assert.match(source, /readersKicked/);
});

test('tablet chart-header geometry can confirm the visible active instrument', () => {
  const focus = read('src/content/focused-asset-v2.js');
  const alias = read('src/content/focused-asset-alias-bridge.js');
  assert.match(focus, /function chartHeaderGeometry/);
  assert.match(focus, /if \(listContext && !selection\.explicit && !interaction && !geometricHeader\) continue/);
  assert.match(alias, /function chartHeaderGeometry/);
  assert.match(alias, /geometricHeader \? 1100 : 720/);
});

test('stale score and asset-quality verdict are blocked until the live session is confirmed', () => {
  const guidance = read('src/sidepanel/signal-guidance-ui.js');
  const quality = read('src/sidepanel/asset-quality-ui.js');
  assert.match(guidance, /function marketReady/);
  assert.match(guidance, /value: 'AGUARDANDO DADOS'/);
  assert.match(guidance, /const scoreRaw = ready \?/);
  assert.match(quality, /session\.dataReady === true/);
  assert.match(quality, /sameMarket\(session\.confirmedAsset, state\.asset\)/);
});

test('reader recovery button appears when a linked CasaTrade session stalls without an asset', () => {
  const app = read('src/sidepanel/app-v2.js');
  const shell = read('src/sidepanel/ui-shell-v2.js');
  assert.match(app, /const marketTimedOut = activeLicense\(state\)/);
  assert.match(app, /!!state\.targetTabId/);
  assert.match(shell, /const marketPending = !dataConnected/);
  assert.match(shell, /TENTAR NOVAMENTE para reinjetar sem recarregar a CasaTrade/);
});
