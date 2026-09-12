import { CandleBuilder, TIMEFRAMES } from './candles.js';
import { analyzeCandles } from './analysis.js';
import { confluence } from './confluence.js';
import { marketRegime, qualityGate } from './market-regime.js';
import { tradingGuard, dedupeSignal, riskProfile } from './risk-controls.js';
import { nextSignalState } from './signal-machine.js';
import { marketStructure } from './market-structure.js';
import { weightedConfidence } from './ai-scoring.js';

const builders=new Map();
const lastSignals=new Map();
const frame=s=>String(s.analysisTimeframe||s.timeframe||'M1').toUpperCase();
const key=s=>`${s.platformId||'unknown'}:${s.asset||'unknown'}:${frame(s)}`;
const tf=s=>TIMEFRAMES[frame(s)]||TIMEFRAMES.M1;
const priceOf=v=>{if(Number.isFinite(v))return Number(v);let s=String(v??'').trim().replace(/\s/g,'').replace(/[^\d,.-]/g,'');if(s.includes(',')&&s.includes('.'))s=s.lastIndexOf(',')>s.lastIndexOf('.')?s.replace(/\./g,'').replace(',','.'):s.replace(/,/g,'');else s=s.replace(',','.');const n=Number(s);return Number.isFinite(n)?n:null};
const aligned=(direction,a,b)=>direction==='BUY'?a>b:direction==='SELL'?a<b:false;
const recentFlow=candles=>{const rows=candles.slice(-5);let up=0,down=0,flat=0;for(const c of rows){const o=Number(c?.open),cl=Number(c?.close);if(!Number.isFinite(o)||!Number.isFinite(cl))continue;if(cl>o)up++;else if(cl<o)down++;else flat++}return{count:rows.length,up,down,flat,direction:up===down?null:up>down?'BUY':'SELL'}};
const aiProfile=risk=>{if(risk?.onlyA)return'aplus';if(['aggressive','balanced','aplus'].includes(risk?.aiMode))return risk.aiMode;if(risk?.profile==='aggressive')return'aggressive';if(risk?.profile==='conservative')return'aplus';return'balanced'};

const warm=(state,connected,candles,timeframe,targetExpiration,structured)=>({signal:{state:state.scanner==='scanning'?'SEARCHING':'WAIT',score:0,grade:'—',confirmations:'0 / 6',direction:null,timeframe,targetExpiration,hint:!connected?'Aguardando preço válido.':state.scanner!=='scanning'?'Scanner pronto.':`Aquecendo motor • ${Math.min(candles.length,21)}/21 velas ${structured?'validadas':'provisórias'}.`,provisional:!structured,candleCount:candles.length,recentFlow:recentFlow(candles),warmup:{current:Math.min(candles.length,21),required:21},technical:null,ai:null}});

export function resetOrchestrator(){builders.clear();lastSignals.clear()}

