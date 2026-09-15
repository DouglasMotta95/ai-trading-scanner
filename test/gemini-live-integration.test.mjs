import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = path => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('0.11.12 wires Gemini through a server-side authenticated gateway', () => {
  const manifest = JSON.parse(read('manifest.json'));
  const entry = read('src/background-entry.js');
  const client = read('src/services/ai-analysis.js');
  const background = read('src/background-ai-analysis.js');

  assert.equal(manifest.version, '0.11.12');
  assert.ok(manifest.host_permissions.includes('https://ai-trading-scanner-production-62f2.up.railway.app/*'));
  assert.match(entry, /background-ai-analysis\.js/);
  assert.match(client, /clientToken\(\)/);
  assert.match(client, /authorization:\s*`Bearer \$\{token\}`/);
  assert.match(client, /\/v1\/ai\/analyze/);
  assert.doesNotMatch(client, /GEMINI_API_KEY|generativelanguage\.googleapis\.com/);
  assert.match(background, /aiAudit/);
  assert.match(background, /if \(currentDirection === 'WAIT'\) return false/);
  assert.doesNotMatch(background, /signal\s*:/);
});

test('Gemini gateway keeps the API key server-side and returns constrained structured analysis', () => {
  const gateway = read('backend-ai/src/server.js');
  assert.match(gateway, /process\.env\.GEMINI_API_KEY/);
  assert.match(gateway, /gemini-3\.8-flash/);
  assert.match(gateway, /x-goog-api-key/);
  assert.match(gateway, /responseMimeType:\s*'application\/json'/);
  assert.match(gateway, /responseSchema:\s*RESPONSE_SCHEMA/);
  assert.match(gateway, /decodeClientToken\(bearer\(req\)\)/);
  assert.match(gateway, /confidenceAdjustment/);
  assert.match(gateway, /Nunca execute operação/i);
  assert.match(gateway, /origin\.startsWith\('chrome-extension:\/\/'\)/);
  assert.match(gateway, /origin\.startsWith\('edge-extension:\/\/'\)/);
  assert.doesNotMatch(gateway, /access-control-allow-origin'\]\s*=\s*'\*'/);
  assert.doesNotMatch(gateway, /allowedOrigin\s*\|\|\s*'\*'/);
});

test('side panel visibly exposes the Gemini second opinion without replacing the technical engine', () => {
  const html = read('src/sidepanel/index.html');
  const ui = read('src/sidepanel/ai-analysis-ui.js');
  assert.match(html, /id="aiAuditCard"/);
  assert.match(html, /IA GEMINI • SEGUNDA LEITURA/);
  assert.match(html, /ai-analysis-ui\.js/);
  assert.match(html, /SEM EXECUÇÃO AUTOMÁTICA/);
  assert.match(ui, /motor técnico continua funcionando normalmente/i);
  assert.match(ui, /confidenceAdjustment/);
});
