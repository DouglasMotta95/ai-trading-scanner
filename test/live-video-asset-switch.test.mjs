import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');

test('user-selected asset stays authoritative until another real user selection', () => {
  const focused = read('src/content/focused-asset.js');
  const augment = read('src/background-augment.js');
  assert.match(focused, /if \(userSelection\) \{\s*return \{ asset: userSelection\.asset/s);
  const chooseCandidate = focused.match(/function chooseCandidate\(\) \{[\s\S]*?function publish/)?.[0] || '';
  assert.doesNotMatch(chooseCandidate, /userSelection = null/);
  assert.match(augment, /previousUserSelection && !incomingUserSelection/);
  assert.match(augment, /storedUserSelection && !incomingUserSelection/);
});

test('asset switch clears every operational field that could leak the previous pair', () => {
  const augment = read('src/background-augment.js');
  const reset = augment.match(/\.\.\.\(mustResetMarket \? \{([\s\S]*?)\} : \{\}\)/)?.[1] || '';
  for (const field of ['price: null','candles: []','currentCandle: null','signal: null','lastConfirmed: null','tradeIntent: null','lastSeen: null','timeframe: null','analysisTimeframe: null','expiration: null','targetExpiration: null','platformControls: null']) {
    assert.ok(reset.includes(field), `missing reset field: ${field}`);
  }
});

test('direct scan includes trusted embedded trader frame where the live chart may reside', () => {
  const background = read('src/background.js');
  assert.match(background, /const traderHost = host === 'casatraders\.online'/);
  assert.match(background, /ivcasatraders\.online/);
  assert.match(background, /if \(!casaHost && !traderHost\) return null/);
});

test('overlay never draws stale SHIB-scale analysis on a different visible asset', () => {
  const overlay = read('src/content/analysis-visual-overlay.js');
  assert.match(overlay, /function localVisibleAsset\(\)/);
  assert.match(overlay, /function overlayMatchesVisibleAsset\(\)/);
  assert.match(overlay, /Date\.now\(\) - lastSeen > 8000/);
  assert.match(overlay, /sameAsset\(visibleAsset, stateAsset\)/);
  assert.match(overlay, /!overlayMatchesVisibleAsset\(\)/);
});
