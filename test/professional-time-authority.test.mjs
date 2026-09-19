import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = path => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('CasaTrade time is the only authority for a user-facing entry', () => {
  const clock = read('src/content/market-cycle-clock-v4.js');
  const policy = read('src/background-decision-policy.js');
  const control = read('src/background-control.js');
  const panel = read('src/sidepanel/app-v2.js');

  assert.doesNotMatch(clock, /\|\|\s*'M1'/);
  assert.match(clock, /if \(expirySemantic && !candleSemantic\) continue/);
  assert.match(clock, /clockSource: 'platform-cycle-derived'/);
  assert.match(clock, /verified: false, operational: true/);
  assert.match(policy, /EXACT_CLOCK_SOURCES = new Set\(\['trader-dom-countdown', 'network-server-cycle'\]\)/);
  assert.match(policy, /clock\.verified !== true/);
  assert.match(policy, /Fonte de tempo não autoritativa/);
  assert.match(policy, /Expiração real da CasaTrade ainda não foi confirmada/);
  assert.match(control, /error: 'time_not_synchronized'/);
  assert.match(panel, /ESTIMADO • BLOQUEADO/);
  assert.match(panel, /model\.actionable && model\.direction === 'BUY' && timeReady/);
  assert.match(panel, /model\.actionable && model\.direction === 'SELL' && timeReady/);
});

test('live CasaTrade controls are authoritative and timeframe changes reset the market cycle', () => {
  const controls = read('src/background-platform-controls.js');
  const html = read('src/sidepanel/index.html');

  assert.match(controls, /liveAuthority: true/);
  assert.match(controls, /actualExpiration/);
  assert.match(controls, /timeframeChanged/);
  assert.match(controls, /professionalDecision: null/);
  assert.match(controls, /aiAudit: null/);
  assert.match(controls, /O tempo ao vivo da CasaTrade prevalece/);
  assert.doesNotMatch(html, /expiration-guard-ui\.js/);
  assert.doesNotMatch(html, /id="desiredExpiration"/);
});

test('professional policy mirrors the fixed A+ technical profile without a second signal gate', () => {
  const policy = read('src/background-decision-policy.js');
  const controls = read('src/background-platform-controls.js');
  assert.match(policy, /mode: 'A_PLUS'/);
  assert.match(policy, /holdSeconds: 3/);
  assert.match(policy, /Single authority rule/);
  assert.match(policy, /POSSIBLE_BUY/);
  assert.match(policy, /ENTER_BUY/);
  assert.match(controls, /mode: 'A_PLUS'/);
});

test('Gemini is a second reading only after the professional possible/final stage', () => {
  const ai = read('src/background-ai-analysis.js');
  const snapshot = read('src/services/ai-analysis.js');
  assert.match(ai, /effectiveDecision = state => state\?\.professionalDecision \|\| state\?\.signal/);
  assert.match(ai, /ui === 'POSSIBLE_BUY' \|\| ui === 'POSSIBLE_SELL'/);
  assert.match(ai, /state\.professionalDecision\?\.timeReady !== true/);
  assert.match(ai, /state\.analystPreferences\?\.geminiEnabled === false/);
  assert.match(snapshot, /clock\.verified === true && professional\.timeReady === true/);
  assert.doesNotMatch(snapshot, /GEMINI_API_KEY/);
});

test('sidepanel exposes only essential live settings and accessible time status', () => {
  const html = read('src/sidepanel/index.html');
  for (const id of ['alertLevel','notificationToggle','geminiToggle','heroCountdown','timeSyncStatus','prepareBuy','prepareSell']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  for (const id of ['analystMode','holdSeconds','desiredExpiration','overlayToggle']) {
    assert.doesNotMatch(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /aria-live="assertive"/);
  assert.match(html, /compact-live\.css/);
});
