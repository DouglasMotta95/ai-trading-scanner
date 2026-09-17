import test from 'node:test';
import assert from 'node:assert/strict';
import { marketRegime, EXTREME_VOLATILITY_MULTIPLIER } from '../src/core/market-regime.js';

function candles(lastRange=1){
  const rows=[];
  for(let i=0;i<20;i++) rows.push({open:100+i,high:101+i,low:100+i,close:101+i});
  rows[19]={open:119,high:119+lastRange,low:119,close:119+lastRange};
  return rows;
}

test('Phase B uses a 2.5x extreme-volatility threshold',()=>{
  assert.equal(EXTREME_VOLATILITY_MULTIPLIER,2.5);
});

test('Phase B marks a candle above 2.5x prior average as blocked range',()=>{
  const result=marketRegime(candles(3));
  assert.equal(result.extremeVolatility,true);
  assert.equal(result.type,'range');
  assert.ok(result.volatilityRatio>=2.5);
});

test('Phase B does not flag a normal candle as extreme',()=>{
  const result=marketRegime(candles(1.5));
  assert.equal(result.extremeVolatility,false);
  assert.ok(result.volatilityRatio<2.5);
});
