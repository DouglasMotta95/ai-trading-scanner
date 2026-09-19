import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');

test('expiration probe reads custom-control attributes and 00:01:00 format', () => {
  const probe = read('src/content/casatrade-expiration-probe.js');
  assert.match(probe, /\[aria-valuenow\]/);
  assert.match(probe, /\[data-value\]/);
  assert.match(probe, /aria-valuetext/);
  assert.match(probe, /Number\(m\[1\]\) \* 3600 \+ Number\(m\[2\]\) \* 60 \+ Number\(m\[3\]\)/);
  assert.match(probe, /function rawValues\(el\)/);
  assert.match(probe, /function parseExpiration\(raw = ''\)/);
  assert.match(probe, /seconds > 0 && seconds <= 3600/);
  assert.match(probe, /semantic-numeric-seconds/);
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


test('stale 5s high-confidence cache is functionally replaced by fresh 60s and cannot overwrite it back', () => {
  const source = read('src/background-platform-controls.js');
  const start = source.indexOf('function mergeObserved(');
  const end = source.indexOf('\nfunction analystPrefs', start);
  assert.ok(start >= 0 && end > start, 'mergeObserved source must be extractable');
  const mergeSource = source.slice(start, end);
  const now = Date.now();

  const forward = {
    previous: {
      expiration: '5s',
      source: 'old-cache',
      observedAt: { expiration: now - 8000 },
      confidence: { expiration: 99 }
    },
    incoming: {
      expiration: '60s',
      source: 'casatrade-network-control',
      observedAt: { expiration: now },
      confidence: { expiration: 84 }
    },
    result: null,
    Date
  };
  vm.runInNewContext(mergeSource + '\nresult = mergeObserved(previous, incoming);', forward);
  assert.equal(forward.result.expiration, '60s');
  assert.equal(forward.result.observedAt.expiration, now);
  assert.equal(forward.result.confidence.expiration, 84);

  const backward = {
    previous: forward.result,
    incoming: {
      expiration: '5s',
      source: 'stale-network',
      observedAt: { expiration: now - 4000 },
      confidence: { expiration: 97 }
    },
    result: null,
    Date
  };
  vm.runInNewContext(mergeSource + '\nresult = mergeObserved(previous, incoming);', backward);
  assert.equal(backward.result.expiration, '60s');
  assert.equal(backward.result.observedAt.expiration, now);
});

test('generic network duration requires trade expiration semantics and rejects generic order context', () => {
  const network = read('src/content/network-probe.js');
  const start = network.indexOf('const num =');
  const end = network.indexOf('  const canonicalAsset', start);
  assert.ok(start >= 0 && end > start, 'network expiration parser source must be extractable');
  const behaviorSource = network.slice(start, end);

  const run = parentKey => {
    const sandbox = {
      GENERIC_DURATION_KEY: /^duration$/i,
      CONTROL_EXP_KEY: /^__explicit_only__$/i,
      stats: { controlExpiration: null },
      now: () => 10000,
      result: null,
      parentKey
    };
    vm.runInNewContext(
      behaviorSource
        + "\nrecordControlExpiration('duration', 60, { parentKey, objectKeys: [parentKey, 'duration'] });"
        + "\nresult = stats.controlExpiration;",
      sandbox
    );
    return sandbox.result;
  };

  assert.equal(run('order'), null);
  const trade = run('trade');
  assert.equal(trade?.expiration, '60s');
  assert.equal(trade?.confidence, 84);
});


test('video regression: CasaTrade Expiração card selects its visible value instead of another dropdown option', () => {
  const probe = read('src/content/casatrade-expiration-probe.js');
  assert.match(probe, /function expirationControlByLabel\(all = \[\]\)/);
  assert.match(probe, /role === 'option' && !selectedLike\(el\)/);
  assert.match(probe, /explicitlyUnselected/);
  assert.match(probe, /sameContainer/);
  assert.match(probe, /selectedLike\(el\)/);
});

test('video regression: confirmed structured M1 can bound a plain MM:SS countdown without becoming clock authority itself', () => {
  const clock = read('src/content/market-cycle-clock-v4.js');
  assert.match(clock, /const colonOnly = \/\^\\d\{1,3\}:\[0-5\]\\d\$\//);
  assert.match(clock, /if \(!candleSemantic && !chartScoped && !colonOnly\) continue/);
  assert.match(clock, /function structuredFeedTf\(state = \{\}, focus = null\)/);
  assert.match(clock, /session\.dataReady !== true/);
  assert.match(clock, /return tf\(state\.analysisTimeframe \|\| state\.timeframe\)/);
  assert.match(clock, /liveCycleTf\(state, controlsFresh\) \|\| structuredFeedTf\(state, focus\)/);
  assert.match(clock, /return controlTf \|\| chartTf \|\| exactTf \|\| platformTf \|\| null/);
  assert.match(clock, /const progressed = !!previous/);
});

test('video regression: connection handshake requires a live clock but not candle count, expiration, or exact-entry authority', () => {
  const control = read('src/background-control.js');
  const start = control.indexOf('function handshakeReady(');
  const end = control.indexOf('\nfunction scheduleConnectionTimeout', start);
  assert.ok(start >= 0 && end > start);
  const handshake = control.slice(start, end);
  assert.match(handshake, /clock\.secondsRemaining/);
  assert.doesNotMatch(handshake, /rows\.length|expiration|EXACT_CLOCK_SOURCES/);
  assert.match(control, /if \(marketDataConnected\(state\)\)/);
  assert.match(control, /stage: 'syncing_clock'/);
  assert.match(control, /connection: 'online'/);
});

test('video regression: sidepanel keeps CONNECTED stable while exact entry clock remains a separate gate', () => {
  const shell = read('src/sidepanel/ui-shell-v2.js');
  const baseStart = shell.indexOf('function baseHandshake(');
  const baseEnd = shell.indexOf('\nfunction exactClockReady', baseStart);
  const exactStart = shell.indexOf('function exactClockReady(');
  const exactEnd = shell.indexOf('\nfunction exactLiveTime', exactStart);
  assert.ok(baseStart >= 0 && baseEnd > baseStart && exactStart >= 0 && exactEnd > exactStart);
  const base = shell.slice(baseStart, baseEnd);
  const exact = shell.slice(exactStart, exactEnd);
  assert.doesNotMatch(base, /rows\.length|EXACT_CLOCK_SOURCES|secondsRemaining/);
  assert.match(exact, /EXACT_CLOCK_SOURCES/);
  assert.match(shell, /connected \? 'CONECTADO' : 'DESCONECTADO'/);
  assert.match(shell, /if \(baseHandshake\(state\)\) return ''/);
});

test('video regression: recovered live feed clears stale connection timeout but never invents a warmup countdown', () => {
  const session = read('src/background-market-session.js');
  const app = read('src/sidepanel/app-v2.js');
  assert.match(session, /delete diagnostics\.connectionError/);
  assert.match(app, /COUNTDOWN REAL PENDENTE/);
  assert.doesNotMatch(app, /COUNTDOWN ESTIMADO/);
  assert.match(app, /return exactClockReady\(state\)/);
});
