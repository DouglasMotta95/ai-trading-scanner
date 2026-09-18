import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = path => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('connection handshake times out explicitly and does not depend on 10 candles or expiration', () => {
  const control = read('src/background-control.js');
  assert.match(control, /const CONNECT_TIMEOUT_MS = 7000/);
  assert.match(control, /code: 'handshake_timeout'/);
  assert.match(control, /Falha ao conectar — tentar novamente/);
  const handshake = control.slice(control.indexOf('function handshakeReady'), control.indexOf('function scheduleConnectionTimeout'));
  assert.doesNotMatch(handshake, /rows\.length/);
  assert.doesNotMatch(handshake, /expiration/);
  assert.match(handshake, /clock\.secondsRemaining/);
});

test('sidepanel has only stable connected or disconnected badge while readiness is separate', () => {
  const shell = read('src/sidepanel/ui-shell-v2.js');
  const html = read('src/sidepanel/index.html');
  assert.match(shell, /connected \? 'CONECTADO' : 'DESCONECTADO'/);
  assert.match(shell, /CONECTADO — AJUSTE A EXPIRAÇÃO/);
  assert.match(shell, /CONECTADO — PRONTO PARA ANALISAR/);
  assert.doesNotMatch(html, /id="connectionBadge"[^>]*>CONECTANDO/);
});

test('focused asset preserves OTC identity and actively observes CasaTrade selection changes', () => {
  const focus = read('src/content/focused-asset-v2.js');
  const alias = read('src/content/focused-asset-alias-bridge.js');
  const session = read('src/background-market-session.js');
  assert.match(focus, /\$\{base\}\/\$\{quote\}\$\{otc \? ' \(OTC\)' : ''\}/);
  assert.match(focus, /MutationObserver/);
  assert.match(focus, /pointerup/);
  assert.match(alias, /visible-selected-asset/);
  assert.match(session, /switchedAsset/);
  assert.match(session, /marketHistory: \{\}/);
});

test('countdown and expiration are independent live channels with rollover protection', () => {
  const clock = read('src/content/market-cycle-clock-v4.js');
  const expiration = read('src/content/casatrade-expiration-probe.js');
  assert.match(clock, /rolloverWindow/);
  assert.match(clock, /previousSeconds <= 2/);
  assert.match(clock, /row\.seconds >= limit - 2/);
  assert.match(clock, /if \(expirySemantic && !candleSemantic\) continue/);
  assert.match(expiration, /ATS_PLATFORM_CONTROLS_OBSERVED/);
  assert.match(expiration, /expirationAroundLabel/);
  assert.match(expiration, /setInterval/);
});

test('wrong expiration remains visible but blocks final entry, not technical analysis', () => {
  const app = read('src/sidepanel/app-v2.js');
  const policy = read('src/background-decision-policy.js');
  assert.match(app, /EXPIRAÇÃO \$\{expLabel\(actualExpiration\)\} — ALTERE PARA 1 MIN/);
  assert.match(app, /!timeReady && ui === 'ENTER_BUY'/);
  assert.match(app, /!timeReady && ui === 'ENTER_SELL'/);
  assert.match(policy, /expirationReady/);
  assert.match(policy, /60s/);
});

test('price OHLC and last ten real candles are first-screen components', () => {
  const html = read('src/sidepanel/index.html');
  const app = read('src/sidepanel/app-v2.js');
  assert.match(html, /id="currentOpen"/);
  assert.match(html, /id="currentHigh"/);
  assert.match(html, /id="currentLow"/);
  assert.match(html, /id="currentClose"/);
  assert.match(html, /id="recentCandleCount"/);
  assert.match(app, /slice\(-10\)/);
  assert.match(app, /CARREGANDO/);
  assert.match(app, /structured-casatrade/);
});

test('technical score has one fixed primary component and Gemini is advanced second opinion only', () => {
  const html = read('src/sidepanel/index.html');
  const ai = read('src/background-ai-analysis.js');
  assert.equal((html.match(/id="triggerCard"/g) || []).length, 1);
  assert.match(html, /ANÁLISE TÉCNICA/);
  assert.match(html, /id="technicalConfidence"/);
  assert.match(html, /<details id="advancedPanel"/);
  assert.match(html, /GEMINI • SEGUNDA LEITURA/);
  assert.match(ai, /ENTER_BUY/);
  assert.match(ai, /ENTER_SELL/);
  assert.match(ai, /decision\?\.actionable === true/);
  assert.doesNotMatch(ai.slice(ai.indexOf('function aiStage'), ai.indexOf('function directionOf')), /POSSIBLE_/);
});

test('compact first screen prioritizes market, decision, manual actions and live data', () => {
  const html = read('src/sidepanel/index.html');
  const market = html.indexOf('id="asset"');
  const decision = html.indexOf('id="decisionCard"');
  const buy = html.indexOf('id="prepareBuy"');
  const sell = html.indexOf('id="prepareSell"');
  const ohlc = html.indexOf('id="currentOpen"');
  const advanced = html.indexOf('id="advancedPanel"');
  assert.ok(market > 0 && decision > market && buy > decision && sell > buy && ohlc > sell && advanced > ohlc);
  assert.match(html, /<details id="advancedPanel"/);
});

test('panel boot guard prevents silent white-screen failure', () => {
  const html = read('src/sidepanel/index.html');
  const guard = read('src/sidepanel/boot-guard.js');
  assert.match(html, /boot-guard\.js/);
  assert.match(guard, /window\.addEventListener\('error'/);
  assert.match(guard, /unhandledrejection/);
  assert.match(guard, /document\.body\.style\.visibility = 'visible'/);
});

test('single central analysis owner preserves signal confirmation across acquisition bursts', () => {
  const central = read('src/background.js');
  assert.equal((central.match(/processSnapshot\(/g) || []).length, 1);
  for (const path of ['src/background-augment.js','src/background-integrity.js','src/background-market-session.js']) {
    assert.doesNotMatch(read(path), /processSnapshot\(/);
  }
  assert.match(central, /needsConfirmationFollowup/);
  assert.match(central, /scheduleAnalysis\(true\)/);
});
