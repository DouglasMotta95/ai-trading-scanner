const n=v=>Number.isFinite(Number(v))?Number(v):null;
const clamp=(v,min=-1,max=1)=>Math.max(min,Math.min(max,Number(v)||0));

export function closeReturns(candles=[],limit=60){
  const closes=(Array.isArray(candles)?candles:[]).map(c=>n(c?.close)).filter(v=>v!=null).slice(-(limit+1));
  const out=[];for(let i=1;i<closes.length;i++){const prev=closes[i-1],cur=closes[i];if(prev!==0)out.push((cur-prev)/Math.abs(prev))}
  return out;
}

export function pearson(a=[],b=[]){
  const len=Math.min(a.length,b.length);if(len<8)return null;
  const x=a.slice(-len),y=b.slice(-len),mx=x.reduce((s,v)=>s+v,0)/len,my=y.reduce((s,v)=>s+v,0)/len;
  let num=0,dx=0,dy=0;for(let i=0;i<len;i++){const vx=x[i]-mx,vy=y[i]-my;num+=vx*vy;dx+=vx*vx;dy+=vy*vy}
  const den=Math.sqrt(dx*dy);return den?clamp(num/den):null;
}

export function correlationMatrix(historyByAsset={},limit=60){
  const assets=Object.keys(historyByAsset||{}).filter(k=>Array.isArray(historyByAsset[k])&&historyByAsset[k].length>=9);
  const returns=Object.fromEntries(assets.map(a=>[a,closeReturns(historyByAsset[a],limit)]));
  const matrix={};for(const a of assets){matrix[a]={};for(const b of assets){matrix[a][b]=a===b?1:pearson(returns[a],returns[b])}}
  return matrix;
}

const currencies=asset=>String(asset||'').replace(/\s*\(OTC\)$/i,'').split('/').filter(Boolean);
export function strongestCorrelation(asset,matrix={},direction=null,peerDirections={}){
  const row=matrix?.[asset]||{};let best=null;
  for(const [peer,value] of Object.entries(row)){if(peer===asset||value==null)continue;const abs=Math.abs(value);if(!best||abs>best.abs)best={peer,value,abs}}
  if(!best)return{available:false,score:70,reason:'Sem histórico multiativo suficiente para correlação'};
  const shared=currencies(asset).some(c=>currencies(best.peer).includes(c));
  const peerDirection=peerDirections?.[best.peer]||null;
  let alignment='neutral',score=78;
  if(direction&&peerDirection){
    const same=direction===peerDirection;
    const supports=best.value>=0?same:!same;
    alignment=supports?'supportive':'conflicting';
    score=supports?Math.min(100,72+best.abs*28):Math.max(10,68-best.abs*58);
  }else if(best.abs>.9)score=shared?58:64;
  return{available:true,...best,sharedCurrency:shared,peerDirection,alignment,score:Math.round(score),reason:alignment==='supportive'?`Correlação com ${best.peer} confirma o movimento`:alignment==='conflicting'?`Correlação com ${best.peer} entra em conflito com o sinal`:`Correlação mais forte: ${best.peer} (${best.value.toFixed(2)})`};
}
