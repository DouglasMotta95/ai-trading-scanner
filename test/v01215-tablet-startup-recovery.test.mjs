import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');
function extractGate() {
  const source = read('src/sidepanel/app-v2.js');
  const start = source.indexOf('function stableConfirmedMarketDisplay(');
  const end = source.indexOf('\nfunction marketIdentityReady(', start);
  assert.ok(start >= 0 && end > start);
  const norm = value => String(value ?? '').trim().toUpperCase().replace(/\s*\(OTC\)$/, ' (OTC)').replace(/\s+/g, '');
  const context = {
    Date,
    sessionInfo: state => state.diagnostics?.marketSession || {},
    marketId: norm,
    sameMarket: (a, b) => !!norm(a) && norm(a) === norm(b),
    num: value => value == null || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null
  };
  vm.runInNewContext(source.slice(start, end) + '\nglobalThis.gate = stableConfirmedMarketDisplay;', context);
  return context.gate;
}
function base(now) {
  return {
    asset: 'USD/CHF (OTC)', connection: 'online', price: 0.8325, lastSeen: now - 1000,
    candles: [{open:0.832,high:0.833,low:0.831,close:0.8325},{open:0.8325,high:0.834,low:0.832,close:0.833}],
    signal: {asset:'USD/CHF (OTC)',score:29}, currentCandle: {asset:'USD/CHF (OTC)'},
    diagnostics: {
      focusedAsset: {asset:'USD/CHF (OTC)',reliable:true,chartScoped:true,trustedChartFrame:true,at:now-8000},
      marketSession: {asset:'USD/CHF (OTC)',confirmedAsset:'USD/CHF (OTC)',dataReady:true,transitioning:false}
    }
  };
}
test('same confirmed live market stays visible during a short tablet focus heartbeat gap', () => {
  const now=100000;
  assert.equal(extractGate()(base(now),now),true);
});
test('visual grace rejects mismatched asset, market transition, stale data and old focus', () => {
  const now=100000, gate=extractGate(), s=base(now);
  assert.equal(gate({...s,signal:{asset:'EUR/USD (OTC)'}},now),false);
  assert.equal(gate({...s,diagnostics:{...s.diagnostics,marketSession:{...s.diagnostics.marketSession,transitioning:true}}},now),false);
  assert.equal(gate({...s,lastSeen:now-12000},now),false);
  assert.equal(gate({...s,diagnostics:{...s.diagnostics,focusedAsset:{...s.diagnostics.focusedAsset,at:now-16000}}},now),false);
});
test('clock header and entry authorization require available valid seconds and fresh focus', () => {
  const shell=read('src/sidepanel/ui-shell-v2.js'), panel=read('src/sidepanel/app-v2.js');
  assert.match(shell,/clock\?\.available === true/);
  assert.match(shell,/Number\.isFinite\(remaining\) \|\| remaining < 0 \|\| remaining > duration \+ 2/);
  assert.match(panel,/const timeReady = !alignment\.conflict && focusReady\(state\) && entryTimeReady\(state\)/);
});
test('tablet clock reader requests real focus/control refresh instead of guessing timeframe', () => {
  const clock=read('src/content/market-cycle-clock-v4.js');
  assert.match(clock,/focusAge > 4200/);
  assert.match(clock,/__ATS_FORCE_FOCUS_SCAN__\?\.\(\)/);
  assert.match(clock,/__ATS_FORCE_PLATFORM_SYNC_READ__\?\.\(\)/);
});
