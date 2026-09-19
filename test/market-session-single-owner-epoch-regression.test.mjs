import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');

function ownerPureApi() {
  const source = read('src/background-market-session.js');
  const start = source.indexOf('const clean =');
  const end = source.indexOf('\nfunction clockRecord', start);
  assert.ok(start >= 0 && end > start, 'market-session pure owner helpers must be extractable');
  const pure = source.slice(start, end).replace(/\bexport\s+/g, '');
  const sandbox = {};
  vm.runInNewContext(
    pure + '\nglobalThis.__api = { resetForSession, marketSessionEpoch, withMarketSessionEpoch, clearMarketAuthorityState };',
    sandbox
  );
  return sandbox.__api;
}

function candle(close, time = 1_700_000_000_000) {
  return { time, open: close, high: close, low: close, close, timeframe: 'M1' };
}

test('market-session epoch rejects a delayed old-asset write after resetForSession', () => {
  const { resetForSession, marketSessionEpoch, withMarketSessionEpoch } = ownerPureApi();

  const oldState = {
    connection: 'online',
    asset: 'USO/USD (OTC)',
    price: 91.42,
    timeframe: 'M1',
    analysisTimeframe: 'M1',
    candles: [candle(91.42)],
    marketHistory: { 'USO/USD (OTC)': [candle(91.42)] },
    diagnostics: {
      focusedAsset: {
        asset: 'USO/USD (OTC)',
        frameId: 7,
        frameHost: 'trade.casatraders.online',
        reliable: true,
        chartScoped: true,
        trustedChartFrame: true
      },
      marketSession: {
        epoch: 12,
        asset: 'USO/USD (OTC)',
        confirmedAsset: 'USO/USD (OTC)',
        dataReady: true,
        transitioning: false,
        timeframe: 'M1',
        frameId: 7,
        frameHost: 'trade.casatraders.online'
      }
    }
  };

  const oldEpoch = marketSessionEpoch(oldState);
  const reset = resetForSession(oldState, {
    asset: 'AUD/CAD (OTC)',
    timeframe: 'M1',
    info: { frameId: 7, frameHost: 'trade.casatraders.online' },
    source: 'user-selection',
    reason: 'Troca real para AUD/CAD'
  });

  assert.equal(marketSessionEpoch(reset), oldEpoch + 1);
  assert.equal(reset.asset, null);
  assert.equal(reset.price, null);
  assert.deepEqual(Array.from(reset.candles), []);
  assert.deepEqual(Object.keys(reset.marketHistory), []);
  assert.equal(reset.diagnostics.marketSession.pendingAsset, 'AUD/CAD (OTC)');

  // Model the valid owner confirmation that happens after applyFeed validates
  // the new AUD/CAD bundle for the new epoch.
  const confirmed = {
    ...reset,
    connection: 'online',
    asset: 'AUD/CAD (OTC)',
    price: 0.99521,
    candles: [candle(0.99521)],
    marketHistory: { 'AUD/CAD (OTC)': [candle(0.99521)] },
    diagnostics: {
      ...reset.diagnostics,
      marketSession: {
        ...reset.diagnostics.marketSession,
        confirmedAsset: 'AUD/CAD (OTC)',
        pendingAsset: null,
        dataReady: true,
        transitioning: false
      }
    }
  };

  // Simulates a delayed writer from an old observer that captured epoch 12 and
  // tries to restore USO/USD + 91.xx after AUD/CAD epoch 13 is already active.
  const afterDelayedOldWrite = withMarketSessionEpoch(confirmed, oldEpoch, current => ({
    ...current,
    asset: 'USO/USD (OTC)',
    price: 91.77,
    candles: [candle(91.77)],
    marketHistory: { 'USO/USD (OTC)': [candle(91.77)] }
  }));

  assert.equal(afterDelayedOldWrite.asset, 'AUD/CAD (OTC)');
  assert.equal(afterDelayedOldWrite.price, 0.99521);
  assert.equal(afterDelayedOldWrite.candles[0].close, 0.99521);
  assert.deepEqual(Object.keys(afterDelayedOldWrite.marketHistory), ['AUD/CAD (OTC)']);
  assert.equal(marketSessionEpoch(afterDelayedOldWrite), oldEpoch + 1);
});

test('market-session owner clear cannot be overridden by protected fields supplied by another module', () => {
  const { clearMarketAuthorityState, marketSessionEpoch } = ownerPureApi();
  const state = {
    asset: 'AUD/CAD (OTC)',
    price: 0.99521,
    candles: [candle(0.99521)],
    marketHistory: { 'AUD/CAD (OTC)': [candle(0.99521)] },
    diagnostics: {
      focusedAsset: { asset: 'AUD/CAD (OTC)' },
      marketClock: { asset: 'AUD/CAD (OTC)' },
      marketSession: { epoch: 20, asset: 'AUD/CAD (OTC)', confirmedAsset: 'AUD/CAD (OTC)', dataReady: true }
    }
  };

  const cleared = clearMarketAuthorityState(state, {
    scanner: 'idle',
    asset: 'USO/USD (OTC)',
    price: 91.55,
    candles: [candle(91.55)],
    marketHistory: { 'USO/USD (OTC)': [candle(91.55)] },
    diagnostics: { focusedAsset: { asset: 'USO/USD (OTC)' } }
  });

  assert.equal(marketSessionEpoch(cleared), 21);
  assert.equal(cleared.asset, null);
  assert.equal(cleared.price, null);
  assert.deepEqual(Array.from(cleared.candles), []);
  assert.deepEqual(Object.keys(cleared.marketHistory), []);
  assert.equal(cleared.diagnostics.focusedAsset, undefined);
  assert.equal(cleared.diagnostics.marketSession.dataReady, false);
});

test('legacy background modules no longer own protected market fields', () => {
  const augment = read('src/background-augment.js');
  const integrity = read('src/background-integrity.js');
  const control = read('src/background-control.js');
  const fast = read('src/background-fast-decision.js');

  assert.match(augment, /applyFocus as reportMarketFocus/);
  assert.match(augment, /applyFeed as reportMarketFeed/);
  assert.doesNotMatch(augment, /marketHistory:\s*mergedHistory/);
  assert.doesNotMatch(augment, /connection:\s*'connecting',\s*asset:/);

  assert.match(integrity, /repairMarketSessionIntegrity/);
  assert.match(integrity, /reportMarketFocus/);
  assert.match(integrity, /reportMarketClock/);
  assert.doesNotMatch(integrity, /function resetForFocus/);
  assert.doesNotMatch(integrity, /updateScannerState/);

  assert.match(control, /clearMarketAuthorityState/);
  assert.doesNotMatch(control, /asset:\s*null,\s*price:\s*null/);
  assert.doesNotMatch(control, /candles:\s*\[\],\s*currentCandle:\s*null,\s*marketHistory:/);

  assert.match(fast, /const observedEpoch = marketSessionEpoch\(observed\)/);
  assert.match(fast, /withMarketSessionEpoch\(current, observedEpoch/);
  assert.match(fast, /epoch:\s*observedEpoch/);
});
