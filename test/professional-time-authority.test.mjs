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
  assert.match(clock, /if \(expirySemantic && !candleSemantic && !chartScoped\) continue/);
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

test('live CasaTrade controls override preferences and timeframe changes reset the market cycle', () => {
  const controls = read('src/background-platform-controls.js');
  const guard = read('src/sidepanel/expiration-guard-ui.js');

  assert.match(controls, /liveAuthority: true/);
  assert.match(controls, /actualExpiration/);
  assert.match(controls, /timeframeChanged/);
  assert.match(controls, /professionalDecision: null/);
  assert.match(controls, /aiAudit: null/);
  assert.match(controls, /O tempo ao vivo da CasaTrade prevalece/);
  assert.match(guard, /seguindo a plataforma automaticamente/);
  assert.match(guard, /O tempo ao vivo prevalece/);
  assert.doesNotMatch(guard, /prepareBuy.*disabled/);
  assert.doesNotMatch(guard, /prepareSell.*disabled/);
});

test('professional policy provides Normal and A+ confluence plus stable 3-5 second hold', () => {
  const policy = read('src/background-decision-policy.js');
  assert.match(policy, /pref\.mode === 'A_PLUS' \? 3 : 2/);
  assert.match(policy, /pref\.mode === 'A_PLUS' \? 52 : 44/);
  assert.match(policy, /pref\.mode === 'A_PLUS' \? 66 : 58/);
  assert.match(policy, /holdSeconds: clamp\(raw\.holdSeconds/);
  assert.match(policy, /Math\.max\(0, holdMs - heldFor\)/);
  assert.match(policy, /POSSIBLE_BUY/);
  assert.match(policy, /POSSIBLE_SELL/);
  assert.match(policy, /ENTER_BUY/);
  assert.match(policy, /ENTER_SELL/);
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

test('sidepanel exposes the professional preferences and accessible time status', () => {
  const html = read('src/sidepanel/index.html');
  for (const id of ['analystMode','alertLevel','holdSeconds','desiredExpiration','overlayToggle','geminiToggle','heroCountdown','heroTimeStatus','timeSyncStatus']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /Só A\+/);
  assert.match(html, /Automático \/ seguir CasaTrade/);
  assert.match(html, /aria-live="assertive"/);
  assert.match(html, /professional\.css/);
});