export function processSnapshot(snapshot={},state={},risk={}){
  const price=priceOf(snapshot.price),connected=price!==null,k=key(snapshot),analysisTimeframe=frame(snapshot),targetExpiration=snapshot.targetExpiration||snapshot.expiration||null,structured=!!snapshot.capabilities?.structuredQuotes;
  const serverTime=Number(snapshot.serverTime),staleMs=Math.max(1200,Number(risk.staleMs)||6000),stale=risk.staleBlock!==false&&Number.isFinite(serverTime)&&serverTime>1e12&&Math.abs(Date.now()-serverTime)>staleMs;
  if(!builders.has(k))builders.set(k,new CandleBuilder(tf(snapshot)));
  const builder=builders.get(k);if(Array.isArray(snapshot.candles)&&snapshot.candles.length)builder.seed(snapshot.candles);
  const closed=connected?builder.push(price,Number(snapshot.serverTime)||Date.now()):null,candles=builder.snapshot().closed;
  if(candles.length<21)return warm(state,connected,candles,analysisTimeframe,targetExpiration,structured);
  if(!closed&&state.signal?.updatedAt)return{signal:{...state.signal,timeframe:analysisTimeframe,targetExpiration,candleCount:candles.length,recentFlow:recentFlow(candles),provisional:!structured,warmup:{current:21,required:21}}};

  const analysis=analyzeCandles(candles),regime=marketRegime(candles),recent=recentFlow(candles),structure=marketStructure(candles),rsi=analysis.indicators?.rsi14,macd=analysis.indicators?.macd?.histogram,e9=analysis.indicators?.ema9,e21=analysis.indicators?.ema21,d=analysis.direction;
  const checks=[
    {label:'Direção quantitativa',weight:20,passed:!!d},
    {label:'Tendência EMA alinhada',weight:20,passed:aligned(d,e9,e21)},
    {label:'RSI compatível',weight:20,passed:d==='BUY'?rsi>=50&&rsi<75:d==='SELL'?rsi<=50&&rsi>25:false},
    {label:'MACD alinhado',weight:20,passed:d==='BUY'?macd>0:d==='SELL'?macd<0:false},
    {label:'Estrutura de mercado',weight:10,passed:structure.ready&&structure.trend!=='sideways'},
    {label:'Regime identificado',weight:10,passed:regime.type!=='unknown'}
  ];
  const cf=confluence(checks),profile=aiProfile(risk),ai=weightedConfidence({direction:d,profile,structure,indicators:analysis.indicators,candles,confirmations:cf.confirmations,totalConfirmations:cf.total,correlation:risk.correlation||{score:70},news:risk.newsRisk||{unknown:true}});
  const gate=qualityGate({connected,stale,regime,dataQuality:structured?1:.82}),guard=tradingGuard({...risk,profile:risk.profile||'moderate',requestedStake:risk.requestedStake});
  const candidate={asset:snapshot.asset,direction:d,createdAt:Date.now()},duplicate=!!d&&dedupeSignal(lastSignals.get(k),candidate,risk.cooldownMs||riskProfile(risk.profile).cooldownMs),baseAllowed=gate.allowed&&guard.allowed&&!duplicate&&!ai.blockers.length,scoreReady=!!d&&ai.score>=ai.threshold,provisionalWatch=!structured&&baseAllowed&&scoreReady,allowed=structured&&baseAllowed;
  const finalAnalysis={...analysis,score:ai.score,state:allowed?(scoreReady?'WATCH':'WAIT'):provisionalWatch?'WATCH':'NO_TRADE'};
  const machine=provisionalWatch?{state:'WATCH',label:`${d} • PRÉ-SINAL PROVISÓRIO`}:nextSignalState(state.signal?.state,finalAnalysis,{connected,scanning:state.scanner==='scanning',stale,confirmThreshold:ai.threshold,watchThreshold:Math.max(60,ai.threshold-10)});
  const blocked=[...gate.reasons,...guard.reasons,...ai.blockers,duplicate?'Sinal duplicado em cooldown':null,!structured&&!provisionalWatch?'Feed estruturado ainda não validado':null,baseAllowed&&!scoreReady?`Nota IA ${ai.score}/${ai.threshold} abaixo do mínimo`:null].filter(Boolean);
  if(allowed&&scoreReady&&machine.state==='CONFIRM')lastSignals.set(k,candidate);
  const readyDirection=baseAllowed&&scoreReady?d:null,recentText=recent.count>=3?`Últimas ${recent.count} velas: ${recent.up} alta • ${recent.down} baixa`:null;
  const hint=provisionalWatch?`${machine.label} • aguardando validação do feed antes de confirmar entrada.`:allowed&&scoreReady?`${machine.label} • Nota IA ${ai.score}.`:blocked.join(' • ')||`Aguardando nota mínima ${ai.threshold}.`;
  return{signal:{state:machine.state,score:baseAllowed?ai.score:0,rawScore:cf.score,grade:ai.score>=85?'A+':ai.score>=75?'A':ai.score>=65?'B':'C',confirmations:`${cf.confirmations} / ${cf.total}`,direction:readyDirection,timeframe:analysisTimeframe,targetExpiration,hint,reasons:[...new Set([...(analysis.reasons||[]),...(cf.reasons||[]),recentText,ai.opinion,...(guard.warnings||[])].filter(Boolean))],regime:regime.type,recentFlow:recent,provisional:!structured,candleCount:candles.length,warmup:{current:21,required:21},threshold:ai.threshold,updatedAt:Date.now(),ai,technical:{indicators:analysis.indicators,structure,volatilityScore:ai.parts.volatility,correlation:risk.correlation||null,news:risk.newsRisk||null},risk:{profile:risk.profile||'moderate',suggestedStake:guard.bankroll?.suggestedStake??null,warnings:guard.warnings||[],blocks:guard.reasons||[]}}};
}
