import { structureDirectionScore } from './market-structure.js';

export const AI_WEIGHTS=Object.freeze({
  priceAction:25,
  indicators:20,
  emaTrend:15,
  volatility:10,
  correlation:10,
  news:10,
  momentum:10
});

export const AI_THRESHOLDS=Object.freeze({aggressive:65,balanced:75,aplus:85});
const clamp=(v,min=0,max=100)=>Math.max(min,Math.min(max,Number(v)||0));
const finite=v=>Number.isFinite(Number(v))?Number(v):null;

function indicatorScore({direction,indicators={},confirmations=0,total=6}){
  let score=total?confirmations/total*70:35;
  const rsi=finite(indicators.rsi14),macd=finite(indicators.macd?.histogram),e9=finite(indicators.ema9),e21=finite(indicators.ema21);
  if(direction==='BUY'&&rsi!=null&&rsi>=48&&rsi<=70)score+=10;
  if(direction==='SELL'&&rsi!=null&&rsi<=52&&rsi>=30)score+=10;
  if(direction==='BUY'&&macd!=null&&macd>0)score+=10;
  if(direction==='SELL'&&macd!=null&&macd<0)score+=10;
  if(direction==='BUY'&&e9!=null&&e21!=null&&e9>e21)score+=10;
  if(direction==='SELL'&&e9!=null&&e21!=null&&e9<e21)score+=10;
  return clamp(score);
}
function emaScore(direction,indicators={}){
  const e9=finite(indicators.ema9),e21=finite(indicators.ema21);if(e9==null||e21==null||!direction)return 50;
  const gap=Math.abs(e9-e21)/Math.max(Math.abs(e21),1e-9);
  const aligned=direction==='BUY'?e9>e21:e9<e21;
  return clamp((aligned?72:28)+Math.min(23,gap*100000));
}
function momentumScore(direction,indicators={}){
  const rsi=finite(indicators.rsi14),hist=finite(indicators.macd?.histogram);let score=50;
  if(rsi!=null){
    if(direction==='BUY')score+=(rsi>=52&&rsi<=68?24:rsi>72?-15:rsi<42?-12:5);
    else if(direction==='SELL')score+=(rsi<=48&&rsi>=32?24:rsi<28?-15:rsi>58?-12:5);
  }
  if(hist!=null){const aligned=direction==='BUY'?hist>0:direction==='SELL'?hist<0:false;score+=aligned?20:-18}
  return clamp(score);
}
function volatilityScore(indicators={},candles=[]){
  const atr=finite(indicators.atr14),last=finite(candles?.at?.(-1)?.close);if(atr==null||last==null||last===0)return 65;
  const pct=Math.abs(atr/last)*100;
  if(pct<.015)return 45;
  if(pct<.04)return 65;
  if(pct<=.35)return 92;
  if(pct<=.7)return 76;
  if(pct<=1.2)return 55;
  return 28;
}
function newsScore(news={}){if(news?.blocked)return 0;if(news?.unknown)return 65;const mins=Number(news?.minutesToNearest);if(Number.isFinite(mins)&&mins<15)return 25;if(Number.isFinite(mins)&&mins<30)return 62;return 100}
function explain(parts,finalScore,direction,profile){
  const favorable=[],against=[];
  const label={priceAction:'Price action',indicators:'Indicadores',emaTrend:'EMAs',volatility:'Volatilidade',correlation:'Correlação',news:'Notícias',momentum:'Momentum'};
  for(const [k,v] of Object.entries(parts)){const text=`${label[k]} ${Math.round(v)}`;if(v>=72)favorable.push(text);else if(v<50)against.push(text)}
  const dir=direction==='BUY'?'compra':direction==='SELL'?'venda':'sem direção';
  const grade=finalScore>=90?'Setup A+ muito forte':finalScore>=85?'Setup A+':finalScore>=75?'Boa confluência':finalScore>=65?'Setup agressivo':'Sem qualidade suficiente';
  const chunks=[`Nota ${Math.round(finalScore)} – ${grade}. Direção ${dir}.`];
  if(favorable.length)chunks.push(`A favor: ${favorable.slice(0,3).join(' + ')}.`);
  if(against.length)chunks.push(`Contra: ${against.slice(0,2).join(' + ')}.`);
  chunks.push(`Perfil ${profile==='aplus'?'A+':profile==='aggressive'?'Agressivo':'Balanceado'}.`);
  return chunks.join(' ');
}

export function weightedConfidence(input={}){
  const direction=input.direction||null,profile=['aggressive','balanced','aplus'].includes(input.profile)?input.profile:'balanced';
  const parts={
    priceAction:structureDirectionScore(input.structure||{},direction),
    indicators:indicatorScore({direction,indicators:input.indicators||{},confirmations:Number(input.confirmations||0),total:Number(input.totalConfirmations||6)}),
    emaTrend:emaScore(direction,input.indicators||{}),
    volatility:volatilityScore(input.indicators||{},input.candles||[]),
    correlation:clamp(input.correlation?.score??70),
    news:newsScore(input.news||{unknown:true}),
    momentum:momentumScore(direction,input.indicators||{})
  };
  let finalScore=0;for(const [key,weight] of Object.entries(AI_WEIGHTS))finalScore+=parts[key]*weight/100;
  finalScore=Math.round(clamp(finalScore)*10)/10;
  const threshold=AI_THRESHOLDS[profile];
  const blockers=[];
  if(!direction)blockers.push('Sem direção técnica definida');
  if(input.news?.blocked)blockers.push('Notícia de alto impacto próxima');
  if(parts.volatility<35)blockers.push('Volatilidade fora da faixa segura');
  if(input.correlation?.alignment==='conflicting'&&Number(input.correlation?.abs||0)>.85)blockers.push('Correlação forte em conflito');
  const approved=!!direction&&finalScore>=threshold&&!blockers.length;
  return{score:finalScore,threshold,approved,profile,weights:AI_WEIGHTS,parts,blockers,opinion:explain(parts,finalScore,direction,profile)};
}
