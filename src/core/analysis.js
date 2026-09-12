import { ema, rsi, macd, atr, bollinger } from './indicators.js';

export { ema, rsi };

const finite=v=>Number.isFinite(Number(v))?Number(v):null;
const clamp=(v,min=0,max=100)=>Math.max(min,Math.min(max,Number(v)||0));
const avg=a=>a.length?a.reduce((s,v)=>s+v,0)/a.length:0;

function shape(c){
  const open=finite(c?.open),high=finite(c?.high),low=finite(c?.low),close=finite(c?.close);
  if([open,high,low,close].some(v=>v==null))return null;
  const range=Math.max(1e-12,high-low),body=Math.abs(close-open),upper=high-Math.max(open,close),lower=Math.min(open,close)-low;
  return{open,high,low,close,range,body,bodyRatio:body/range,upperRatio:upper/range,lowerRatio:lower/range,direction:close>open?'BUY':close<open?'SELL':null};
}

export function recentPriceAction(candles=[]){
  const rows=(Array.isArray(candles)?candles:[]).map(shape).filter(Boolean).slice(-5);
  if(rows.length<3)return{ready:false,required:3,count:rows.length,direction:null,score:0,opinion:'Aguardando pelo menos 3 velas fechadas reais.',support:null,resistance:null,trend:null,breakout:null,lateral:false,doji:false,rejection:null,aligned:0};

  const last=rows.at(-1),prev=rows.slice(0,-1),support=Math.min(...rows.map(x=>x.low)),resistance=Math.max(...rows.map(x=>x.high));
  const up=rows.filter(x=>x.direction==='BUY').length,down=rows.filter(x=>x.direction==='SELL').length,aligned=Math.max(up,down),majority=up===down?null:up>down?'BUY':'SELL';
  const avgRange=avg(rows.map(x=>x.range)),avgBody=avg(rows.map(x=>x.bodyRatio)),rangeSpan=resistance-support;
  const tiny=rows.filter(x=>x.bodyRatio<.2).length;
  const lateral=rangeSpan>0&&Math.abs(rows.at(-1).close-rows[0].open)/rangeSpan<.2&&avgBody<.38;
  const doji=last.bodyRatio<.12&&last.upperRatio>.28&&last.lowerRatio>.28;
  const force=last.bodyRatio>=.62;
  const prevHigh=Math.max(...prev.slice(-3).map(x=>x.high)),prevLow=Math.min(...prev.slice(-3).map(x=>x.low));
  const breakout=last.close>prevHigh?'BUY':last.close<prevLow?'SELL':null;
  const rejection=last.lowerRatio>=.5&&last.close>last.open?'BUY':last.upperRatio>=.5&&last.close<last.open?'SELL':null;
  const higherHighs=rows.slice(1).filter((x,i)=>x.high>rows[i].high).length;
  const higherLows=rows.slice(1).filter((x,i)=>x.low>rows[i].low).length;
  const lowerHighs=rows.slice(1).filter((x,i)=>x.high<rows[i].high).length;
  const lowerLows=rows.slice(1).filter((x,i)=>x.low<rows[i].low).length;
  const structureBuy=higherHighs>=Math.max(1,rows.length-3)&&higherLows>=Math.max(1,rows.length-3);
  const structureSell=lowerHighs>=Math.max(1,rows.length-3)&&lowerLows>=Math.max(1,rows.length-3);

  let buy=0,sell=0;const reasons=[];
  if(majority==='BUY'){buy+=aligned>=4?30:aligned>=3?24:14;reasons.push(`${up} de ${rows.length} velas recentes fecharam em alta`)}
  if(majority==='SELL'){sell+=aligned>=4?30:aligned>=3?24:14;reasons.push(`${down} de ${rows.length} velas recentes fecharam em baixa`)}
  if(structureBuy){buy+=22;reasons.push('Máximas e mínimas recentes estão ascendentes')}
  if(structureSell){sell+=22;reasons.push('Máximas e mínimas recentes estão descendentes')}
  if(force&&last.direction==='BUY'){buy+=18;reasons.push('Última vela fechou com corpo comprador dominante')}
  if(force&&last.direction==='SELL'){sell+=18;reasons.push('Última vela fechou com corpo vendedor dominante')}
  if(breakout==='BUY'){buy+=18;reasons.push('Rompimento da máxima das velas anteriores')}
  if(breakout==='SELL'){sell+=18;reasons.push('Rompimento da mínima das velas anteriores')}
  if(rejection==='BUY'){buy+=22;reasons.push('Pavio inferior forte indica rejeição na região de suporte')}
  if(rejection==='SELL'){sell+=22;reasons.push('Pavio superior forte indica rejeição na região de resistência')}

  let direction=buy===sell?majority:buy>sell?'BUY':'SELL';
  let score=Math.max(buy,sell);
  if(aligned>=3)score+=8;
  if(avgBody>=.48)score+=6;
  if(lateral){score=Math.min(score,54);direction=null;reasons.push('Range apertado e pouca direção nas últimas velas')}
  if(doji&&!rejection){score=Math.min(score,48);direction=null;reasons.push('Última vela é um doji extremo sem confirmação')}
  if(tiny>=3&&aligned<4){score=Math.min(score,56);direction=null;reasons.push('Compressão forte: aguardar rompimento')}
  score=clamp(score);

  let projection='Indefinição';
  if(direction&&breakout===direction)projection='Continuação';
  else if(direction&&rejection===direction)projection='Reversão / rejeição';
  else if(direction&&aligned>=3)projection='Continuação';

  let opinion;
  if(!direction)opinion=lateral||tiny>=3?`Range apertado nas últimas ${rows.length} velas. Sem direção clara. Aguardar rompimento.`:`As últimas ${rows.length} velas não formaram uma direção clara. Aguardar.`;
  else if(rejection===direction)opinion=`Rejeição clara ${direction==='BUY'?'na mínima':'na máxima'} com suporte/resistência recente ativo. ${projection} provável se houver confirmação.`;
  else if(breakout===direction)opinion=`Rompimento recente com ${aligned} de ${rows.length} velas alinhadas. ${projection} ganha força enquanto o preço respeitar a zona.`;
  else opinion=`${aligned} de ${rows.length} velas apontam para ${direction==='BUY'?'alta':'baixa'}. Estrutura recente favorece ${projection.toLowerCase()}.`;

  const mid=(support+resistance)/2;
  const trend=direction?{direction,from:rows[0].close,to:last.close,mid}:null;
  return{ready:true,required:3,count:rows.length,direction,score,opinion,support,resistance,trend,breakout,lateral,doji,rejection,aligned,up,down,projection,avgRange,reasons};
}

