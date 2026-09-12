import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const standalone = term => new RegExp(`(?:^|[^A-ZÀ-ÖØ-Þ])${term}(?:$|[^A-ZÀ-ÖØ-Þ])`);

test('sidepanel exposes only the focused license, candle and next-entry surface', () => {
  const html = read('src/sidepanel/index.html');
  const app = read('src/sidepanel/app.js');

  for (const heading of ['1. LICENÇA','2. VELA EM ANÁLISE','3. PRÓXIMA VELA']) {
    assert.match(html, new RegExp(heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  for (const id of [
    'activateLicense','analysisTitle','asset','price','secondsRemaining','timeframe','expiration',
    'currentOpen','currentHigh','currentLow','currentClose','signalTitle','signalReason','decisionText','signalScore','targetTime'
  ]) assert.match(html, new RegExp(`id=["']${id}["']`));

  assert.match(app, /ATS_ACTIVATE_LICENSE/);
  assert.match(app, /ATS_CONNECT_ACTIVE_TAB/);
  assert.match(app, /POSSÍVEL COMPRA|POSSÍVEL VENDA/);
  assert.match(app, /ENTRAR EM COMPRA|ENTRAR EM VENDA/);
  assert.match(app, /NÃO ENTRAR/);
  assert.doesNotMatch(app, /ATS_RUN_BACKTEST|ATS_GET_WEEKLY_REPORT|renderIndicators|renderAI|renderIntelligence/);

  for (const removed of [
    'RSI','MACD','EMA 9','EMA 21','BACKTEST','RELATÓRIO SEMANAL','CORRELAÇÃO',
    'CALENDÁRIO','NOTÍCIAS','MELHORES OPORTUNIDADES','RADAR MULTIATIVO','POR QUE A IA'
  ]) assert.doesNotMatch(html.toUpperCase(), standalone(removed));
});

test('unsupported platform text is explicit and market values stay empty', () => {
  const app = read('src/sidepanel/app.js');
  assert.match(app, /Plataforma não suportada\/não conectado/);
  assert.match(app, /online && s\.asset \? s\.asset : '—'/);
  assert.match(app, /online && s\.price != null \? String\(s\.price\) : '—'/);
});

test('background keeps session-scoped confirmed decisions without exposing extra UI', () => {
  const background = read('src/background.js');
  const html = read('src/sidepanel/index.html');
  assert.match(background, /chrome\.storage\.session/);
  assert.match(background, /atsSessionSignalHistory/);
  assert.doesNotMatch(html, /signalHistory|HISTÓRICO DA SESSÃO/);
});
