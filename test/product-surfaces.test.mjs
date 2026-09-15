import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const standalone = term => new RegExp(`(?:^|[^A-ZÀ-ÖØ-Þ])${term}(?:$|[^A-ZÀ-ÖØ-Þ])`);

test('sidepanel exposes only the focused access, market and next-candle decision surface', () => {
  const html = read('src/sidepanel/index.html');
  const app = read('src/sidepanel/app-v2.js');

  for (const heading of ['Live Decision','PRÓXIMA VELA','MERCADO ATUAL','ACESSO']) assert.match(html, new RegExp(heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
  for (const id of [
    'activateLicense','analysisTitle','asset','price','secondsRemaining','timeframe','expiration',
    'currentOpen','currentHigh','currentLow','currentClose','recentCandles','recentCandleCount',
    'signalTitle','signalReason','decisionText','signalScore','targetTime','prepareBuy','prepareSell'
  ]) assert.match(html, new RegExp(`id=["']${id}["']`));

  assert.match(html, /app-v2\.js/);
  assert.match(app, /ATS_ACTIVATE_LICENSE/);
  assert.match(app, /ATS_CONNECT_ACTIVE_TAB/);
  assert.match(app, /function decisionModel\(state = \{\}\)/);
  for (const label of ['ANALISANDO PRÓXIMA VELA','POSSÍVEL COMPRA','POSSÍVEL VENDA','DECIDINDO AGORA','ENTRAR COMPRA','ENTRAR VENDA','PULAR PRÓXIMA VELA']) assert.match(app, new RegExp(label));
  assert.match(app, /prepareBuy'\)\.disabled = model\.key !== 'ENTER_BUY'/);
  assert.match(app, /prepareSell'\)\.disabled = model\.key !== 'ENTER_SELL'/);
  assert.doesNotMatch(app, /ATS_RUN_BACKTEST|ATS_GET_WEEKLY_REPORT|renderIndicators|renderAI|renderIntelligence/);

  for (const removed of ['EMA 9','EMA 21','BACKTEST','RELATÓRIO SEMANAL','CORRELAÇÃO','CALENDÁRIO','NOTÍCIAS','MELHORES OPORTUNIDADES','RADAR MULTIATIVO','POR QUE A IA']) assert.doesNotMatch(html.toUpperCase(), standalone(removed));
});

test('panel exposes synchronization reason while unavailable market values stay empty', () => {
  const app = read('src/sidepanel/app-v2.js');
  const html = read('src/sidepanel/index.html');
  assert.match(app, /IDENTIFICANDO ATIVO/);
  assert.match(app, /LENDO MERCADO/);
  assert.match(app, /SINCRONIZANDO VELA/);
  assert.match(app, /priceText = value => num\(value\) == null \? '—'/);
  assert.match(app, /secondsRemaining'\)\.textContent = exactClockReady\(state\) \?/);
  assert.match(html, /id="price">—</);
  assert.match(html, /id="secondsRemaining">—</);
});

test('confirmed decisions stay session-scoped without exposing a separate history page', () => {
  const orchestrator = read('src/core/orchestrator.js');
  const html = read('src/sidepanel/index.html');
  assert.match(orchestrator, /serializeCompletedDecisions/);
  assert.match(orchestrator, /restoreCompletedDecisions/);
  assert.match(orchestrator, /wrapperCompletedDecisions/);
  assert.doesNotMatch(html, /signalHistory|HISTÓRICO DA SESSÃO/);
});
