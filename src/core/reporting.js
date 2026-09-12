const n=v=>Number.isFinite(Number(v))?Number(v):0;
export function weeklyReport(signalHistory=[],bankHistory=[],now=Date.now()){
  const start=now-7*86400000;
  const signals=(Array.isArray(signalHistory)?signalHistory:[]).filter(x=>Number(x.at||x.entryAt||0)>=start);
  const wins=signals.filter(x=>x.outcome==='win').length,losses=signals.filter(x=>x.outcome==='loss').length,draws=signals.filter(x=>x.outcome==='draw').length,decisive=wins+losses;
  const scores=signals.map(x=>n(x.ai?.score??x.score)).filter(Boolean);
  const byAsset={};for(const s of signals){const a=String(s.asset||'—');byAsset[a]??={signals:0,wins:0,losses:0};byAsset[a].signals++;if(s.outcome==='win')byAsset[a].wins++;if(s.outcome==='loss')byAsset[a].losses++}
  const topAsset=Object.entries(byAsset).sort((a,b)=>b[1].wins-a[1].wins||b[1].signals-a[1].signals)[0]||null;
  const bank=(Array.isArray(bankHistory)?bankHistory:[]).filter(x=>Number(x.at||0)>=start).sort((a,b)=>a.at-b.at),bankChange=bank.length>1?n(bank.at(-1).balance)-n(bank[0].balance):0;
  return{periodDays:7,generatedAt:now,totalSignals:signals.length,wins,losses,draws,winRate:decisive?Math.round(wins/decisive*1000)/10:null,averageScore:scores.length?Math.round(scores.reduce((a,b)=>a+b,0)/scores.length*10)/10:null,topAsset:topAsset?{asset:topAsset[0],...topAsset[1]}:null,bankChange:Math.round(bankChange*100)/100,message:signals.length?`Na última semana foram ${signals.length} sinais registrados${decisive?`, com ${Math.round(wins/decisive*1000)/10}% de acerto entre resultados conhecidos`:''}.`:'Ainda não há sinais suficientes nesta semana para gerar estatísticas.'};
}
