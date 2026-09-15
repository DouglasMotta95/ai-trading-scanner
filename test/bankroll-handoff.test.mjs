import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = path => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('0.11.9 wires passive bankroll observation and safe trade handoff', () => {
  const manifest = JSON.parse(read('manifest.json'));
  const files = manifest.content_scripts.flatMap(row => row.js || []);
  assert.equal(manifest.version, '0.11.9');
  assert.ok(files.includes('src/content/account-metrics-observer.js'));
  assert.ok(files.includes('src/content/trade-handoff-v2.js'));

  const observer = read('src/content/account-metrics-observer.js');
  assert.match(observer, /ATS_ACCOUNT_METRICS/);
  assert.match(observer, /platform-dom-labelled/);
  assert.match(observer, /\\d\[\\d\.,\\s\]\*/);
  assert.match(observer, /topBarBalanceCandidate/);
  assert.match(observer, /deposit\|depositar/);
  assert.match(observer, /invest/);
  assert.match(observer, /lucro\|profit/);
  assert.match(observer, /shadowRoot/);
  assert.match(observer, /parsed\.value <= 0/);
  assert.doesNotMatch(observer, /\.click\s*\(/);

  const handoff = read('src/content/trade-handoff-v2.js');
  assert.match(handoff, /ATS_HIGHLIGHT_TRADE/);
  assert.match(handoff, /scrollIntoView/);
  assert.match(handoff, /const ambiguous =/);
  assert.match(handoff, /top\.score - second\.score < 2/);
  assert.match(handoff, /item\.score >= 6/);
  assert.doesNotMatch(handoff, /\.click\s*\(/);
});

test('bankroll state is descriptive, confidence-aware and rejects false zero metrics', () => {
  const bg = read('src/background-account-metrics.js');
  assert.match(bg, /currentStake \/ currentBalance/);
  assert.match(bg, /sessionDelta/);
  assert.match(bg, /MIN_CONFIDENCE/);
  assert.match(bg, /METRIC_FRESH_MS/);
  assert.match(bg, /confidence >= oldConfidence/);
  assert.match(bg, /positiveRequired && value <= 0/);
  assert.match(bg, /ATS_GET_ACCOUNT_METRICS/);

  const ui = read('src/sidepanel/trade-handoff-ui.js');
  assert.match(ui, /ATS_PREPARE_TRADE/);
  assert.match(ui, /ATS_HIGHLIGHT_TRADE/);
  assert.match(ui, /Confirme com seu toque na plataforma/);
  assert.doesNotMatch(ui, /\.click\s*\(/);
});

test('Gemini secret is reserved for backend environment only', () => {
  const env = read('backend/.env.example');
  const manifest = read('manifest.json');
  assert.match(env, /^GEMINI_API_KEY=$/m);
  assert.match(env, /^GEMINI_MODEL=gemini-3\.8-flash$/m);
  assert.doesNotMatch(manifest, /GEMINI_API_KEY|generativelanguage\.googleapis\.com/);
});
