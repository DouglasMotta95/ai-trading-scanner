import { processSnapshot as analyzeSnapshot, resetOrchestrator as resetLegacyAnalyzer } from './core/orchestrator-legacy.js';
import { ANALYST_THRESHOLDS } from './core/analysis.js';
import { updateScannerState } from './services/scanner-state-atomic.js';
import { normalizeAsset, sameAsset, normalizeTimeframe, normalizeTimestamp, normalizeCandles, num, clean } from './core/market-normalizers.js';
import { resetMarketSession } from './core/market-session-state.js';
import { sniperWindows } from './core/sniper-cycle.js';

const EXACT_CLOCK_SOURCES = new Set(['casatrade-platform-clock','network-server-cycle','trader-dom-countdown']);
const cycles = new Map();
const CONFIRM_HITS = 2;
const HIT_GAP_MS = 6500;

const casaHost = value => value === 'casatrade.com' || value.endsWith('.casatrade.com') || value === 'casatrade.io' || value.endsWith('.casatrade.io');
const traderHost = value => value === 'casatraders.online' || value.endsWith('.casatraders.online') || value === 'ivcasatraders.online' || value.endsWith('.ivcasatraders.online');
function senderInfo(sender = {}) {
  let frameHost='',topHost='';
  try{frameHost=new URL(sender.url||'').hostname.toLowerCase()}catch{}
  try{topHost=new URL(sender.tab?.url||'').hostname.toLowerCase()}catch{}
  return { tabId:Number(sender.tab?.id||0), frameId:Number(sender.frameId||0), frameHost, trusted:!!sender.tab?.id&&casaHost(topHost)&&(casaHost(frameHost)||traderHost(frameHost)) };
}
function accessActive(state={}) {
  const status=String(state?.license?.status||'').toLowerCase();
  return ['active','valid'].includes(status)||state?.license?.devMode===true||state?.license?.plan==='OWNER_DEV'||state?.diagnostics?.access?.ownerDev===true;
}
function candidates(payload={}) {
  return (Array.isArray(payload.candidates)?payload.candidates:[]).map(row=>{
    const asset=normalizeAsset(row?.asset),bid=num(row?.bid),ask=num(row?.ask);
    const price=num(row?.price)??(bid!=null&&ask!=null?(bid+ask)/2:null);
    return {...row,asset,price};
  }).filter(row=>row.asset&&row.price!=null&&row.price>0);
}
function bestCandidate(payload,asset) {
  return candidates(payload).filter(row=>sameAsset(row.asset,asset)).sort((a,b)=>Number(b.selected===true)-Number(a.selected===true)||Number(b.confidence||0)-Number(a.confidence||0)||Number(b.observedAt||0)-Number(a.observedAt||0))[0]||null;
}
function rowsFor(payload,asset) {
  const source=payload?.recentCandles&&typeof payload.recentCandles==='object'?payload.recentCandles:{};
  const key=Object.keys(source).find(k=>sameAsset(k,asset));
  return key?normalizeCandles(source[key],240):[];
}
function directionOf(signal={}) {
  const d=String(signal.analysisDirection||signal.direction||'').toUpperCase();
  return ['BUY','SELL'].includes(d)?d:null;
}
function finalQuality(signal={},direction=null) {
  if(!direction) return {ok:false,setup:null};
  const score=Number(signal.analysisScore??signal.score??0); if(score<ANALYST_THRESHOLDS.confirmScore)return{ok:false,setup:null};
  const a=signal.analytics||{},power=Number(direction==='BUY'?a.buyPower:a.sellPower)||0;
  const rejection=(String(a.rejectionDirection||'').toUpperCase()===direction||Number(direction==='BUY'?a.rejectionBuy:a.rejectionSell)>=ANALYST_THRESHOLDS.rejectionStrength)&&Number(a.rejectionStrength||0)>=ANALYST_THRESHOLDS.rejectionStrength;
  const continuation=String(a.continuationDirection||'').toUpperCase()===direction&&Number(a.continuationScore||0)>=55;
  const momentum=String(a.momentumDirection||'').toUpperCase()===direction&&Number(a.momentumScore||0)>=40;
  const strong=Number(a.currentStrength||0)>=ANALYST_THRESHOLDS.candleStrength;
  const setups=[{name:'rejeição',ok:power>=48&&rejection},{name:'continuação',ok:power>=50&&continuation},{name:'momentum',ok:power>=50&&strong&&momentum},{name:'confluência',ok:power>=48&&score>=68&&momentum&&(strong||continuation)}];
  const found=setups.find(x=>x.ok); return {ok:!!found,setup:found?.name||null};
}
function cycleFor(state,clock) {
  const asset=normalizeAsset(state.asset),tf=normalizeTimeframe(clock.timeframe||state.analysisTimeframe||state.timeframe)||'M1';
  const closeAt=normalizeTimestamp(clock.closeAt)??Math.round((Date.now()+Number(clock.secondsRemaining||0)*1000)/1000)*1000;
  const key=`${asset}|${tf}|${closeAt}`;
  let cycle=cycles.get(key);
  if(!cycle){cycle={key,targetStart:closeAt,locked:null,direction:null,candidateDirection:null,confirmHits:0,lastHitAt:null,score:0,setup:null,reason:null,decidedAt:null};cycles.set(key,cycle)}
  return cycle;
}
function observe(cycle,direction,quality,at) {
  if(!quality.ok||!direction){cycle.candidateDirection=null;cycle.confirmHits=0;cycle.lastHitAt=null;return}
  const same=cycle.candidateDirection===direction&&cycle.lastHitAt!=null&&at-Number(cycle.lastHitAt)<=HIT_GAP_MS;
  cycle.candidateDirection=direction;cycle.confirmHits=same?Number(cycle.confirmHits||0)+1:1;cycle.lastHitAt=at;if(quality.setup)cycle.setup=quality.setup;
}
function publicSignal(base={},cycle,seconds) {
  const score=Number(base.analysisScore??base.score??0),direction=directionOf(base),tf=normalizeTimeframe(base.timeframe)||'M1',w=sniperWindows(tf);
  if(cycle.locked==='ENTER') return {...base,state:'CONFIRM',uiState:cycle.direction==='BUY'?'ENTER_BUY':'ENTER_SELL',direction:cycle.direction,analysisDirection:cycle.direction,provisional:false,phase:'FINAL',score:Math.max(score,cycle.score||0),analysisScore:Math.max(score,cycle.score||0),setup:cycle.setup||base.setup||null,targetStart:cycle.targetStart,reason:cycle.reason,hint:cycle.reason};
  if(cycle.locked==='SKIP') return {...base,state:'NO_TRADE',uiState:'SKIP',direction:null,provisional:false,phase:'FINAL',targetStart:cycle.targetStart,reason:cycle.reason,hint:cycle.reason};
  if(seconds>w.prepareAt) return {...base,state:'WAIT',uiState:'BUILDING_PATTERN',direction:null,provisional:true,phase:'OBSERVE',targetStart:cycle.targetStart,reason:'ANALISANDO — lendo as últimas velas e a vela atual.'};
  if(seconds>w.executeAt){
    if(direction&&score>=ANALYST_THRESHOLDS.possibleScore) return {...base,state:'WATCH',uiState:direction==='BUY'?'POSSIBLE_BUY':'POSSIBLE_SELL',direction,provisional:true,phase:'PREPARE',targetStart:cycle.targetStart,reason:`POSSÍVEL ${direction==='BUY'?'COMPRA':'VENDA'} NA PRÓXIMA VELA • ${Math.ceil(seconds)}s`};
    return {...base,state:'WAIT',uiState:'BUILDING_PATTERN',direction:null,provisional:true,phase:'PREPARE',targetStart:cycle.targetStart,reason:`ANALISANDO • ${Math.ceil(seconds)}s para decisão final.`};
  }
  return {...base,state:'WAIT',uiState:'SKIP',direction:null,provisional:false,phase:'FINAL',targetStart:cycle.targetStart,reason:'PULAR PRÓXIMA VELA — decisão final sem confirmação suficiente.'};
}
function analyzeState(state,clock) {
  if(!state.asset||num(state.price)==null||!Array.isArray(state.candles)||state.candles.length<2)return state;
  const tf=normalizeTimeframe(clock.timeframe||state.analysisTimeframe||state.timeframe)||'M1';
  const seconds=Math.max(0,Number(clock.secondsRemaining||0));
  const snapshot={platformId:'casatrade',platformName:'CasaTrade',connection:'online',asset:state.asset,price:Number(state.price),timeframe:tf,analysisTimeframe:tf,expiration:state.targetExpiration||state.expiration||null,secondsRemaining:seconds,serverTime:Date.now(),candles:state.candles,capabilities:{structuredQuotes:true,candles:true},diagnostics:{capture:'numeric-ohlc-sniper',clockQuality:'exact'}};
  const analyzed=analyzeSnapshot(snapshot,state)||{}; const base=analyzed.signal||{}; const cycle=cycleFor(state,clock); const at=Date.now(); const direction=directionOf(base); const quality=finalQuality(base,direction); const w=sniperWindows(tf);
  if(!cycle.locked&&seconds<=w.prepareAt&&seconds>w.executeAt) observe(cycle,direction,quality,at);
  if(!cycle.locked&&seconds<=w.executeAt){
    const stable=quality.ok&&direction&&cycle.candidateDirection===direction&&Number(cycle.confirmHits||0)>=CONFIRM_HITS;
    if(stable){cycle.locked='ENTER';cycle.direction=direction;cycle.score=Number(base.analysisScore??base.score??0);cycle.setup=quality.setup||base.setup||null;cycle.reason=`ENTRAR NA PRÓXIMA VELA: ${direction==='BUY'?'COMPRA':'VENDA'} — decisão travada aos ${Math.ceil(seconds)}s.`;cycle.decidedAt=at}
    else{cycle.locked='SKIP';cycle.reason=`PULAR PRÓXIMA VELA — ${clean(base.waitingFor?.text||base.reason||'padrão não confirmou')}`;cycle.decidedAt=at}
    cycles.set(cycle.key,cycle);
  }
  const signal=publicSignal(base,cycle,seconds);
  return {...state,...analyzed,asset:state.asset,price:state.price,timeframe:tf,analysisTimeframe:tf,candles:state.candles,marketHistory:state.marketHistory||{},connection:'online',lastSeen:state.lastSeen,signal,decisionCycle:{...cycle},lastConfirmed:cycle.locked==='ENTER'?{state:'CONFIRM',direction:cycle.direction,score:cycle.score,targetStart:cycle.targetStart,setup:cycle.setup,asset:state.asset,timeframe:tf}:state.lastConfirmed,diagnostics:{...(state.diagnostics||{}),...(analyzed.diagnostics||{}),marketClock:clock,focusedAsset:state.diagnostics?.focusedAsset||null,marketSession:state.diagnostics?.marketSession||null,acquisition:{stage:'sniper_live',reason:`OHLC numérico + clock exato • fase ${signal.phase||'ANALYSIS'}`,at:Date.now()}}};
}
async function onFocus(message,sender) {
  const info=senderInfo(sender);if(!info.trusted||message.reliable!==true||message.chartScoped!==true)return null;const asset=normalizeAsset(message.asset);if(!asset)return null;
  return updateScannerState(state=>{if(!accessActive(state))return;if(state.targetTabId&&Number(state.targetTabId)!==info.tabId)return;const old=state.diagnostics?.focusedAsset||{};const changed=!sameAsset(old.asset,asset)||Number(old.frameId)!==info.frameId||String(old.frameHost||'').toLowerCase()!==info.frameHost;let next=state;if(changed||!sameAsset(state.asset,asset)){cycles.clear();resetLegacyAnalyzer();next=resetMarketSession(state,{asset,frameId:info.frameId,frameHost:info.frameHost,source:message.source||'asset-observer',reason:`Ativo ${asset} selecionado. Cache anterior limpo.`})}return{...next,targetTabId:info.tabId,platformId:'casatrade',platformName:'CasaTrade',scanner:'scanning',diagnostics:{...(next.diagnostics||{}),focusedAsset:{asset,at:Date.now(),stableSince:changed?Date.now():Number(old.stableSince||old.at||Date.now()),reliable:true,chartScoped:true,trustedChartFrame:true,visual:true,explicit:message.explicit===true,frameId:info.frameId,frameHost:info.frameHost,embeddedTrader:traderHost(info.frameHost),casaTradeFrame:casaHost(info.frameHost),source:message.source||'asset-observer'}}};});
}
async function onFeed(payload,sender) {
  const info=senderInfo(sender);if(!info.trusted)return null;return updateScannerState(state=>{if(!accessActive(state))return;if(state.targetTabId&&Number(state.targetTabId)!==info.tabId)return;const focus=state.diagnostics?.focusedAsset;if(!focus?.asset||Number(focus.frameId)!==info.frameId||String(focus.frameHost||'').toLowerCase()!==info.frameHost)return;const asset=normalizeAsset(focus.asset),candidate=bestCandidate(payload,asset);if(!candidate)return;const incoming=rowsFor(payload,asset),old=normalizeCandles(state.candles||[],240),candles=normalizeCandles([...old,...incoming],240),price=Number(candidate.price),tf=normalizeTimeframe(candidate.timeframe||state.analysisTimeframe||state.timeframe)||state.analysisTimeframe||state.timeframe||'M1';const next={...state,asset,price,timeframe:tf,analysisTimeframe:tf,candles,marketHistory:{[asset]:candles},serverTime:Date.now(),lastSeen:Date.now(),connection:'online',targetTabId:info.tabId,platformId:'casatrade',platformName:'CasaTrade',scanner:'scanning',diagnostics:{...(state.diagnostics||{}),marketSession:{...(state.diagnostics?.marketSession||{}),asset,timeframe:tf,frameId:info.frameId,frameHost:info.frameHost,dataMode:'live',lastLiveAt:Date.now(),historyCount:candles.length},acquisition:{stage:state.diagnostics?.marketClock?.verified?'sniper_live':'syncing_clock',reason:state.diagnostics?.marketClock?.verified?'OHLC numérico pronto. Analisando próxima vela.':'OHLC numérico pronto. Sincronizando relógio exato.',at:Date.now()}}};const clock=state.diagnostics?.marketClock;return clock?.verified===true?analyzeState(next,clock):{...next,signal:null};});
}
async function onClock(message,sender) {
  const info=senderInfo(sender);if(!info.trusted||message.verified!==true||message.available===false||message.clockRole!=='candle-close'||!EXACT_CLOCK_SOURCES.has(String(message.clockSource||'')))return null;const asset=normalizeAsset(message.asset),tf=normalizeTimeframe(message.timeframe),seconds=num(message.secondsRemaining),closeAt=normalizeTimestamp(message.closeAt);if(!asset||!tf||seconds==null||seconds<0)return null;
  return updateScannerState(state=>{if(!accessActive(state))return;const focus=state.diagnostics?.focusedAsset;if(!focus?.asset||!sameAsset(focus.asset,asset)||Number(focus.frameId)!==info.frameId||String(focus.frameHost||'').toLowerCase()!==info.frameHost)return;const clock={asset,timeframe:tf,secondsRemaining:seconds,millisecondsRemaining:num(message.millisecondsRemaining),closeAt,available:true,verified:true,operational:true,quality:'exact',role:'candle-close',source:String(message.clockSource),mode:String(message.clockMode||''),confidence:Number(message.confidence||0),frameId:info.frameId,frameHost:info.frameHost,at:Date.now()};const next={...state,timeframe:tf,analysisTimeframe:tf,expiration:message.expiration||state.expiration||null,targetExpiration:message.expiration||state.targetExpiration||null,diagnostics:{...(state.diagnostics||{}),marketClock:clock,marketSession:{...(state.diagnostics?.marketSession||{}),asset,timeframe:tf,frameId:info.frameId,frameHost:info.frameHost,dataMode:'live'}}};return analyzeState(next,clock);});
}
chrome.runtime.onMessage.addListener((message,sender,sendResponse)=>{let task=null;if(message?.type==='ATS_VISUAL_FOCUS_V2')task=onFocus(message,sender);else if(message?.type==='ATS_EMBEDDED_FEED')task=onFeed(message.payload||{},sender);else if(message?.type==='ATS_MARKET_CLOCK_V2')task=onClock(message,sender);if(!task)return false;Promise.resolve(task).then(state=>sendResponse({ok:true,state})).catch(error=>sendResponse({ok:false,error:String(error?.message||error)}));return true;});
