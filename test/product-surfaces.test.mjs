import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('sidepanel exposes only functional runtime controls', () => {
  const html = read('src/sidepanel/index.html');
  const app = read('src/sidepanel/app.js');
  for (const id of ['activateLicense','connectBtn','tradeAmount','analysisTimeframe','targetExpiration','syncPlatformBtn','signalTitle','signalReason','prepareBuy','prepareSell','signalHistory']) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
  assert.match(app, /ATS_ACTIVATE_LICENSE/);
  assert.match(app, /ATS_CONNECT_ACTIVE_TAB/);
  assert.match(app, /ATS_SYNC_PLATFORM_PREFERENCES/);
  assert.match(app, /ATS_PREPARE_TRADE/);
  assert.doesNotMatch(app, /ATS_RUN_BACKTEST|ATS_GET_WEEKLY_REPORT|renderIndicators|renderAI|renderIntelligence/);
});

test('unsupported platform text is explicit and market placeholders stay empty', () => {
  const app = read('src/sidepanel/app.js');
  assert.match(app, /Plataforma não suportada\/não conectado/);
  assert.match(app, /online && s\.asset \? s\.asset : '—'/);
  assert.match(app, /online && s\.price != null \? String\(s\.price\) : '—'/);
});
