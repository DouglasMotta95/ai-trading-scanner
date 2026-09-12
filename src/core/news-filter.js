const currenciesOf=asset=>(String(asset||'').toUpperCase().replace(/\s*\(OTC\)$/,'').match(/[A-Z]{3}/g)||[]);
const impactRank=v=>({low:1,medium:2,high:3}[String(v||'').toLowerCase()]||0);
export function newsRisk(events=[],asset='',now=Date.now(),windowMinutes=15){
  const currencies=currenciesOf(asset),windowMs=Math.max(1,Number(windowMinutes)||15)*60000;
  const relevant=(Array.isArray(events)?events:[]).map(e=>({...e,timestamp:Number(e.timestamp||e.at||0),currency:String(e.currency||'').toUpperCase(),impact:String(e.impact||'').toLowerCase()})).filter(e=>e.timestamp&&currencies.includes(e.currency)).sort((a,b)=>Math.abs(a.timestamp-now)-Math.abs(b.timestamp-now));
  const blocked=relevant.filter(e=>impactRank(e.impact)>=3&&Math.abs(e.timestamp-now)<=windowMs);
  const nearest=relevant[0]||null,minutesToNearest=nearest?Math.round(Math.abs(nearest.timestamp-now)/6000)/10:null;
  const caution=relevant.filter(e=>impactRank(e.impact)>=2&&Math.abs(e.timestamp-now)<=windowMs*2);
  return{blocked:blocked.length>0,events:blocked,caution,nearest,minutesToNearest,reason:blocked.length?'Notícia de alto impacto próxima':caution.length?'Evento econômico relevante se aproximando':null};
}
