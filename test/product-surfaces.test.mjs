import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const standalone = term => new RegExp(`(?:^|[^A-ZÀ-ÖØ-Þ])${term}(?:$|[^A-ZÀ-ÖØ-Þ])`);

test('sidepanel exposes one dominant analyst decision and real CasaTrade time surface', () => {
  const html = read('src/sidepanel/index.html');
  const app = read('src/sidepanel/app-v2.js');

  for (const heading of ['Live Analyst','DECISÃO DA PRÓXIMA VELA','VELA ATUAL','ACESSO']) assert.match(html, new RegExp(heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
  for (const id of [
    'activateLicense','assetQualityCard','asset','price','secondsRemaining','timeframe','expiration','heroCountdown','heroTimeStatus','timeSyncStatus',
    'currentOpen','currentHigh','currentLow','currentClose','recentCandles','recentCandleCount',
    'signalTitle','signalReason','decisionText','signalScore','prepareBuy','prepareSell'
  ]) assert.match(html, new RegExp(`id=["']${id}["']`));
  for (const repeated of ['analysisTitle','analyzingNow','targetTime','lastConfirmed']) assert.doesNotMatch(html, new RegExp(`id=["']${repeated}["']`));

  assert.match(html, /app-v2\.js/);
  assert.match(app, /ATS_ACTIVATE_LICENSE/);
  assert.match(app, /ATS_READ_SCANNER_STATE/);
  assert.match(app, /function decisionModel\(state = \{\}\)/);
  for (const label of ['ANALISANDO MERCADO ATUAL','MONTANDO PADRÃO DA PRÓXIMA VELA','POSSÍVEL COMPRA','POSSÍVEL VENDA','ENTRAR: COMPRA','ENTRAR: VENDA','AGUARDAR']) assert.match(app, new RegExp(label));
  assert.match(app, /model\.actionable && model\.direction === 'BUY' && timeReady/);
  assert.match(app, /model\.actionable && model\.direction === 'SELL' && timeReady/);
  assert.doesNotMatch(app, /ATS_RUN_BACKTEST|ATS_GET_WEEKLY_REPORT|renderIndicators|renderAI|renderIntelligence/);

  for (const removed of ['EMA 9','EMA 21','BACKTEST','RELATÓRIO SEMANAL','CORRELAÇÃO','CALENDÁRIO','NOTÍCIAS','MELHORES OPORTUNIDADES','POR QUE A IA']) assert.doesNotMatch(html.toUpperCase(), standalone(removed));
});

test('panel communicates exact versus estimated clock without inventing unavailable values', () => {
  const app = read('src/sidepanel/app-v2.js');
  const html = read('src/sidepanel/index.html');
  assert.match(app, /function exactClockReady\(state = \{\}\)/);
  assert.match(app, /function operationalClockReady\(state = \{\}\)/);
  assert.match(app, /ESTIMADO • BLOQUEADO/);
  assert.match(app, /remaining == null \? '—'/);
  assert.match(app, /fmtPrice\(state\.price\)/);
  assert.match(html, /id="price">—</);
  assert.match(html, /id="secondsRemaining">—</);
});

test('professional preferences are compact and keep live CasaTrade values authoritative', () => {
  const html = read('src/sidepanel/index.html');
  const guard = read('src/sidepanel/expiration-guard-ui.js');
  for (const id of ['analystMode','alertLevel','holdSeconds','desiredExpiration','overlayToggle','geminiToggle']) assert.match(html, new RegExp(`id=["']${id}["']`));
  assert.match(html, /Somente preferência\. O tempo ao vivo sempre vem da CasaTrade/);
  assert.match(guard, /O tempo ao vivo prevalece/);
});

test('confirmed decisions stay session-scoped without exposing a separate history page', () => {
  const orchestrator = read('src/core/orchestrator.js');
  const html = read('src/sidepanel/index.html');
  assert.match(orchestrator, /serializeCompletedDecisions/);
  assert.match(orchestrator, /restoreCompletedDecisions/);
  assert.match(orchestrator, /wrapperCompletedDecisions/);
  assert.doesNotMatch(html, /signalHistory|HISTÓRICO DA SESSÃO/);
});
