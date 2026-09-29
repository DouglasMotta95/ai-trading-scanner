import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('AI Trading Bot identity is present on core product surfaces', () => {
  const manifest = JSON.parse(read('manifest.json'));
  assert.equal(manifest.name, 'AI Trading Bot');
  assert.equal(manifest.version, '0.11.107');
  assert.match(manifest.description, /AI Trading Bot/);

  const portal = read('apps/customer-portal/index.html');
  assert.match(portal, /AI Trading Bot/);
  assert.match(portal, /bot-hero-card/);
  assert.doesNotMatch(portal, /AI Trading Scanner/);

  const panel = read('src/sidepanel/index.html');
  assert.match(panel, /AI TRADING BOT/);
  assert.match(panel, /id="botIdentity"/);
  assert.match(panel, /bot-identity\.css/);

  const shell = read('src/sidepanel/ui-shell-v2.js');
  assert.match(shell, /function renderBotIdentity/);
  assert.match(shell, /ROBÔ MONITORANDO MERCADO/);
  assert.match(shell, /ROBÔ: COMPRA CONFIRMADA/);
  assert.match(shell, /ROBÔ: VENDA CONFIRMADA/);

  const server = read('backend/src/server.js');
  assert.match(server, /const VERSION = '0.11.107'/);
  assert.match(server, /product: 'AI Trading Bot'/);
});
