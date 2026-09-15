import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = path => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('side panel actually loads manual trade, bankroll and safe handoff surfaces', () => {
  const html = read('src/sidepanel/index.html');
  for (const script of ['manual-trade-ui.js', 'bankroll-ui.js', 'trade-handoff-ui.js']) {
    assert.match(html, new RegExp(`<script[^>]+src=["']${script.replace('.', '\\.')}`));
  }
  const manual = read('src/sidepanel/manual-trade-ui.js');
  assert.match(manual, /ATS_GET_MANUAL_TRADE_LEDGER/);
  assert.match(manual, /OPERAÇÃO MANUAL/);
  assert.match(manual, /SINAL \+ TIMING OK/);
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
