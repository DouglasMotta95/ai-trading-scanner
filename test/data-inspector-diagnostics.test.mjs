import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = path => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('CasaTrade inspector surfaces only sanitized trade-result metadata and background persists it as diagnostics', () => {
  const inspector = read('src/content/casatrade-data-inspector.js');
  const background = read('src/background-data-inspector.js');
  const entry = read('src/background-entry.js');

  assert.match(inspector, /TRADE_EVIDENCE/);
  assert.match(inspector, /tradeEvidence/);
  assert.match(inspector, /trade\|order\|position\|deal\|result\|outcome\|payout\|profit\|win\|loss/);
  assert.match(inspector, /SENSITIVE/);
  assert.doesNotMatch(inspector, /document\.cookie|localStorage\.getItem/);

  assert.match(background, /ATS_DATA_INSPECTOR/);
  assert.match(background, /dataInspector: snapshot/);
  assert.match(background, /untrusted_sender/);
  assert.match(background, /SENSITIVE/);
  assert.match(entry, /background-data-inspector\.js/);
});

test('copied diagnostics include trade evidence but no license or auth secrets', () => {
  const diag = read('src/sidepanel/diagnostics-export.js');
  assert.match(diag, /COPIAR DIAGNÓSTICO/);
  assert.match(diag, /dataInspector/);
  assert.match(diag, /tradeEvidence/);
  assert.match(diag, /Sem chaves, tokens ou dados de login/);
  assert.doesNotMatch(diag, /licenseKey|clientToken|accountToken|GEMINI_API_KEY/);
});
