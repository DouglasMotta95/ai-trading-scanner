export const RISK_PROFILES=Object.freeze({
  conservative:{id:'conservative',label:'Conservador',stakePct:1,maxStakePct:2,maxConsecutiveLosses:2,maxSignals:8,minAiScore:82,cooldownMs:90000},
  moderate:{id:'moderate',label:'Moderado',stakePct:2,maxStakePct:3.5,maxConsecutiveLosses:3,maxSignals:12,minAiScore:75,cooldownMs:60000},
  aggressive:{id:'aggressive',label:'Agressivo',stakePct:3,maxStakePct:5,maxConsecutiveLosses:4,maxSignals:18,minAiScore:65,cooldownMs:30000}
});
const n=v=>Number.isFinite(Number(v))?Number(v):0;
const clamp=(v,min,max)=>Math.max(min,Math.min(max,v));

export function riskProfile(id='moderate'){
  return RISK_PROFILES[id]||RISK_PROFILES.moderate;
}

export function bankrollPlan({profile='moderate',bankroll=0,dailyProfit=0,dailyTarget=0,signalsToday=0,consecutiveLosses=0,requestedStake=null}={}){
  const p=riskProfile(profile),bank=Math.max(0,n(bankroll)),target=Math.max(0,n(dailyTarget)),profit=n(dailyProfit);
  const base=bank*p.stakePct/100,maxStake=bank*p.maxStakePct/100;
  const raw=requestedStake==null||!Number.isFinite(Number(requestedStake))?base:Number(requestedStake);
  const suggested=bank>0?clamp(raw,Math.min(base||raw,maxStake||raw),Math.max(base,maxStake)):Math.max(0,raw);
  const warnings=[];const blocks=[];
  if(bank<=0)warnings.push('Informe a banca para calcular uma entrada proporcional');
  if(bank>0&&raw>maxStake)warnings.push(`Proteção de banca aplicada: máximo ${p.maxStakePct}% por entrada`);
  if(bank>0&&raw>=bank*.25)blocks.push('Entrada excessiva em relação à banca');
  if(consecutiveLosses>=p.maxConsecutiveLosses)blocks.push(`Pausa por ${p.maxConsecutiveLosses} perdas consecutivas`);
  if(signalsToday>=p.maxSignals)blocks.push('Limite de operações do perfil atingido');
  if(target>0&&profit>=target)blocks.push('Meta diária de lucro atingida');
  if(signalsToday>=Math.ceil(p.maxSignals*.75))warnings.push('Risco de overtrading: você está perto do limite diário do perfil');
  return{profile:p,bankroll:bank,dailyProfit:profit,dailyTarget:target,suggestedStake:Math.round(suggested*100)/100,maxStake:Math.round(maxStake*100)/100,allowed:blocks.length===0,blocks,warnings,progress:target>0?Math.round(clamp(profit/target*100,0,1000)):0};
}

export function tradingGuard({signalsToday=0,consecutiveLosses=0,maxSignals=20,maxConsecutiveLosses=3,cooldownUntil=0,dailyProfit=0,dailyTarget=0,bankroll=0,requestedStake=null,profile='moderate'}={}){
  const plan=bankrollPlan({profile,bankroll,dailyProfit,dailyTarget,signalsToday,consecutiveLosses,requestedStake});
  const reasons=[...plan.blocks];
  if(signalsToday>=maxSignals&&!reasons.some(x=>x.includes('Limite de operações')))reasons.push('Limite diário de sinais');
  if(consecutiveLosses>=maxConsecutiveLosses&&!reasons.some(x=>x.includes('perdas consecutivas')))reasons.push('Cooldown por sequência de perdas');
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
  rows.push({at:Date.now(),balance:Math.round(value*100)/100,source});return rows;
}
