export const RISK_PROFILES=Object.freeze({
  conservative:{id:'conservative',label:'Conservador',riskMinPct:.5,riskMaxPct:1,stakePct:.5,dailyTargetPct:3,dailyStopPct:2,maxConsecutiveLosses:2,maxSignals:8,minAiScore:82,cooldownMs:90000},
  moderate:{id:'moderate',label:'Moderado',riskMinPct:1,riskMaxPct:2,stakePct:1,dailyTargetPct:5,dailyStopPct:3,maxConsecutiveLosses:3,maxSignals:12,minAiScore:75,cooldownMs:60000},
  aggressive:{id:'aggressive',label:'Agressivo',riskMinPct:2,riskMaxPct:3,stakePct:2,dailyTargetPct:8,dailyStopPct:5,maxConsecutiveLosses:4,maxSignals:18,minAiScore:65,cooldownMs:30000}
});
const n=v=>Number.isFinite(Number(v))?Number(v):0;
const clamp=(v,min,max)=>Math.max(min,Math.min(max,v));
const round=v=>Math.round(Number(v||0)*100)/100;

export function riskProfile(id='moderate'){
  return RISK_PROFILES[id]||RISK_PROFILES.moderate;
}

export function bankrollPlan({profile='moderate',bankroll=0,dailyPnl=null,dailyProfit=0,dailyTarget=0,dailyStop=0,signalsToday=0,consecutiveLosses=0,requestedStake=null,pausedByRisk=false}={}){
  const p=riskProfile(profile),bank=Math.max(0,n(bankroll)),pnl=Number.isFinite(Number(dailyPnl))?Number(dailyPnl):n(dailyProfit);
  const minStake=bank*p.riskMinPct/100,maxStake=bank*p.riskMaxPct/100;
  const target=Math.max(0,n(dailyTarget))||bank*p.dailyTargetPct/100;
  const stop=Math.max(0,n(dailyStop))||bank*p.dailyStopPct/100;
  const requested=requestedStake==null||!Number.isFinite(Number(requestedStake))?null:Number(requestedStake);
  const suggested=bank>0?(requested==null?minStake:clamp(requested,minStake,maxStake)):Math.max(0,requested||0);
  const warnings=[];const blocks=[];
  let status='within_risk';
  if(bank<=0)warnings.push('Informe a banca para calcular automaticamente o valor da entrada');
  if(bank>0&&requested!=null&&requested>maxStake)warnings.push(`Valor reduzido ao limite de ${p.riskMaxPct}% da banca`);
  if(bank>0&&requested!=null&&requested>=bank*.25)blocks.push('Proteção contra apostar tudo: valor excessivo em relação à banca');
  if(consecutiveLosses>=p.maxConsecutiveLosses||pausedByRisk){status='loss_pause';blocks.push(`Pausado por ${p.maxConsecutiveLosses} perdas consecutivas. Reative manualmente quando decidir continuar`)}
  else if(stop>0&&pnl<=-stop){status='daily_stop';blocks.push(`Stop diário atingido (${p.dailyStopPct}% da banca)`)}
  else if(target>0&&pnl>=target){status='target_reached';blocks.push(`Meta diária atingida (${p.dailyTargetPct}% da banca). Pausa recomendada`)}
  if(signalsToday>=p.maxSignals){status=status==='within_risk'?'overtrading_limit':status;blocks.push('Limite de operações do perfil atingido')}
  if(signalsToday>=Math.ceil(p.maxSignals*.75)&&signalsToday<p.maxSignals)warnings.push('Risco de overtrading: você está perto do limite diário do perfil');
  return{profile:p,bankroll:bank,dailyPnl:round(pnl),dailyTarget:round(target),dailyStop:round(stop),suggestedStake:round(suggested),minStake:round(minStake),maxStake:round(maxStake),allowed:blocks.length===0,blocks,warnings,status,progress:target>0?Math.round(clamp(pnl/target*100,0,1000)):0};
}

export function tradingGuard({signalsToday=0,consecutiveLosses=0,maxSignals=null,maxConsecutiveLosses=null,cooldownUntil=0,dailyPnl=null,dailyProfit=0,dailyTarget=0,dailyStop=0,bankroll=0,requestedStake=null,profile='moderate',pausedByRisk=false}={}){
  const p=riskProfile(profile);
  const plan=bankrollPlan({profile,bankroll,dailyPnl,dailyProfit,dailyTarget,dailyStop,signalsToday,consecutiveLosses,requestedStake,pausedByRisk});
  const reasons=[...plan.blocks],signalLimit=maxSignals==null?p.maxSignals:Number(maxSignals),lossLimit=maxConsecutiveLosses==null?p.maxConsecutiveLosses:Number(maxConsecutiveLosses);
  if(signalsToday>=signalLimit&&!reasons.some(x=>x.includes('Limite de operações')))reasons.push('Limite diário de sinais');
  if(consecutiveLosses>=lossLimit&&!reasons.some(x=>x.includes('perdas consecutivas')))reasons.push('Pausa por sequência de perdas');
  if(Date.now()<cooldownUntil)reasons.push('Cooldown ativo');
  return{allowed:reasons.length===0,reasons,warnings:plan.warnings,bankroll:plan};
}

export function dedupeSignal(last,candidate,cooldownMs=60000){
  if(!last)return false;
  return last.asset===candidate.asset&&last.direction===candidate.direction&&Date.now()-last.createdAt<cooldownMs;
}

export function appendBankSnapshot(history=[],balance,source='manual'){
  const value=Number(balance);if(!Number.isFinite(value)||value<0)return Array.isArray(history)?history:[];
  const rows=Array.isArray(history)?history.slice(-199):[];
  const last=rows.at(-1);if(last&&Number(last.balance)===value)return rows;
  rows.push({at:Date.now(),balance:round(value),source});return rows;
}
