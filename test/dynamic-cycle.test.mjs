import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { CandleBuilder } from '../src/core/candles.js';
const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');

test('clock v4 keeps CasaTrade cycle authoritative and derived countdown diagnostic only', () => {
  const clock = read('src/content/market-cycle-clock-v4.js');
  const manifest = JSON.parse(read('manifest.json'));
  const scripts = manifest.content_scripts.flatMap(row => row.js || []);
  assert.match(clock, /const cycleTf = \(controlsFresh \? tf\(expiration\) \|\| tf\(controls\.timeframe\) : null\)/);
  assert.match(clock, /const domClock = \(!chartTf \|\| chartTf === cycleTf\) \? exactDomCountdown\(cycleTf\) : null/);
  assert.match(clock, /clockSource: 'trader-dom-countdown'/);
  assert.match(clock, /clockSource: 'platform-cycle-derived'/);
  assert.match(clock, /available: false, verified: false/);
  assert.ok(scripts.includes('src/content/market-cycle-clock-v4.js'));
  assert.ok(!scripts.includes('src/content/market-cycle-clock-v3.js'));
  assert.ok(!scripts.includes('src/content/market-clock-sync.js'));
});

test('M1 seed aggregates to M5 OHLC',()=>{
 const b=new CandleBuilder(300000); const base=1800000000000;
 b.seed([
 {time:base,open:10,high:12,low:9,close:11,timeframe:'M1'},
 {time:base+60000,open:11,high:13,low:10,close:12,timeframe:'M1'},
 {time:base+120000,open:12,high:14,low:8,close:9,timeframe:'M1'},
 {time:base+180000,open:9,high:10,low:7,close:8,timeframe:'M1'},
 {time:base+240000,open:8,high:15,low:8,close:14,timeframe:'M1'}]);
 const rows=b.snapshot().closed; assert.equal(rows.length,1); assert.deepEqual([rows[0].open,rows[0].high,rows[0].low,rows[0].close],[10,15,7,14]);
});

test('orchestrator permits compatible lower timeframe and arbitrary valid cycles',()=>{
  const s=read('src/core/orchestrator-legacy.js');
  assert.match(s,/function parseTimeframeMs\(/);
  assert.match(s,/Number\(match\[1\]\) \* 60_000/);
  assert.match(s,/sourceMs < targetMs && targetMs % sourceMs === 0/);
});

test('build guard clears stale operational state on extension version change',()=>{
  const guard=read('src/background-build-guard.js');
  const entry=read('src/background-entry.js');
  assert.match(guard,/atsLoadedBuildVersion/);
  assert.match(guard,/chrome\.runtime\.getManifest\(\)\.version/);
  assert.match(guard,/connection: 'offline'/);
  assert.match(guard,/signal: null/);
  assert.match(entry,/background-build-guard\.js/);
});
