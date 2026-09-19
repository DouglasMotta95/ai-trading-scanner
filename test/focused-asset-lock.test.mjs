import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { resolveMarketEvidence } from '../src/core/market-evidence.js';

const NOW = 1_800_000_000_000;
const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');

test('fresh visual focus blocks a foreign snapshot and foreign strong network quote', () => {
  const state = {
    asset: 'SHIB/USD (OTC)', price: 0.00461, lastSeen: NOW - 100,
    diagnostics: {
      focusedAsset: { asset: 'EUR/USD', source: 'chart-header', visual: true, reliable: true, score: 180, at: NOW - 100, stableSince: NOW - 200 },
      network: { lastSeen: NOW - 50, candidates: [{ asset: 'SHIB/USD (OTC)', price: 0.00462, confidence: 99, seenCount: 20, selected: true, observedAt: NOW - 50, transport: 'ws' }] }
    }
  };
  const result = resolveMarketEvidence({ asset: 'SHIB/USD (OTC)', price: 0.00462, diagnostics: { assetSource: 'network-fallback', priceSource: 'network:ws' } }, state, { now: NOW });
  assert.equal(result.asset, 'EUR/USD');
  assert.equal(result.price, null);
  assert.equal(result.focusAuthoritative, true);
  assert.match(result.reason, /mesmo ativo/);
});

test('matching quote is accepted only after it belongs to the focused screen asset', () => {
  const state = {
    diagnostics: {
      focusedAsset: { asset: 'EUR/USD', source: 'user-selection', visual: true, reliable: true, at: NOW - 100, stableSince: NOW - 100 },
      network: { lastSeen: NOW - 50, candidates: [
        { asset: 'SHIB/USD (OTC)', price: 0.00462, confidence: 99, seenCount: 20, selected: true, observedAt: NOW - 50, transport: 'ws' },
        { asset: 'EUR/USD', price: 1.16578, confidence: 85, seenCount: 2, observedAt: NOW - 40, transport: 'ws' }
      ] }
    }
  };
  const result = resolveMarketEvidence({}, state, { now: NOW });
  assert.equal(result.asset, 'EUR/USD');
  assert.equal(result.price, 1.16578);
  assert.match(result.priceSource, /^network:/);
});

test('current runtime paths enforce visual focus lock and clear operational state on session switch', () => {
  const focused = read('src/content/focused-asset-v2.js');
  const market = read('src/background-market-session.js');
  const entry = read('src/background-entry.js');
  assert.match(focused, /ariaSelected === 'false'/);
  assert.match(focused, /chartScoped: true/);
  assert.match(focused, /const frameRole = traderHost\(host\) \? 'trader-frame' : 'casa-chart-frame'/);
  assert.match(market, /function resetForSession/);
  assert.match(market, /price: null/);
  assert.match(market, /candles: \[\]/);
  assert.match(market, /marketHistory: \{\}/);
  assert.match(market, /signal: null/);
  assert.match(market, /lastConfirmed: null/);
  assert.match(market, /tradeIntent: null/);
  assert.match(market, /const candidate = bestForFocus\(payload, asset\)/);
  assert.match(entry, /background-market-session\.js/);
  assert.match(entry, /background\.js/);
});

test('panel exposes exactly one principal next-candle state', () => {
  const panel = read('src/sidepanel/app-v2.js');
  for (const state of [
    'ANALISANDO MERCADO ATUAL',
    'MONTANDO PADRÃO DA PRÓXIMA VELA',
    'POSSÍVEL COMPRA',
    'POSSÍVEL VENDA',
    'ENTRAR: COMPRA',
    'ENTRAR: VENDA',
    'AGUARDAR'
  ]) assert.match(panel, new RegExp(state.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(panel, /const model = decisionModel\(state\)/);
  assert.match(panel, /setText\('decisionText', model\.text\)/);
  assert.match(panel, /setText\('signalReason', model\.reason\)/);
  assert.doesNotMatch(panel, /DECIDINDO AGORA/);
  assert.doesNotMatch(panel, /PULAR PRÓXIMA VELA/);
  assert.doesNotMatch(panel, /DIAGNÓSTICO: AGUARDAR/);
});
