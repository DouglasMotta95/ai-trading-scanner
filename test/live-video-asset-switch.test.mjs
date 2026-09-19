import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');

test('visible CasaTrade chart remains the authoritative asset source on owned or legacy trader documents', () => {
  const focused = read('src/content/focused-asset-v2.js');
  const market = read('src/background-market-session.js');
  assert.match(focused, /const frameRole = traderHost\(host\) \? 'trader-frame' : 'casa-chart-frame'/);
  assert.match(focused, /if \(!traderHost\(host\) && !casaHost\(host\)\) return/);
  assert.match(focused, /chartScoped: true/);
  assert.match(focused, /reliable: true/);
  assert.match(focused, /pointerup/);
  assert.match(focused, /touchend/);
  assert.match(market, /message\?\.type === 'ATS_VISUAL_FOCUS_V2'/);
  assert.match(market, /if \(!info\.trusted \|\| message\.chartScoped !== true \|\| message\.reliable !== true/);
});

test('asset or timeframe switch clears every operational field that could leak the previous market', () => {
  const market = read('src/background-market-session.js');
  const start = market.indexOf('function resetForSession');
  const end = market.indexOf('\nfunction clockRecord', start);
  const reset = market.slice(start, end);
  for (const field of ['price: null','candles: []','currentCandle: null','marketHistory: {}','signal: null','lastConfirmed: null','tradeIntent: null','lastSeen: null']) {
    assert.ok(reset.includes(field), `missing reset field: ${field}`);
  }
  assert.match(reset, /marketClock: null/);
  assert.match(reset, /resetOrchestrator\(\)/);
});

test('runtime trusts only CasaTrade-owned charts or legacy trader frames under a CasaTrade top tab', () => {
  const market = read('src/background-market-session.js');
  assert.match(market, /const tabOwned = !!sender\.tab\?\.id && \(casaHost\(topHost\) \|\| traderHost\(topHost\)\)/);
  assert.match(market, /const embeddedTrader = tabOwned && traderHost\(frameHost\)/);
  assert.match(market, /const casaOwnedChart = tabOwned && casaHost\(frameHost\)/);
  assert.match(market, /trusted: embeddedTrader \|\| casaOwnedChart/);
  assert.match(market, /\['trader-frame', 'casa-chart-frame'\]\.includes\(role\)/);
});

test('overlay never draws analysis for another market, including OTC versus regular', () => {
  const overlay = read('src/content/analysis-visual-overlay-v2.js');
  assert.match(overlay, /const sameMarket = \(a, b\) => !!marketId\(a\) && marketId\(a\) === marketId\(b\)/);
  assert.match(overlay, /if \(!sameMarket\(focus\?\.asset, state\.asset\)\) return false/);
  assert.match(overlay, /if \(!sameMarket\(session\?\.asset, state\.asset\)\) return false/);
  assert.match(overlay, /if \(!sameMarket\(clock\?\.asset, state\.asset\)\) return false/);
  assert.doesNotMatch(overlay, /replace\([^\n]+OTC[^\n]+''\)/);
});


test('user-selected asset wins immediately over stale tabs and rendered fallback cannot fake selected state', () => {
  const focused = read('src/content/focused-asset-v2.js');
  const market = read('src/background-market-session.js');
  const rendered = read('src/content/canvas-probe.js');
  assert.match(focused, /source: 'user-selected-transition'/);
  assert.match(focused, /inactive market tab/);
  assert.match(focused, /interactionAge < 3500/);
  assert.match(market, /stale-visual-rollback-selection-lock/);
  assert.match(rendered, /selected: app\?\.selected === true/);
  assert.match(rendered, /selected: assetRow\?\.selected === true/);
  assert.doesNotMatch(rendered, /selected: true,\s*\n\s*confidence: 96/);
});


test('v0.11.30 passive visual scans cannot starve a new protocol-selected asset forever', () => {
  const protocol = read('src/content/focused-asset-protocol.js');
  assert.match(protocol, /Passive visual scans are republished frequently/);
  assert.match(protocol, /source === 'user-selected-transition'/);
  assert.match(protocol, /Date\.now\(\) - interactionAt < 3500/);
  assert.match(protocol, /return false;/);
});


test('protocol focus rejects ambiguous bare asset labels such as EURO so they cannot overwrite USO/USD', () => {
  const protocol = read('src/content/focused-asset-protocol.js');
  assert.match(protocol, /Protocol\/network focus must carry a real market identity/);
  assert.doesNotMatch(protocol, /\['EURO',\s*'EUR\/USD'\]/);
  assert.doesNotMatch(protocol, /aliases\.get\(bare\)/);
  assert.match(protocol, /return '';/);
});

test('focused asset reader exposes a forced rescan for retry without accepting stale protocol rollback', () => {
  const focused = read('src/content/focused-asset-v2.js');
  assert.match(focused, /__ATS_FORCE_FOCUSED_ASSET_SCAN__/);
  assert.match(focused, /schedulePublish\(0, true\)/);
  assert.match(focused, /protocol-rollback-visual-selection-lock/);
});


test('fresh visual focus blocks conflicting protocol-selected rollback even after hot reload', () => {
  const market = read('src/background-market-session.js');
  assert.match(market, /const freshVisualFocus = oldFresh/);
  assert.match(market, /assetChanged && incomingProtocolOnly && freshVisualFocus/);
  assert.match(market, /protocol-conflicts-fresh-visual-focus/);
});

test('asset readers use build markers so a new unpacked build can enter an already open CasaTrade tab', () => {
  const visual = read('src/content/focused-asset-v2.js');
  const protocol = read('src/content/focused-asset-protocol.js');
  assert.match(visual, /FOCUS_READER_BUILD/);
  assert.match(visual, /__ATS_FOCUSED_ASSET_TRACKER_V2_BUILD__/);
  assert.match(protocol, /PROTOCOL_FOCUS_BUILD/);
  assert.match(protocol, /__ATS_PROTOCOL_FOCUS_BUILD__/);
});


test('explicit asset selection remains authoritative until the next explicit user switch', () => {
  const market = read('src/background-market-session.js');
  assert.match(market, /const selectionLockActive = !!selectionLock\?\.asset/);
  assert.match(market, /The lock changes only on the next explicit user selection/);
  assert.doesNotMatch(market, /selectionLockFresh[\s\S]{0,160}< 8000/);
  assert.match(market, /assetChanged && !userSelected && contradictsSelectionLock/);
});

test('alias bridge cannot passively resurrect EURO or another stale alias after a switch', () => {
  const alias = read('src/content/focused-asset-alias-bridge.js');
  assert.match(alias, /Alias-only labels such as "Euro" or "NZD" are too ambiguous/);
  assert.match(alias, /if \(!asset \|\| Date\.now\(\) - Number\(recentInteraction\.at \|\| 0\) >= 3500\) return/);
  assert.match(alias, /interaction-only-v2/);
  assert.doesNotMatch(alias, /source: interacted \? 'user-selected-alias' : isSelected/);
});
