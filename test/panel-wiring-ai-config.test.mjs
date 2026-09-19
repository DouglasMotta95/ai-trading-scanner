import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = path => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('compact side panel keeps safe handoff but omits legacy manual/bankroll polling surfaces', () => {
  const html = read('src/sidepanel/index.html');
  assert.match(html, /trade-handoff-ui\.js/);
  assert.doesNotMatch(html, /manual-trade-ui\.js/);
  assert.doesNotMatch(html, /bankroll-ui\.js/);
});

test('Gemini remains server-side only and uses the current stable Flash model by default', () => {
  const env = read('backend/.env.example');
  const manifest = read('manifest.json');
  const extensionSources = [
    read('src/sidepanel/app-v2.js'),
    read('src/services/telemetry.js'),
    manifest
  ].join('\n');

  assert.match(env, /^GEMINI_API_KEY=$/m);
  assert.match(env, /^GEMINI_MODEL=gemini-3\.8-flash$/m);
  assert.doesNotMatch(extensionSources, /GEMINI_API_KEY|generativelanguage\.googleapis\.com/);
});
