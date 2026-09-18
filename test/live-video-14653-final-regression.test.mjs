import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = path => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('sidepanel never paints a cached asset as the current CasaTrade market', () => {
  const restore = read('src/sidepanel/state-restore.js');
  const app = read('src/sidepanel/app-v2.js');

  assert.match(restore, /const freshFocus = state =>/);
  assert.match(restore, /OTC/);
  assert.match(restore, /setText\('asset', currentMarket \? state\.asset : '—'\)/);
  assert.match(app, /const freshMarket = focusReady\(state\) && sameMarket/);
  assert.match(app, /const visibleAsset = freshMarket/);
  assert.match(app, /renderCandles\(freshMarket \? state : \{\}\)/);
});

test('asset list and alias readers cannot promote an unrelated visible symbol', () => {
  const focus = read('src/content/focused-asset-v2.js');
  const alias = read('src/content/focused-asset-alias-bridge.js');
  const market = read('src/background-market-session.js');

  assert.match(focus, /if \(listContext && !selection\.explicit && !interaction\) continue/);
  assert.match(alias, /if \(!isSelected && !interacted && !directHeader\) continue/);
  assert.match(alias, /visible-selected-asset/);
  assert.doesNotMatch(alias, /concise alphabetic token directly clicked/);
  assert.match(market, /passive-asset-change-not-stable/);
});

test('visible expiration such as 5 seg is captured and kept separate from candle countdown', () => {
  const expiration = read('src/content/casatrade-expiration-probe.js');
  const clock = read('src/content/market-cycle-clock-v4.js');
  const panel = read('src/sidepanel/app-v2.js');

  assert.match(expiration, /label,p,strong,small,span,div/);
  assert.match(expiration, /const bodyValue = bodyExpiration\(\)/);
  assert.match(expiration, /index \+ 360/);
  assert.match(expiration, /index - 180/);
  assert.match(expiration, /horizontal <= 520/);
  assert.match(clock, /if \(expirySemantic && !candleSemantic\) continue/);
  assert.match(panel, /EXPIRAÇÃO \$\{expLabel\(actualExpiration\)\} — ALTERE PARA 1 MIN/);
});

test('M1 countdown prefers the new 59-60 second candle after a 1-0 second rollover', () => {
  const clock = read('src/content/market-cycle-clock-v4.js');

  assert.match(clock, /const rolloverWindow =/);
  assert.match(clock, /previousSeconds <= 2/);
  assert.match(clock, /row\.seconds >= limit - 2/);
  assert.match(clock, /clockSource: 'platform-cycle-derived'/);
  assert.match(clock, /structured-candle-boundary-fallback/);
  assert.doesNotMatch(clock, /clockSource: 'structured-candle-boundary'/);
});

test('connection status is independent from trade readiness and obsolete analyst setup is gone', () => {
  const shell = read('src/sidepanel/ui-shell-v2.js');
  const app = read('src/sidepanel/app-v2.js');
  const orchestrator = read('src/core/orchestrator.js');

  assert.match(shell, /connectScannerText'\)\.textContent = hasMarket \? 'CONECTADO' : 'CONECTAR'/);
  assert.match(shell, /CONECTADO — AJUSTE A EXPIRAÇÃO/);
  assert.match(shell, /actualExpiration === '60s'/);
  assert.match(shell, /toUpperCase\(\) === 'M1'/);
  assert.match(app, /function entryBlockReason/);
  assert.match(app, /POSSÍVEL COMPRA/);
  assert.match(app, /POSSÍVEL VENDA/);
  assert.doesNotMatch(orchestrator, /signal\.setup \|\| 'analista'/);
  assert.match(app, /\^analista\$\/i\.test\(setupLabel\) \? '—' : setupLabel/);
});
