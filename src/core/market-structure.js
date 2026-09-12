const finite=v=>Number.isFinite(Number(v))?Number(v):null;
const clamp=(v,min=0,max=100)=>Math.max(min,Math.min(max,Number(v)||0));

export function marketStructure(candles=[]){
  const rows=Array.isArray(candles)?candles.filter(c=>[c?.open,c?.high,c?.low,c?.close].every(x=>finite(x)!=null)).slice(-80):[];
  if(rows.length<5)return{ready:false,support:null,resistance:null,trend:'unknown',slope:0,priceActionScore:0,breakout:null,bodyStrength:0};
  const recent=rows.slice(-20),last=recent.at(-1),price=finite(last.close);
  const highs=recent.map(c=>finite(c.high)),lows=recent.map(c=>finite(c.low)),closes=recent.map(c=>finite(c.close));
  const sortedHigh=[...highs].sort((a,b)=>a-b),sortedLow=[...lows].sort((a,b)=>a-b);
  const resistance=sortedHigh[Math.max(0,Math.floor(sortedHigh.length*.8))];
  const support=sortedLow[Math.min(sortedLow.length-1,Math.floor(sortedLow.length*.2))];
  const n=closes.length,meanX=(n-1)/2,meanY=closes.reduce((a,b)=>a+b,0)/n;
  let num=0,den=0;for(let i=0;i<n;i++){const dx=i-meanX;num+=dx*(closes[i]-meanY);den+=dx*dx}
  const slope=den?num/den:0;
  const avg=Math.abs(meanY)||1,slopePct=slope/avg*100;
  const trend=slopePct>.008?'up':slopePct<-.008?'down':'sideways';
  const bodies=recent.slice(-5).map(c=>{const o=finite(c.open),cl=finite(c.close),h=finite(c.high),l=finite(c.low),range=Math.max(1e-12,h-l);return Math.abs(cl-o)/range});
  const bodyStrength=bodies.reduce((a,b)=>a+b,0)/Math.max(1,bodies.length);
  const last5=recent.slice(-5);let up=0,down=0;for(const c of last5){if(c.close>c.open)up++;else if(c.close<c.open)down++}
  const directional=Math.abs(up-down)/Math.max(1,last5.length);
  const nearSupport=price!=null&&support!=null?Math.abs(price-support)/Math.max(Math.abs(price),1):1;
  const nearResistance=price!=null&&resistance!=null?Math.abs(resistance-price)/Math.max(Math.abs(price),1):1;
  const breakout=price!=null&&resistance!=null&&price>resistance?'up':price!=null&&support!=null&&price<support?'down':null;
  let score=35+directional*30+Math.min(20,Math.abs(slopePct)*500)+bodyStrength*15;
  if(breakout)score+=10;
  if(Math.min(nearSupport,nearResistance)<.0005)score+=5;
  return{ready:true,support,resistance,trend,slope,slopePct,priceActionScore:clamp(score),breakout,bodyStrength:Math.round(bodyStrength*100),recent:{up,down,count:last5.length},price};
}

export function structureDirectionScore(structure={},direction){
  if(!structure?.ready||!direction)return 50;
  let score=Number(structure.priceActionScore)||50;
  if(direction==='BUY'&&structure.trend==='up')score+=10;
  if(direction==='SELL'&&structure.trend==='down')score+=10;
  if(direction==='BUY'&&structure.breakout==='up')score+=8;
  if(direction==='SELL'&&structure.breakout==='down')score+=8;
  if(direction==='BUY'&&structure.trend==='down')score-=18;
  if(direction==='SELL'&&structure.trend==='up')score-=18;
  return clamp(score);
}
