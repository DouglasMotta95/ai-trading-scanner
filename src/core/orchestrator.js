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
const round=v=>Math.round(Number(v||0)*10)/10;
const shortRegime=recent=>recent?.lateral?'sideways':recent?.direction==='BUY'?'uptrend':recent?.direction==='SELL'?'downtrend':'unknown';

const warm=(state,connected,candles,timeframe,targetExpiration,structured,required)=>({signal:{state:state.scanner==='scanning'?'SEARCHING':'WAIT',score:0,grade:'—',confirmations:'0 / 4',direction:null,timeframe,targetExpiration,hint:!connected?'Aguardando preço válido.':state.scanner!=='scanning'?'Scanner pronto.':`Lendo as velas mais recentes • ${Math.min(candles.length,required)}/${required} velas fechadas ${structured?'com feed validado':'em validação'}.`,provisional:!structured,candleCount:candles.length,recentFlow:recentFlow(candles),warmup:{current:Math.min(candles.length,required),required},technical:null,ai:null}});

export function resetOrchestrator(){builders.clear();lastSignals.clear()}

export function processSnapshot(snapshot={},state={},risk={}){
  const price=priceOf(snapshot.price),connected=price!==null,k=key(snapshot),analysisTimeframe=frame(snapshot),targetExpiration=snapshot.targetExpiration||snapshot.expiration||null,structured=!!snapshot.capabilities?.structuredQuotes;
  const serverTime=Number(snapshot.serverTime),staleMs=Math.max(1200,Number(risk.staleMs)||6000),stale=risk.staleBlock!==false&&Number.isFinite(serverTime)&&serverTime>1e12&&Math.abs(Date.now()-serverTime)>staleMs;
  const minCandles=structured&&!stale?3:5;
  if(!builders.has(k))builders.set(k,new CandleBuilder(tf(snapshot)));
  const builder=builders.get(k);if(Array.isArray(snapshot.candles)&&snapshot.candles.length)builder.seed(snapshot.candles);
  const closed=connected?builder.push(price,Number(snapshot.serverTime)||Date.now()):null,candles=builder.snapshot().closed;
  if(candles.length<minCandles)return warm(state,connected,candles,analysisTimeframe,targetExpiration,structured,minCandles);
  if(!closed&&state.signal?.updatedAt)return{signal:{...state.signal,timeframe:analysisTimeframe,targetExpiration,candleCount:candles.length,recentFlow:recentFlow(candles),provisional:!structured,warmup:{current:minCandles,required:minCandles}}};

  const analysis=analyzeCandles(candles),recent=analysis.recent||{},longEnough=candles.length>=20;
  const longRegime=longEnough?marketRegime(candles):{type:shortRegime(recent)};
  const longStructure=candles.length>=5?marketStructure(candles):{ready:false,support:null,resistance:null,trend:'unknown'};
  const structure={...longStructure,ready:true,support:recent.support??longStructure.support,resistance:recent.resistance??longStructure.resistance,trend:recent.direction==='BUY'?'up':recent.direction==='SELL'?'down':longStructure.trend,shortTerm:recent};
  const rsi=analysis.indicators?.rsi14,macd=analysis.indicators?.macd?.histogram,e9=analysis.indicators?.ema9,e21=analysis.indicators?.ema21,d=analysis.direction;
  const checks=[
    {label:'Estrutura das últimas velas',weight:35,passed:!!d&&!recent.lateral},
    {label:'Maioria direcional 3–5 velas',weight:25,passed:Number(recent.aligned||0)>=3},
    {label:'Rompimento ou rejeição clara',weight:20,passed:!!recent.breakout||!!recent.rejection},
    {label:'Contexto EMA/RSI/MACD',weight:20,passed:e9!=null&&e21!=null?aligned(d,e9,e21):rsi!=null||macd!=null}
  ];
  const cf=confluence(checks),profile=aiProfile(risk),weighted=weightedConfidence({direction:d,profile,structure,indicators:analysis.indicators,candles,confirmations:cf.confirmations,totalConfirmations:cf.total,correlation:risk.correlation||{score:70},news:risk.newsRisk||{unknown:true},recentAnalysis:recent});
  const recentWeight=longEnough?.60:.72,score=round((Number(recent.score)||0)*recentWeight+Number(weighted.score||0)*(1-recentWeight));
  const shortBlockers=[];
  if(recent.lateral)shortBlockers.push('Últimas velas laterais e sem direção clara');
  if(recent.doji&&!recent.rejection)shortBlockers.push('Doji extremo sem contexto suficiente');
  if(!d)shortBlockers.push('Estrutura recente sem direção definida');
  const ai={...weighted,score,approved:!!d&&score>=weighted.threshold&&!shortBlockers.length&&!weighted.blockers.length,blockers:[...new Set([...(weighted.blockers||[]),...shortBlockers])],opinion:recent.opinion||weighted.opinion,shortTerm:{score:recent.score,projection:recent.projection,support:recent.support,resistance:recent.resistance,count:recent.count}};

  const quickGate=longEnough?qualityGate({connected,stale,regime:longRegime,dataQuality:structured?1:.82}):{allowed:connected&&!stale,reasons:[...(!connected?['Preço indisponível']:[]),...(stale?['Cotação desatualizada']:[])]};
  const guard=tradingGuard({...risk,profile:risk.profile||'moderate',requestedStake:risk.requestedStake});
  const candidate={asset:snapshot.asset,direction:d,createdAt:Date.now()},duplicate=!!d&&dedupeSignal(lastSignals.get(k),candidate,risk.cooldownMs||riskProfile(risk.profile).cooldownMs),baseAllowed=quickGate.allowed&&guard.allowed&&!duplicate&&!ai.blockers.length,scoreReady=!!d&&ai.score>=ai.threshold,provisionalWatch=!structured&&baseAllowed&&scoreReady,allowed=structured&&baseAllowed;
  const finalAnalysis={...analysis,score:ai.score,state:allowed?(scoreReady?'WATCH':'WAIT'):provisionalWatch?'WATCH':'NO_TRADE'};
  const machine=provisionalWatch?{state:'WATCH',label:`${d} • PRÉ-SINAL PROVISÓRIO`}:nextSignalState(state.signal?.state,finalAnalysis,{connected,scanning:state.scanner==='scanning',stale,confirmThreshold:ai.threshold,watchThreshold:Math.max(60,ai.threshold-10)});
  const blocked=[...quickGate.reasons,...guard.reasons,...ai.blockers,duplicate?'Sinal duplicado em cooldown':null,!structured&&!provisionalWatch?'Feed estruturado ainda não validado':null,baseAllowed&&!scoreReady?`Nota ${ai.score}/${ai.threshold} abaixo do mínimo`:null].filter(Boolean);
  if(allowed&&scoreReady&&machine.state==='CONFIRM')lastSignals.set(k,candidate);
  const readyDirection=baseAllowed&&scoreReady?d:null,recentText=`Últimas ${recent.count||Math.min(5,candles.length)} velas: ${recent.up||0} alta • ${recent.down||0} baixa`;
  const hint=provisionalWatch?`${machine.label} • estrutura recente aprovada, aguardando feed validado.`:allowed&&scoreReady?`${machine.label} • Nota ${ai.score}. ${recent.projection||''}`.trim():blocked.join(' • ')||`Aguardando nota mínima ${ai.threshold}.`;
  return{signal:{state:machine.state,score:baseAllowed?ai.score:0,rawScore:cf.score,grade:ai.score>=85?'A+':ai.score>=75?'A':ai.score>=65?'B':'C',confirmations:`${cf.confirmations} / ${cf.total}`,direction:readyDirection,timeframe:analysisTimeframe,targetExpiration,hint,reasons:[...new Set([...(analysis.reasons||[]),...(cf.reasons||[]),recentText,ai.opinion,...(guard.warnings||[])].filter(Boolean))],regime:longRegime.type||shortRegime(recent),recentFlow:recentFlow(candles),recentAnalysis:recent,provisional:!structured,candleCount:candles.length,warmup:{current:minCandles,required:minCandles},threshold:ai.threshold,updatedAt:Date.now(),ai,technical:{indicators:analysis.indicators,structure,shortTerm:recent,volatilityScore:ai.parts?.volatility,correlation:risk.correlation||null,news:risk.newsRisk||null},risk:{profile:risk.profile||'moderate',suggestedStake:guard.bankroll?.suggestedStake??null,dailyTarget:guard.bankroll?.dailyTarget??null,dailyStop:guard.bankroll?.dailyStop??null,dailyPnl:guard.bankroll?.dailyPnl??null,status:guard.bankroll?.status||'within_risk',warnings:guard.warnings||[],blocks:guard.reasons||[]}}};
}
