import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = path => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('CasaTrade exact clock is never clobbered by the diagnostic fallback writer', () => {
  const clock = read('src/content/market-cycle-clock-v4.js');
  assert.match(clock, /function freshExactClock\(state = \{\}, focus = null, cycleTf = null\)/);
  assert.match(clock, /if \(!domClock && freshExactClock\(state, focus, cycleTf\)\) return;/);
  assert.match(clock, /clockSource: 'network-server-cycle', clockMode: 'state-current-candle-boundary'/);
});

test('missing exact countdown falls back honestly without freezing the analyst', () => {
  const clock = read('src/content/market-cycle-clock-v4.js');
  const background = read('src/background-market-session.js');
  const ui = read('src/sidepanel/app-v2.js');

  assert.match(clock, /verified: false, operational: true/);
  assert.match(clock, /clockSource: 'platform-cycle-derived', clockMode: 'bounded-local-fallback'/);
  assert.match(clock, /confidence: 55/);
  assert.match(background, /function usableClock\(state = \{\}, info = null\)/);
  assert.match(background, /clock\.operational === true/);
  assert.match(background, /FALLBACK_CLOCK_SOURCE = 'platform-cycle-derived'/);
  assert.match(background, /if \(clock\) processed = processLiveSnapshot/);
  assert.match(ui, /function operationalClockReady\(state = \{\}\)/);
  assert.match(ui, /fresh\(state\) && operationalClockReady\(state\)/);
  assert.match(ui, /LIVE • CLOCK ESTIMADO/);
});

test('current OHLC keeps real observed prices and labels partial candle honestly', () => {
  const background = read('src/background-market-session.js');
  const ui = read('src/sidepanel/app-v2.js');

  assert.match(background, /function annotateCurrentOhlc\(/);
  assert.match(background, /source: structured \? 'structured-casatrade' : 'live-price-observed'/);
  assert.match(background, /openReliable: !!structured/);
  assert.match(background, /rangeReliable: !!structured/);
  assert.match(background, /partial: !structured/);
  assert.match(background, /const serverTime = Date\.now\(\);/);
  assert.match(ui, /observedPriceText/);
  assert.match(ui, /Abertura observada após a conexão/);
  assert.match(ui, /Máxima observada pela extensão desde a conexão/);
  assert.match(ui, /Mínima observada pela extensão desde a conexão/);
});

test('principal analyst states stay single and stable in the side panel', () => {
  const ui = read('src/sidepanel/app-v2.js');
  assert.match(ui, /ANALISANDO MERCADO ATUAL/);
  assert.match(ui, /MONTANDO PADRÃO DA PRÓXIMA VELA/);
  assert.match(ui, /POSSÍVEL COMPRA/);
  assert.match(ui, /POSSÍVEL VENDA/);
  assert.match(ui, /ENTRAR NA PRÓXIMA VELA: COMPRA/);
  assert.match(ui, /ENTRAR NA PRÓXIMA VELA: VENDA/);
  assert.match(ui, /AGUARDAR/);
  assert.doesNotMatch(ui, /DECIDINDO AGORA/);
  assert.doesNotMatch(ui, /PULAR PRÓXIMA VELA'/);
});
