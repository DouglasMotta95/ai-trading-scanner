import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeCandles, INDICATOR_SCORE_WEIGHTS } from '../src/core/analysis.js';

test('approved indicator weights remain unchanged',()=>{
  assert.deepEqual(INDICATOR_SCORE_WEIGHTS,{rsiFavor:8,macdFavor:10,macdAgainst:-10,ema:0,bollinger:0});
});

test('indicator layer still augments price action instead of replacing it',()=>{
  const candles=[];
  let p=1;
  for(let i=0;i<40;i++){const open=p,close=open+0.001;candles.push({open,high:close+0.002,low:open-0.002,close});p=close;}
  const out=analyzeCandles(candles.slice(-10),candles);
  assert.equal(out.recent.count,10);
  assert.ok(Number.isFinite(out.score));
  assert.ok(out.indicators);
  assert.ok(Number.isFinite(out.analytics.buyPower));
});
