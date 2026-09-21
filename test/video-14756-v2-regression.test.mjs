import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { canonicalMarket, validateMarketBundle } from '../src/core/market-session-guard.js';
import { fastLiveDecision, resetFastLiveDecision } from '../src/core/live-fast-decision.js';

const read = path => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const candles = (close, count = 4) => Array.from({ length: count }, (_, i) => ({
  time: 1_700_000_000_000 + i * 60_000,
  open: close * .999,
  high: close * 1.002,
  low: close * .998,
  close,
  timeframe: 'M1'
}));

test('five rapid asset switches cannot mix previous asset identity or price scale', () => {
  const sequence = [
    ['ETH/USD (OTC)', 2482],
    ['AUD/CAD (OTC)', .9984],
    ['BTC/USD (OTC)', 63120],
    ['EUR/USD (OTC)', 1.0872],
    ['ETH/USD (OTC)', 2486],
    ['AUD/CAD (OTC)', .9987]
  ];

  for (let i = 1; i < sequence.length; i++) {
    const [oldAsset, oldPrice] = sequence[i - 1];
    const [newAsset, newPrice] = sequence[i];

    const staleIdentity = validateMarketBundle({
      focusAsset: newAsset,
      candidateAsset: oldAsset,
      price: oldPrice,
      candles: candles(oldPrice)
    });
    assert.equal(staleIdentity.ok, false);
    assert.equal(staleIdentity.reason, 'asset_identity_mismatch');

    const disguisedOldScale = validateMarketBundle({
      focusAsset: newAsset,
      candidateAsset: newAsset,
      price: oldPrice,
      candles: candles(newPrice)
    });
    if (Math.max(oldPrice,newPrice) / Math.min(oldPrice,newPrice) > 20) {
      assert.equal(disguisedOldScale.ok, false);
      assert.equal(disguisedOldScale.reason, 'price_history_scale_mismatch');
    }

    const current = validateMarketBundle({
      focusAsset: newAsset,
      candidateAsset: newAsset,
      price: newPrice,
      candles: candles(newPrice)
    });
    assert.equal(current.ok, true);
    assert.equal(current.asset, canonicalMarket(newAsset));
  }
});

test('asset switch reset is atomic and chart price cannot establish a new session alone', () => {
  const session = read('src/background-market-session.js');
  const reset = session.slice(session.indexOf('function resetForSession'), session.indexOf('function clockRecord'));
  const chartPrice = session.slice(session.indexOf('async function applyChartPrice'), session.indexOf('async function applyInspector'));

  assert.match(reset, /asset: null/);
  assert.match(reset, /price: null/);
  assert.match(reset, /candles: \[\]/);
  assert.match(reset, /marketHistory: \{\}/);
  assert.match(reset, /professionalDecision: null/);
  assert.match(reset, /aiAudit: null/);
  assert.match(reset, /pendingAsset: toAsset/);
  assert.match(reset, /dataReady: false/);
  assert.match(session, /confirmedAsset: asset/);
  assert.match(session, /dataReady: true/);
  assert.match(chartPrice, /if \(!message\.asset \|\| !sameMarket\(message\.asset, focus\.asset\)\) return/);
  assert.match(chartPrice, /session\.dataReady !== true/);
  assert.match(session, /assetSwitchLog/);
});

test('stable explicit cross-frame selection can replace a fresh old asset', () => {
  const session = read('src/background-market-session.js');
  assert.match(session, /assetChanged && frameChanged && oldFresh && !userSelected && !incomingExplicit && !incomingStable/);
});

