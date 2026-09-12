import { analyzeCandles } from './analysis.js';
import { marketStructure } from './market-structure.js';
import { weightedConfidence } from './ai-scoring.js';

const n=v=>Number.isFinite(Number(v))?Number(v):null;
const tfType=tf=>/^S(?:5|15|30)$|^M1$/i.test(String(tf||''))?'scalping':'normal';
const outcome=(direction,entry,exit)=>{if(entry===exit)return'draw';if(direction==='BUY')return exit>entry?'win':'loss';if(direction==='SELL')return exit<entry?'win':'loss';return'unknown'};
const round=v=>Math.round(Number(v||0)*10)/10;

function metrics(trades=[],payout=.85){
  let equity=0,peak=0,maxDrawdown=0,wins=0,losses=0,draws=0,best=0,worst=0,w=0,l=0;
  for(const t of trades){let pnl=0;if(t.outcome==='win'){wins++;pnl=payout;w++;l=0;best=Math.max(best,w)}else if(t.outcome==='loss'){losses++;pnl=-1;l++;w=0;worst=Math.max(worst,l)}else{draws++;w=0;l=0}equity+=pnl;peak=Math.max(peak,equity);maxDrawdown=Math.max(maxDrawdown,peak-equity);t.pnl=pnl}
  const decisive=wins+losses;
  return{trades:trades.length,wins,losses,draws,winRate:decisive?Math.round(wins/decisive*1000)/10:null,profitUnits:Math.round(equity*100)/100,maxDrawdownUnits:Math.round(maxDrawdown*100)/100,bestWinStreak:best,worstLossStreak:worst};
}

function simulate(candles,profile,threshold,timeframe='M1',payout=.85){
  const trades=[];
  for(let i=4;i<candles.length-1;i++){
    const window=candles.slice(Math.max(0,i-80),i+1),analysis=analyzeCandles(window),recent=analysis.recent||{},direction=analysis.direction;
    if(!direction||!recent.ready||recent.lateral||(recent.doji&&!recent.rejection))continue;
    const structure=marketStructure(window);
    const review=weightedConfidence({direction,profile,structure:{...structure,shortTerm:recent,support:recent.support??structure.support,resistance:recent.resistance??structure.resistance},indicators:analysis.indicators,candles:window,confirmations:Number(recent.aligned||0)>=3?3:2,totalConfirmations:4,correlation:{score:70},news:{unknown:true}});
    const recentWeight=window.length<21?.72:.60,score=round(Number(recent.score||0)*recentWeight+Number(review.score||0)*(1-recentWeight));
    if(score<threshold||review.blockers?.length)continue;
    const entry=n(candles[i]?.close),exit=n(candles[i+1]?.close);if(entry==null||exit==null)continue;
    const setup=score>=85?'A+':tfType(timeframe)==='scalping'?'scalping':'normal';
    trades.push({at:n(candles[i]?.time??candles[i]?.timestamp),direction,entry,exit,score,setup,projection:recent.projection,support:recent.support,resistance:recent.resistance,outcome:outcome(direction,entry,exit)});
  }
  return{profile,threshold,...metrics(trades,payout),trades};
}

export function runBacktest(candles=[],options={}){
  const rows=(Array.isArray(candles)?candles:[]).filter(c=>[c?.open,c?.high,c?.low,c?.close].every(v=>n(v)!=null)).sort((a,b)=>Number(a.time??a.timestamp)-Number(b.time??b.timestamp));
  const payout=Number.isFinite(Number(options.payout))?Number(options.payout):.85,timeframe=options.timeframe||'M1';
  if(rows.length<6)return{ok:false,error:'insufficient_history',required:6,available:rows.length,generatedAt:Date.now()};
  const profiles={
    conservative:simulate(rows,'aplus',85,timeframe,payout),
    moderate:simulate(rows,'balanced',75,timeframe,payout),
    aggressive:simulate(rows,'aggressive',65,timeframe,payout)
  };
  const all=profiles.moderate.trades;
  const bySetup={};for(const type of['A+','normal','scalping'])bySetup[type]=metrics(all.filter(t=>t.setup===type),payout);
  return{ok:true,generatedAt:Date.now(),candles:rows.length,timeframe,payout,strategy:'price-action-3-5',profiles,bySetup,summary:profiles.moderate};
}
