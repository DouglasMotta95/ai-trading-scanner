import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createManualTrade, resolveManualTrades, resolveManualTradesFromFeed, manualTradeMetrics } from '../src/core/manual-trades.js';

const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');

function baseState() {
  const targetStart = 1_800_000_000_000;
  return {
    asset: 'EUR/USD (OTC)', price: 1.1005, timeframe: 'M1', analysisTimeframe: 'M1',
    connection: 'online',
    signal: { uiState: 'ENTER_BUY', state: 'CONFIRM', direction: 'BUY', targetStart, analysisScore: 72, setup: 'continuação' },
    decisionCycle: { locked: 'ENTER', direction: 'BUY', targetStart, score: 72, setup: 'continuação' }
  };
}

test('manual BUY click captures canonical quote and links only when signal timing matches', () => {
  const state = baseState();
  const trade = createManualTrade(state, { direction: 'BUY', clickedAt: state.signal.targetStart + 1200, label: 'Comprar' }, state.signal.targetStart + 1200, 'trade-1');
  assert.ok(trade);
  assert.equal(trade.asset, 'EUR/USD (OTC)');
  assert.equal(trade.entryPrice, 1.1005);
  assert.equal(trade.entrySource, 'canonical_quote_at_click');
  assert.equal(trade.matchedSignal, true);
  assert.equal(trade.timingAligned, true);
  assert.equal(trade.targetEnd, state.signal.targetStart + 60_000);
});

test('manual result compares exit to actual click quote, not candle color', () => {
  const state = baseState();
  const trade = createManualTrade(state, { direction: 'BUY', clickedAt: state.signal.targetStart + 1000 }, state.signal.targetStart + 1000, 'trade-2');
  const resolutionState = {
    asset: 'EUR/USD (OTC)', timeframe: 'M1', analysisTimeframe: 'M1',
    candles: [{ time: state.signal.targetStart, open: 1.1000, high: 1.1010, low: 1.0998, close: 1.1003 }]
  };
  const result = resolveManualTrades([trade], resolutionState, state.signal.targetStart + 61_000).rows[0];
  assert.equal(result.result, 'LOSS');
  assert.equal(result.exitPrice, 1.1003);
  assert.equal(result.resultSource, 'target_candle_close');
});

test('pending manual trade can resolve from feed history even after user switched charts', () => {
  const state = baseState();
  const trade = createManualTrade(state, { direction: 'BUY', clickedAt: state.signal.targetStart + 500 }, state.signal.targetStart + 500, 'trade-feed');
  const payload = {
    recentCandles: {
      'GBP/USD': [{ time: state.signal.targetStart, open: 1.2, high: 1.21, low: 1.19, close: 1.205 }],
      'EUR/USD (OTC)': [{ time: state.signal.targetStart, open: 1.1000, high: 1.1020, low: 1.0990, close: 1.1015 }]
    }
  };
  const result = resolveManualTradesFromFeed([trade], payload, state.signal.targetStart + 61_000).rows[0];
  assert.equal(result.result, 'WIN');
  assert.equal(result.exitPrice, 1.1015);
});

test('manual click outside confirmed direction is recorded but excluded from scanner win rate', () => {
  const state = baseState();
  const trade = createManualTrade(state, { direction: 'SELL', clickedAt: state.signal.targetStart + 1000 }, state.signal.targetStart + 1000, 'trade-3');
  assert.equal(trade.matchedSignal, false);
  const metrics = manualTradeMetrics([{ ...trade, status: 'RESOLVED', result: 'WIN', exitPrice: 1.09 }]);
  assert.equal(metrics.totalClicks, 1);
  assert.equal(metrics.matchedSignals, 0);
  assert.equal(metrics.winRate, null);
  assert.equal(metrics.unmatched, 1);
});

test('manual trade observer is passive and runtime wires ledger without automatic platform clicks', () => {
  const observer = read('src/content/manual-trade-observer.js');
  const manifest = JSON.parse(read('manifest.json'));
  const entry = read('src/background-entry.js');
  const background = read('src/background-manual-trades.js');
  const core = read('src/core/manual-trades.js');
  const injector = read('src/background-modern-injector.js');
  const scripts = manifest.content_scripts.flatMap(row => row.js || []);
  assert.ok(scripts.includes('src/content/manual-trade-observer.js'));
  assert.match(entry, /background-manual-trades\.js/);
  assert.match(injector, /manual-trade-observer\.js/);
  assert.match(observer, /addEventListener\('click'/);
  assert.match(observer, /ATS_MANUAL_TRADE_CLICK/);
  assert.doesNotMatch(observer, /\.click\s*\(/);
  assert.match(core, /target_candle_close/);
  assert.match(background, /ATS_GET_MANUAL_TRADE_LEDGER/);
  assert.match(background, /resolveManualTradesFromFeed/);
});
