import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { resolveMarketEvidence } from '../src/core/market-evidence.js';

const NOW = 1_800_000_000_000;
const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');

test('fresh visual focus blocks a foreign snapshot and foreign strong network quote', () => {
  const state = {
    asset: 'SHIB/USD (OTC)',
    price: 0.00461,
    lastSeen: NOW - 100,
    diagnostics: {
      focusedAsset: {
        asset: 'EUR/USD',
        source: 'chart-header',
        visual: true,
        reliable: true,
        score: 180,
        at: NOW - 100,
        stableSince: NOW - 200
      },
      network: {
        lastSeen: NOW - 50,
        candidates: [{ asset: 'SHIB/USD (OTC)', price: 0.00462, confidence: 99, seenCount: 20, selected: true, observedAt: NOW - 50, transport: 'ws' }]
      }
    }
  };
  const result = resolveMarketEvidence({
    asset: 'SHIB/USD (OTC)',
    price: 0.00462,
    diagnostics: { assetSource: 'network-fallback', priceSource: 'network:ws' }
  }, state, { now: NOW });
  assert.equal(result.asset, 'EUR/USD');
  assert.equal(result.price, null);
  assert.equal(result.focusAuthoritative, true);
  assert.match(result.reason, /mesmo ativo/);
});

test('matching quote is accepted only after it belongs to the focused screen asset', () => {
  const state = {
    diagnostics: {
      focusedAsset: { asset: 'EUR/USD', source: 'user-selection', visual: true, reliable: true, at: NOW - 100, stableSince: NOW - 100 },
      network: {
        lastSeen: NOW - 50,
        candidates: [
          { asset: 'SHIB/USD (OTC)', price: 0.00462, confidence: 99, seenCount: 20, selected: true, observedAt: NOW - 50, transport: 'ws' },
          { asset: 'EUR/USD', price: 1.16578, confidence: 85, seenCount: 2, observedAt: NOW - 40, transport: 'ws' }
        ]
      }
    }
  };
  const result = resolveMarketEvidence({}, state, { now: NOW });
  assert.equal(result.asset, 'EUR/USD');
  assert.equal(result.price, 1.16578);
  assert.match(result.priceSource, /^network:/);
});

test('source paths enforce visual focus lock and clear market state on asset switch', () => {
  const focused = read('src/content/focused-asset.js');
  const generic = read('src/content/generic-adapter.js');
  const background = read('src/background.js');
  const augment = read('src/background-augment.js');
  assert.match(focused, /source: 'user-selection'/);
  assert.match(focused, /ariaSelected === 'false'/);
  assert.match(generic, /const focusSupported = focusFresh/);
  assert.doesNotMatch(generic, /fallbackAsset/);
  assert.match(background, /const bestFallback = focus \? null/);
  assert.match(background, /const observedPrice = focus \? num\(bestFocused\?\.price\)/);
  assert.match(augment, /lastConfirmed: null/);
  assert.match(background, /lastConfirmed: switchedAsset \? null/);
  assert.match(background, /tradeIntent: switchedAsset \? null/);
  assert.doesNotMatch(generic, /OTC\\\)\$.*?\? 20/);
  assert.match(augment, /candidate = chooseCandidate\(payload, focus\)/);
});

test('panel exposes exactly one principal analyst state instead of conflicting buy and wait messages', () => {
  const panel = read('src/sidepanel/app.js');
  assert.match(panel, /function principalState\(s = \{\}\)/);
  for (const state of [
    'ANALISANDO MERCADO ATUAL',
    'MONTANDO PADRÃO DA PRÓXIMA VELA',
    'POSSÍVEL COMPRA',
    'POSSÍVEL VENDA',
    'ENTRAR NA PRÓXIMA VELA: COMPRA',
    'ENTRAR NA PRÓXIMA VELA: VENDA',
    'AGUARDAR'
  ]) assert.match(panel, new RegExp(state.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(panel, /analysisTitle'\)\.textContent = principal\.text/);
  assert.match(panel, /signalTitle'\)\.textContent = principal\.text/);
  assert.match(panel, /decisionText'\)\.textContent = principal\.text/);
  assert.match(panel, /analyzingNow'\)\.textContent = principal\.text/);
  assert.match(panel, /tradeActionStatus'\)\.textContent = principal\.text/);
  assert.doesNotMatch(panel, /DIAGNÓSTICO: AGUARDAR/);
  assert.doesNotMatch(panel, /AGUARDE CONFIRMAÇÃO/);
});
