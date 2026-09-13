import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveMarketEvidence, marketHistoryFor, acquisitionStage } from '../src/core/market-evidence.js';

const NOW = 1_800_000_000_000;

const networkCandidate = (overrides = {}) => ({
  asset: 'EUR/USD',
  price: 1.08765,
  transport: 'ws',
  confidence: 92,
  seenCount: 3,
  observedAt: NOW - 500,
  ...overrides
});

test('reliable focused asset remains first priority when other snapshot asset conflicts', () => {
  const state = {
    diagnostics: {
      focusedAsset: {
        asset: 'EUR/USD',
        score: 140,
        reliable: true,
        at: NOW - 200,
        stableSince: NOW - 3000
      },
      network: {
        lastSeen: NOW - 200,
        candidates: [networkCandidate()]
      }
    }
  };

  const result = resolveMarketEvidence({ asset: 'GBP/USD', price: 1.27111 }, state, { now: NOW, focusStableMs: 2000 });
  assert.equal(result.asset, 'EUR/USD');
  assert.equal(result.assetSource, 'focused-stable');
  assert.equal(result.price, 1.08765);
  assert.match(result.priceSource, /^network:/);
});

test('stale focused asset cannot override a current snapshot even if the old pair still has a fresh network quote', () => {
  const state = {
    diagnostics: {
      focusedAsset: {
        asset: 'EUR/USD',
        score: 150,
        reliable: true,
        at: NOW - 6_500,
        stableSince: NOW - 20_000
      },
      network: {
        lastSeen: NOW - 100,
        candidates: [networkCandidate({ asset: 'EUR/USD', price: 1.0888, observedAt: NOW - 100 })]
      }
    }
  };

  const result = resolveMarketEvidence({
    asset: 'GBP/USD',
    price: 1.27145,
    diagnostics: { assetSource: 'dom-fallback', priceSource: 'buttons' }
  }, state, { now: NOW, focusStableMs: 2000 });

  assert.equal(result.asset, 'GBP/USD');
  assert.equal(result.price, 1.27145);
  assert.equal(result.assetSource, 'dom-fallback');
  assert.equal(result.focusAsset, null);
});

test('snapshot DOM evidence is accepted when focus is absent or not trustworthy', () => {
  const state = { diagnostics: {} };
  const result = resolveMarketEvidence({
    asset: 'EUR/USD (OTC)',
    price: 1.08801,
    diagnostics: { assetSource: 'dom-fallback', priceSource: 'buttons' }
  }, state, { now: NOW });

  assert.equal(result.asset, 'EUR/USD (OTC)');
  assert.equal(result.price, 1.08801);
  assert.equal(result.assetSource, 'dom-fallback');
  assert.equal(result.priceSource, 'buttons');
});

test('strong network quote can recover asset and price when focus and snapshot are missing', () => {
  const state = {
    diagnostics: {
      network: {
        lastSeen: NOW - 200,
        candidates: [networkCandidate({ asset: 'GBP/USD', price: 1.27123 })]
      }
    }
  };

  const result = resolveMarketEvidence({}, state, { now: NOW });
  assert.equal(result.asset, 'GBP/USD');
  assert.equal(result.price, 1.27123);
  assert.equal(result.assetSource, 'network-fallback');
  assert.equal(result.priceSource, 'network:ws');
});

test('weak isolated generic network candidate is rejected instead of inventing an active asset', () => {
  const state = {
    diagnostics: {
      network: {
        lastSeen: NOW - 100,
        candidates: [networkCandidate({ asset: 'GBP/USD', confidence: 20, seenCount: 1, selected: false })]
      }
    }
  };

  const result = resolveMarketEvidence({}, state, { now: NOW });
  assert.equal(result.asset, null);
  assert.equal(result.price, null);
  assert.match(result.reason, /Ativo não confirmado/);
});

test('price-only frame tagged as focused fallback is discarded instead of being paired with stored focus', () => {
  const state = {
    diagnostics: {
      focusedAsset: {
        asset: 'EUR/USD',
        score: 80,
        reliable: false,
        at: NOW - 200,
        stableSince: NOW - 200
      }
    }
  };

  const result = resolveMarketEvidence({
    asset: 'EUR/USD',
    price: 999.99,
    diagnostics: { assetSource: 'focused-price-fallback', priceSource: 'chart' }
  }, state, { now: NOW });

  assert.equal(result.asset, null);
  assert.equal(result.price, null);
  assert.match(result.reason, /preço sem ativo correspondente foi descartado/);
});

test('matching network price fills a snapshot asset that arrived without price', () => {
  const state = {
    diagnostics: {
      network: {
        lastSeen: NOW - 300,
        candidates: [networkCandidate({ asset: 'EUR/USD (OTC)', price: 1.0899 })]
      }
    }
  };

  const result = resolveMarketEvidence({ asset: 'EUR/USD', price: null }, state, { now: NOW });
  assert.equal(result.asset, 'EUR/USD');
  assert.equal(result.price, 1.0899);
  assert.match(result.priceSource, /^network:/);
});

test('stale price is never reused and keeps acquisition in real-price wait state', () => {
  const state = {
    asset: 'EUR/USD',
    price: 1.08,
    lastSeen: NOW - 30_000,
    diagnostics: {}
  };

  const result = resolveMarketEvidence({ asset: 'EUR/USD', price: null }, state, { now: NOW });
  assert.equal(result.asset, 'EUR/USD');
  assert.equal(result.price, null);
  assert.match(result.reason, /cotação real válida/);
});

test('history lookup is OTC-insensitive and stage advances only after minimum candles', () => {
  const rows = [
    { time: 1, open: 1, high: 2, low: 0.5, close: 1.5 },
    { time: 2, open: 1.5, high: 2, low: 1, close: 1.7 },
    { time: 3, open: 1.7, high: 2, low: 1.2, close: 1.8 }
  ];
  const state = { marketHistory: { 'EUR/USD (OTC)': rows } };
  assert.deepEqual(marketHistoryFor(state, 'EUR/USD'), rows);
  assert.equal(acquisitionStage({ state: 'SEARCHING', candleCount: 2 }, 2), 'reading_history');
  assert.equal(acquisitionStage({ state: 'WAIT', candleCount: 3, currentCandle: { open: 1 } }, 3), 'diagnosing_next_candle');
});
