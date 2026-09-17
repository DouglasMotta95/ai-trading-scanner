import test from 'node:test';
import assert from 'node:assert/strict';
import { findCasaTradeTab, selectCasaTradeTab } from '../src/services/casatrade-tab-selection.js';

test('findCasaTradeTab finds CasaTrade even when it is not the active tab', async () => {
  const calls = [];
  const result = await findCasaTradeTab(async query => {
    calls.push(query);
    return [
      { id: 11, active: true, url: 'https://example.com/', lastAccessed: 5000 },
      { id: 22, active: false, url: 'https://trade.casatrade.com/', lastAccessed: 4000 }
    ];
  });

  assert.deepEqual(calls, [{}]);
  assert.equal(result.tab.id, 22);
  assert.equal(result.platform.id, 'casatrade');
});

test('selectCasaTradeTab prefers most recently used CasaTrade tab and active tab only breaks a tie', () => {
  const mostRecent = selectCasaTradeTab([
    { id: 1, active: true, url: 'https://app.casatrade.com/', lastAccessed: 1000 },
    { id: 2, active: false, url: 'https://trade.casatrade.com/', lastAccessed: 2000 }
  ]);
  assert.equal(mostRecent.tab.id, 2);

  const activeTie = selectCasaTradeTab([
    { id: 3, active: false, url: 'https://app.casatrade.com/', lastAccessed: 3000 },
    { id: 4, active: true, url: 'https://trade.casatrade.com/', lastAccessed: 3000 }
  ]);
  assert.equal(activeTie.tab.id, 4);
});
