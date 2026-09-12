import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('sidepanel exposes exactly the six requested functional sections and controls', () => {
  const html = read('src/sidepanel/index.html');
  const app = read('src/sidepanel/app.js');

  const headings = [
    '1. LICENÇA',
    '2. CONEXÃO CASATRADE',
    '3. CONFIGURAÇÃO',
    '4. ESTADO DO SINAL',
    '5. PREPARAR ENTRADA',
    '6. HISTÓRICO DA SESSÃO'
  ];
  for (const heading of headings) assert.ok(html.includes(heading), `missing ${heading}`);
  assert.equal((html.match(/<section\b/g) || []).length, 6);

  for (const id of [
    'activateLicense','connectBtn','tradeAmount','analysisTimeframe','targetExpiration',
    'syncPlatformBtn','signalTitle','signalReason','prepareBuy','prepareSell','signalHistory'
  ]) assert.ok(html.includes(`id="${id}"`), `missing ${id}`);

  assert.equal(html.includes('account-login.js'), false);
  assert.match(app, /ATS_ACTIVATE_LICENSE/);
  assert.match(app, /ATS_CONNECT_ACTIVE_TAB/);
  assert.match(app, /ATS_SYNC_PLATFORM_PREFERENCES/);
  assert.match(app, /ATS_PREPARE_TRADE/);
  assert.match(app, /ATS_GET_SESSION_HISTORY/);
  assert.doesNotMatch(app, /ATS_RUN_BACKTEST|ATS_GET_WEEKLY_REPORT|renderIndicators|renderAI|renderIntelligence/);

  for (const removed of [
    'RSI','MACD','EMA 9','EMA 21','BACKTEST','RELATÓRIO SEMANAL','CORRELAÇÃO',
    'CALENDÁRIO','NOTÍCIAS','MELHORES OPORTUNIDADES','RADAR MULTIATIVO','POR QUE A IA'
  ]) assert.equal(html.toUpperCase().includes(removed), false, `${removed} must not be rendered`);
});

test('unsupported platform text is explicit and market values stay empty', () => {
  const app = read('src/sidepanel/app.js');
  assert.match(app, /Plataforma não suportada\/não conectado/);
  assert.match(app, /online && s\.asset \? s\.asset : '—'/);
  assert.match(app, /online && s\.price != null \? String\(s\.price\) : '—'/);
});

test('license restoration runs before the first state request on panel reopen', () => {
  const app = read('src/sidepanel/app.js');
  assert.match(app, /async function restoreLicenseBeforeState\(\)/);
  assert.match(app, /await restoreLicenseBeforeState\(\);[\s\S]*await getState\(\);/);
  const boot = app.slice(app.lastIndexOf('(async () =>'));
  assert.equal(boot.includes('ATS_VALIDATE_LICENSE'), false);
});

test('confirmed-signal history is scoped to chrome storage session', () => {
  const background = read('src/background.js');
  const app = read('src/sidepanel/app.js');
  assert.match(background, /chrome\.storage\.session/);
  assert.match(background, /ATS_GET_SESSION_HISTORY/);
  assert.match(background, /atsSessionSignalHistory/);
  assert.match(app, /ATS_GET_SESSION_HISTORY/);
});