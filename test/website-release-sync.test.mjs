import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('extension, backend and public portal advertise the same release', () => {
  const version = '0.12.12';
  assert.equal(JSON.parse(read('manifest.json')).version, version);
  assert.equal(JSON.parse(read('package.json')).version, version);
  assert.equal(JSON.parse(read('backend/package.json')).version, version);
  assert.match(read('backend/src/server.js'), /const VERSION = '0\.12\.12';/);
  assert.match(read('backend/src/server.js'), /EXTENSION_LATEST_VERSION \|\| '0\.12\.12'/);
  assert.match(read('README.md'), /Versão atual — 0\.12\.12/);
});

test('public demo card does not fabricate a live score or a buy/enter signal', () => {
  const html = read('apps/customer-portal/index.html');
  assert.match(html, /ATS • VISUALIZAÇÃO/);
  assert.match(html, /EXEMPLO ILUSTRATIVO/);
  assert.match(html, /AGUARDANDO CONFIRMAÇÃO FINAL/);
  assert.match(html, /Nenhum sinal ao vivo é representado neste cartão/);
  assert.doesNotMatch(html, /POSSÍVEL COMPRA → ENTRAR/);
});

test('public portal explains the operational gates and manual-entry boundary', () => {
  const html = read('apps/customer-portal/index.html');
  assert.match(html, /id="diagnostico"/);
  assert.match(html, /Real ≠ informado/);
  assert.match(html, /Um ativo por vez/);
  assert.match(html, /Score coerente/);
  assert.match(html, /Entrada manual/);
  assert.match(html, /não uma tela de mercado ao vivo/);
});

test('checked-in backend environment example uses an explicitly unsafe secret placeholder', () => {
  const example = read('backend/.env.example');
  assert.match(example, /NUNCA USE ESTE VALOR EM PRODUÇÃO/);
  assert.match(example, /SESSION_SECRET=COLOQUE_AQUI_UM_SEGREDO_UNICO_GERADO/);
});
