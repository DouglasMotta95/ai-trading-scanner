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
    'currentOpen','currentHigh','currentLow','currentClose','recentCandles','recentCandleCount',
    'signalTitle','signalReason','decisionText','signalScore','targetTime','prepareBuy','prepareSell'
  ]) assert.match(html, new RegExp(`id=["']${id}["']`));

  assert.match(app, /ATS_ACTIVATE_LICENSE/);
  assert.match(app, /ATS_CONNECT_ACTIVE_TAB/);
  assert.match(app, /ATS_PREPARE_TRADE/);
  assert.match(app, /function principalState\(s = \{\}\)/);
  assert.match(app, /ANALISANDO MERCADO ATUAL/);
  assert.match(app, /MONTANDO PADRÃO DA PRÓXIMA VELA/);
  assert.match(app, /POSSÍVEL COMPRA/);
  assert.match(app, /POSSÍVEL VENDA/);
  assert.match(app, /ENTRAR NA PRÓXIMA VELA: COMPRA/);
  assert.match(app, /ENTRAR NA PRÓXIMA VELA: VENDA/);
  assert.match(app, /AGUARDAR/);
  assert.match(app, /buy\.disabled = !\(confirmed && sig\.direction === 'BUY'\)/);
  assert.match(app, /sell\.disabled = !\(confirmed && sig\.direction === 'SELL'\)/);
  assert.doesNotMatch(app, /DIAGNÓSTICO: AGUARDAR|AGUARDE CONFIRMAÇÃO|Pré-sinal aponta/);
  assert.doesNotMatch(app, /ATS_RUN_BACKTEST|ATS_GET_WEEKLY_REPORT|renderIndicators|renderAI|renderIntelligence/);

  for (const removed of [
    'RSI','MACD','EMA 9','EMA 21','BACKTEST','RELATÓRIO SEMANAL','CORRELAÇÃO',
    'CALENDÁRIO','NOTÍCIAS','MELHORES OPORTUNIDADES','RADAR MULTIATIVO','POR QUE A IA'
  ]) assert.doesNotMatch(html.toUpperCase(), standalone(removed));
});

test('panel exposes acquisition reason while keeping unavailable market values empty', () => {
  const app = read('src/sidepanel/app.js');
  assert.match(app, /function marketStep\(s = \{\}\)/);
  assert.match(app, /confirming_asset/);
  assert.match(app, /reading_price/);
  assert.match(app, /reading_history/);
  assert.match(app, /analyzing_current/);
  assert.match(app, /diagnosing_next_candle/);
  assert.match(app, /const required = Math\.max\(2,/);
  assert.match(app, /online && s\.price != null \? String\(s\.price\) : '—'/);
  assert.match(app, /active && s\.asset \? s\.asset : '—'/);
});

test('background keeps session-scoped confirmed decisions without exposing extra history page', () => {
  const background = read('src/background.js');
  const html = read('src/sidepanel/index.html');
  assert.match(background, /chrome\.storage\.session/);
  assert.match(background, /atsSessionSignalHistory/);
  assert.doesNotMatch(html, /signalHistory|HISTÓRICO DA SESSÃO/);
});
