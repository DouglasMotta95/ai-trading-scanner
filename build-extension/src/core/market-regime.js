const EXTREME_VOLATILITY_MULTIPLIER = 2.5;
const VOLATILITY_LOOKBACK = 20;

export function marketRegime(candles=[]){
  if(candles.length<20)return{type:'unknown',volatility:0,extremeVolatility:false,volatilityRatio:0};
  const recent=candles.slice(-VOLATILITY_LOOKBACK),ranges=recent.map(c=>Math.abs(Number(c.high)-Number(c.low))).filter(Number.isFinite);
  const vol=ranges.reduce((a,b)=>a+b,0)/(ranges.length||1);
  const first=Number(recent[0].close),last=Number(recent.at(-1).close),move=Math.abs(last-first);
  const directional=vol?move/(vol*recent.length):0;
  const current=candles.at(-1);
  const currentRange=Math.abs(Number(current?.high)-Number(current?.low));
  const baseline=ranges.slice(0,-1);
  const averagePriorRange=baseline.reduce((a,b)=>a+b,0)/(baseline.length||1);
  const volatilityRatio=averagePriorRange>0?currentRange/averagePriorRange:0;
  const extremeVolatility=volatilityRatio>=EXTREME_VOLATILITY_MULTIPLIER;
  return{type:extremeVolatility?'range':directional>.35?(last>first?'uptrend':'downtrend'):'range',volatility:vol,extremeVolatility,volatilityRatio,extremeVolatilityMultiplier:EXTREME_VOLATILITY_MULTIPLIER};
}

export function qualityGate({connected,stale,regime,newsBlocked=false,dataQuality=1}={}){const reasons=[];if(!connected)reasons.push('Sem conexão');if(stale)reasons.push('Feed desatualizado');if(newsBlocked)reasons.push('Evento de alto impacto');if(dataQuality<.8)reasons.push('Qualidade de dados insuficiente');if(regime?.type==='unknown')reasons.push('Regime não identificado');return{allowed:reasons.length===0,reasons}}

export { EXTREME_VOLATILITY_MULTIPLIER, VOLATILITY_LOOKBACK };