export function analyzeCandles(candles=[]){
  const rows=(Array.isArray(candles)?candles:[]).filter(c=>[c?.open,c?.high,c?.low,c?.close].every(v=>finite(v)!=null));
  const recent=recentPriceAction(rows);
  if(!recent.ready)return{state:'NO_TRADE',score:0,direction:null,reasons:[recent.opinion],indicators:{},recent};

  const closes=rows.map(c=>Number(c.close));
  const enough9=closes.length>=9,enough14=closes.length>=14,enough21=closes.length>=21;
  const e9=enough9?ema(closes,9):null,e21=enough21?ema(closes,21):null,momentum=enough14?rsi(closes,14):null,m=enough21?macd(closes):null,a=enough14?atr(rows):null,bb=enough21?bollinger(closes):null;
  let score=recent.score,direction=recent.direction;const reasons=[...recent.reasons];

  if(direction&&e9!=null&&e21!=null){
    const aligned=direction==='BUY'?e9>e21:e9<e21;
    score+=aligned?6:-5;
    reasons.push(aligned?'EMAs longas confirmam a direção':'EMAs longas ainda não confirmam a direção');
  }
  if(direction&&momentum!=null){
    const healthy=direction==='BUY'?momentum>=48&&momentum<=72:momentum<=52&&momentum>=28;
    score+=healthy?4:-3;
  }
  if(direction&&m?.histogram!=null){
    const aligned=direction==='BUY'?m.histogram>0:m.histogram<0;
    score+=aligned?4:-3;
  }

  score=clamp(score);
  const state=!direction?'NO_TRADE':score>=75?'WATCH':score>=60?'WAIT':'NO_TRADE';
  return{state,score,direction,reasons,indicators:{ema9:e9,ema21:e21,rsi14:momentum,macd:m,atr14:a,bollinger:bb},recent};
}