test('expiration freshness belongs to expiration itself, never to unrelated control heartbeats', () => {
  const controls = read('src/background-platform-controls.js');
  const policy = read('src/background-decision-policy.js');
  const app = read('src/sidepanel/app-v2.js');
  assert.match(controls, /observedAt: \{/);
  assert.match(controls, /expirationCheckedAt: expirationAt/);
  assert.match(policy, /controls\.expirationCheckedAt/);
  assert.match(app, /controls\.expirationCheckedAt/);
  assert.doesNotMatch(app.slice(app.indexOf('function entryBlockReason'), app.indexOf('function decisionModel')), /targetExpiration \|\| state\.expiration/);
});

test('missing expiration stays pending and only a confirmed wrong value asks for 1 minute', () => {
  const app = read('src/sidepanel/app-v2.js');
  const block = app.slice(app.indexOf('function entryBlockReason'), app.indexOf('function gateKind'));
  assert.match(block, /EXPIRAÇÃO PENDENTE/);
  assert.match(block, /if \(expiration\.value !== '60s'\) return 'AJUSTE A EXPIRAÇÃO DA CASATRADE PARA 1 MINUTO'/);
  const shell = read('src/sidepanel/ui-shell-v2.js');
  assert.match(shell, /não foi possível confirmar o valor real/);
  const probe = read('src/content/casatrade-expiration-probe.js');
  assert.match(probe, /expirationControlByLabel/);
  assert.match(probe, /globalThis\.__ATS_SEND_MESSAGE__/);
  assert.match(probe, /chrome\.runtime\.sendMessage/);
});

test('countdown UI shows only the latest exact CasaTrade second and never estimates locally', () => {
  const app = read('src/sidepanel/app-v2.js');
  assert.match(app, /function smoothedRemaining/);
  assert.match(app, /if \(!exactClockReady\(state\)\) return null/);
  assert.match(app, /return Math\.max\(0, Math\.round\(raw\)\)/);
  assert.match(app, /EXATO • CASATRADE/);
  assert.doesNotMatch(app, /~ ESTIMADO/);
  assert.doesNotMatch(app, /COUNTDOWN ESTIMADO/);
});

test('connection status is not duplicated in the header', () => {
  const html = read('src/sidepanel/index.html');
  assert.equal((html.match(/id="connectionBadge"/g) || []).length, 0);
  assert.equal((html.match(/id="connectScannerText"/g) || []).length, 1);
});

function strongSignal(direction, score = 82) {
  const buy = direction === 'BUY';
  return {
    state: 'WATCH',
    uiState: buy ? 'POSSIBLE_BUY' : 'POSSIBLE_SELL',
    direction,
    analysisDirection: direction,
    score,
    analysisScore: score,
    analytics: {
      buyPower: buy ? 68 : 32,
      sellPower: buy ? 32 : 68,
      currentStrength: 72,
      momentumDirection: direction,
      momentumScore: 62,
      continuationDirection: direction,
      continuationScore: 67,
      rejectionDirection: direction,
      rejectionStrength: 55
    }
  };
}

test('direction flip shows re-evaluation before changing BUY/SELL verdict', () => {
  resetFastLiveDecision();
  const targetStart = 1_700_000_060_000;
  const first = fastLiveDecision(strongSignal('SELL', 70), {
    asset: 'AUD/CAD (OTC)', timeframe: 'M1', secondsRemaining: 25,
    targetStart, serverTime: 1_700_000_035_000
  });
  assert.equal(first.uiState, 'POSSIBLE_SELL');

  const flip1 = fastLiveDecision(strongSignal('BUY', 88), {
    asset: 'AUD/CAD (OTC)', timeframe: 'M1', secondsRemaining: 24,
    targetStart, serverTime: 1_700_000_035_100
  });
  assert.equal(flip1.uiState, 'DECIDING');
  assert.equal(flip1.phase, 'REASSESSING');
  assert.equal(flip1.directionTransition.from, 'SELL');
  assert.equal(flip1.directionTransition.to, 'BUY');

  const flip2 = fastLiveDecision(strongSignal('BUY', 88), {
    asset: 'AUD/CAD (OTC)', timeframe: 'M1', secondsRemaining: 23,
    targetStart, serverTime: 1_700_000_035_800
  });
  assert.equal(flip2.uiState, 'POSSIBLE_BUY');
});

test('technical POSSIBLE remains visible while execution gate is blocked', () => {
  const app = read('src/sidepanel/app-v2.js');
  const policy = read('src/background-decision-policy.js');
  assert.match(app, /possibleDirection/);
  assert.match(app, /POSSÍVEL/);
  assert.match(policy, /Expiration is an execution gate, not a technical-analysis gate/);
  assert.match(policy, /actionable: false/);
});

test('valid final-window pattern advances POSSIBLE to ENTER after two confirmations', () => {
  resetFastLiveDecision();
  const targetStart = 1_700_000_120_000;
  const first = fastLiveDecision(strongSignal('BUY', 84), {
    asset: 'AUD/CAD (OTC)', timeframe: 'M1', secondsRemaining: 5,
    targetStart, serverTime: 1_700_000_115_000
  });
  assert.equal(first.uiState, 'POSSIBLE_BUY');
  assert.notEqual(first.state, 'CONFIRM');

  const second = fastLiveDecision(strongSignal('BUY', 84), {
    asset: 'AUD/CAD (OTC)', timeframe: 'M1', secondsRemaining: 4,
    targetStart, serverTime: 1_700_000_115_800
  });
  assert.equal(second.uiState, 'ENTER_BUY');
  assert.equal(second.state, 'CONFIRM');
  assert.equal(second.direction, 'BUY');
});

test('data provenance, retry timeout, event log and expected asset preference are wired', () => {
  const html = read('src/sidepanel/index.html');
  const app = read('src/sidepanel/app-v2.js');
  const shell = read('src/sidepanel/ui-shell-v2.js');
  for (const id of ['assetSource','expirationSource','countdownSource','retryLiveRead','assetSwitchLog','expectedAsset','expectedAssetWarning']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(app, /expectedAsset:/);
  assert.match(app, /Você trocou para/);
  assert.match(app, /assetSwitchLog/);
  assert.match(app, /expirationTimedOut/);
  assert.match(shell, /expirationPending/);
  assert.match(shell, /ATUALIZANDO PARA/);
});
