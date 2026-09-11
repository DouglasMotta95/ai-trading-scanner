import { processSnapshot, resetOrchestrator } from './core/orchestrator.js';
import { detectPlatform } from './platforms/registry.js';
import { activateLicense, validateLicense, consumeSignal, clearLicense, licenseRequired } from './services/license.js';
import { heartbeat, track } from './services/telemetry.js';

const DEFAULT_LICENSE={status:'unconfigured',plan:null,planLabel:null,dailyLimit:null,usedToday:0,remainingToday:null,totalLimit:null,usedTotal:0,remainingTotal:null,error:null};
const DEFAULT_STATE={
  connection:'offline',scanner:'idle',platformId:null,platformName:null,targetTabId:null,asset:null,marketType:'unknown',instrumentType:'unknown',
  timeframe:null,analysisTimeframe:null,expiration:null,targetExpiration:null,price:null,serverTime:null,
  capabilities:{structuredQuotes:false,candles:false,expiration:false,multiAsset:false},diagnostics:{},marketCatalog:{assets:[],timeframes:[],expirations:[],lines:[]},
  tradeIntent:null,license:DEFAULT_LICENSE,signal:null,signalHistory:[],telemetry:{feedQuality:0,latency:null,lastSync:null},lastSeen:null
};
let lastLicenseCheck=0,lastHeartbeatAt=0;

const merge=(state={},snapshot={})=>({...DEFAULT_STATE,...state,...snapshot,
  license:{...DEFAULT_LICENSE,...(state.license||{}),...(snapshot.license||{})},
  capabilities:{...DEFAULT_STATE.capabilities,...state.capabilities,...snapshot.capabilities},
  diagnostics:{...(state.diagnostics||{}),...(snapshot.diagnostics||{})},
  telemetry:{...DEFAULT_STATE.telemetry,...(state.telemetry||{}),...(snapshot.telemetry||{})},
  signalHistory:Array.isArray(snapshot.signalHistory)?snapshot.signalHistory:Array.isArray(state.signalHistory)?state.signalHistory:[]
});
const riskFrom=(s={},l={})=>({...s?.risk,signalsToday:l.usedToday??s?.risk?.signalsToday??0,maxSignals:l.dailyLimit??s?.risk?.maxSignals??s?.maxSignals??20,maxConsecutiveLosses:s?.risk?.maxConsecutiveLosses??s?.maxConsecutiveLosses,cooldownMs:s?.risk?.cooldownMs??s?.cooldownMs});
const platformFromUrl=u=>{try{return detectPlatform(new URL(u).hostname)}catch{return null}};
const clean=v=>String(v??'').trim(),uniq=a=>[...new Set(a.filter(Boolean))],num=v=>v==null||v===''?null:Number.isFinite(Number(v))?Number(v):null;
const sameTarget=(s,sender)=>!s?.targetTabId||!sender?.tab?.id||s.targetTabId===sender.tab.id;

function catalogFrom(candidates=[],prefs={}){
  const lines=[],seen=new Set();
  for(const c of candidates){
    const asset=clean(c?.asset);if(!asset)continue;
    const key=`${asset}|${clean(c.timeframe)}|${clean(c.expiration)}`;
    if(seen.has(key)){
      const i=lines.findIndex(x=>`${x.asset}|${clean(x.timeframe)}|${clean(x.expiration)}`===key),old=lines[i];
      if(old){if(old.price==null)old.price=num(c.price);if(old.bid==null)old.bid=num(c.bid);if(old.ask==null)old.ask=num(c.ask);if(old.payout==null)old.payout=num(c.payout);if(old.source==='dom'&&c.source)old.source=c.source}
      continue
    }
    seen.add(key);lines.push({asset,price:num(c.price),bid:num(c.bid),ask:num(c.ask),payout:num(c.payout),timeframe:clean(c.timeframe)||null,expiration:clean(c.expiration)||null,source:clean(c.source)||'observed'})
  }
  const timeframes=uniq(lines.map(x=>x.timeframe)),expirations=uniq(lines.map(x=>x.expiration));
  if(prefs.timeframe&&prefs.timeframe!=='AUTO'&&!timeframes.includes(prefs.timeframe))timeframes.unshift(prefs.timeframe);
  if(prefs.expiration&&prefs.expiration!=='AUTO'&&!expirations.includes(prefs.expiration))expirations.unshift(prefs.expiration);
  return{assets:uniq(lines.map(x=>x.asset)).sort(),timeframes,expirations,lines:lines.slice(0,100)}
}
function licenseError(r){
  const error=r?.error||'license_required';
  const status=error==='license_expired'?'expired':error==='daily_limit_reached'||error==='trial_limit_reached'?'limit':error==='device_locked'||error==='device_limit_reached'?'device_locked':'inactive';
  return{status,error}
}
async function syncLicense(settings={},state={},force=false){
  if(!force&&state.license?.status==='active'&&Date.now()-lastLicenseCheck<30000)return state.license;
  const r=await validateLicense(settings);lastLicenseCheck=Date.now();
  return r.ok?{...r.license,error:null}:{...DEFAULT_LICENSE,...licenseError(r),...(r.license||{})}
}
function feedQuality(state={}){
  if(state.connection!=='online'||!state.price)return 0;
  if(state.capabilities?.structuredQuotes)return 100;
  const net=state.diagnostics?.network||{},dom=state.diagnostics?.domCatalog||{};
  const ws=Number(net.connections?.ws)||0,assets=state.marketCatalog?.assets?.length||Number(net.candidateCount)||Number(dom.assetCount)||0;
  if(ws&&assets)return 72;if(assets)return 58;if(state.price)return 42;return 20
}
function latencyOf(state={}){
  const t=Number(state.serverTime);if(!Number.isFinite(t)||t<1e12)return null;
  const d=Math.abs(Date.now()-t);return d<600000?d:null
}
function durationMs(expiration,timeframe){
  const raw=String(expiration||timeframe||'').trim().toLowerCase().replace(/\s+/g,'');
  let m=raw.match(/^(\d+)s$/);if(m)return Number(m[1])*1000;
  m=raw.match(/^(\d+)m(?:in)?$/);if(m)return Number(m[1])*60000;
  m=raw.match(/^s(\d+)$/);if(m)return Number(m[1])*1000;
  m=raw.match(/^m(\d+)$/);if(m)return Number(m[1])*60000;
  m=raw.match(/^h(\d+)$/);if(m)return Number(m[1])*3600000;
  return 60000
}
async function telemetryHeartbeat(state,settings,force=false){
  if(!force&&Date.now()-lastHeartbeatAt<5000)return;
  lastHeartbeatAt=Date.now();
  await heartbeat(state,settings).catch(()=>{})
}
async function telemetryEvent(type,data,settings){await track(type,data,settings).catch(()=>{})}
function telemetryState(state){return merge(state,{telemetry:{feedQuality:feedQuality(state),latency:latencyOf(state),lastSync:Date.now()}})}
function localSignalRecord(state){
  const s=state.signal||{},expiration=state.targetExpiration||s.targetExpiration||state.expiration||null,timeframe=state.analysisTimeframe||s.timeframe||state.timeframe||null;
  return{id:crypto.randomUUID(),at:Date.now(),asset:state.asset||'—',platform:state.platformName||state.platformId||'—',direction:s.direction,score:s.score,grade:s.grade,timeframe,expiration,entryPrice:num(state.price),regime:s.regime||null,confirmations:s.confirmations||null,status:'pending'}
}

async function connectActiveTab(){
  const[tab]=await chrome.tabs.query({active:true,currentWindow:true});
  if(!tab?.id||!tab.url)return{ok:false,error:'active_tab_unavailable'};
  const platform=platformFromUrl(tab.url);
  if(!platform)return{ok:false,error:'platform_not_registered',host:(()=>{try{return new URL(tab.url).hostname}catch{return''}})()};
  await chrome.scripting.executeScript({target:{tabId:tab.id},files:['src/content/network-probe.js'],world:'MAIN'}).catch(()=>{});
  await chrome.scripting.executeScript({target:{tabId:tab.id},files:['src/content/network-bridge.js'],world:'ISOLATED'}).catch(()=>{});
  await chrome.scripting.executeScript({target:{tabId:tab.id},files:['src/content/generic-adapter.js'],world:'ISOLATED'}).catch(()=>{});
  const{scannerState,settings={}}=await chrome.storage.local.get(['scannerState','settings']);
  const next=merge(scannerState,{connection:'connecting',platformId:platform.id,platformName:platform.name,targetTabId:tab.id,marketCatalog:{assets:[],timeframes:[],expirations:[],lines:[]},diagnostics:{target:{host:new URL(tab.url).hostname,tabId:tab.id,connectedAt:Date.now()}}});
  await chrome.storage.local.set({scannerState:next});
  telemetryEvent('platform_connected',{platformId:platform.id,platformName:platform.name},settings);
  return{ok:true,platform:{id:platform.id,name:platform.name},tabId:tab.id}
}
async function prepareTrade(direction){
  if(!['BUY','SELL'].includes(direction))return{ok:false,error:'invalid_direction'};
  const{scannerState,settings={}}=await chrome.storage.local.get(['scannerState','settings']),tabId=scannerState?.targetTabId;
  if(!tabId)return{ok:false,error:'platform_tab_not_connected'};
  const intent={direction,asset:scannerState.asset||null,timeframe:scannerState.analysisTimeframe||scannerState.timeframe||null,expiration:scannerState.targetExpiration||scannerState.expiration||null,createdAt:Date.now(),status:'prepared'};
  let handoff={found:false,label:null};
  try{
    const tab=await chrome.tabs.get(tabId);await chrome.tabs.update(tabId,{active:true});if(tab?.windowId!=null)await chrome.windows.update(tab.windowId,{focused:true}).catch(()=>{});
    await chrome.scripting.executeScript({target:{tabId},files:['src/content/trade-handoff.js'],world:'ISOLATED'}).catch(()=>{});
    handoff=await chrome.tabs.sendMessage(tabId,{type:'ATS_HIGHLIGHT_TRADE',...intent}).catch(()=>handoff)
  }catch{return{ok:false,error:'platform_tab_unavailable'}}
  const nextIntent={...intent,handoff:{found:!!handoff?.found,label:handoff?.label||null}};
  await chrome.storage.local.set({scannerState:merge(scannerState,{tradeIntent:nextIntent})});
  telemetryEvent('trade_handoff_prepared',{...intent,found:!!handoff?.found},settings);
  return{ok:true,intent:nextIntent}
}

chrome.runtime.onInstalled.addListener(async()=>{
  const{scannerState,settings={}}=await chrome.storage.local.get(['scannerState','settings']),updates={};
  if(!scannerState)updates.scannerState=DEFAULT_STATE;
  if(settings.casatradeSelectors&&!settings.selectorsByPlatform?.casatrade){const next={...settings,selectorsByPlatform:{...(settings.selectorsByPlatform||{}),casatrade:{...settings.casatradeSelectors}}};delete next.casatradeSelectors;updates.settings=next}
  if(Object.keys(updates).length)await chrome.storage.local.set(updates);
  await chrome.sidePanel.setPanelBehavior({openPanelOnActionClick:true})
});

chrome.runtime.onMessage.addListener((message,sender,sendResponse)=>{
  if(message?.type==='ATS_CONNECT_ACTIVE_TAB'){
    connectActiveTab().then(sendResponse).catch(e=>sendResponse({ok:false,error:String(e?.message||e)}));return true
  }
  if(message?.type==='ATS_ACTIVATE_LICENSE'){
    chrome.storage.local.get(['scannerState','settings']).then(async({scannerState,settings={}})=>{
      const r=await activateLicense(settings,message.key);lastLicenseCheck=0;
      const license=r.ok?{...r.license,error:null}:{...DEFAULT_LICENSE,...licenseError(r),...(r.license||{})},next=merge(scannerState,{license});
      await chrome.storage.local.set({scannerState:next});
      if(r.ok){await telemetryEvent('license_activated',{plan:license.plan,planLabel:license.planLabel},settings);await telemetryHeartbeat(telemetryState(next),settings,true)}
      sendResponse({...r,license})
    }).catch(e=>sendResponse({ok:false,error:String(e?.message||e)}));return true
  }
  if(message?.type==='ATS_VALIDATE_LICENSE'){
    chrome.storage.local.get(['scannerState','settings']).then(async({scannerState,settings={}})=>{
      const license=await syncLicense(settings,scannerState,true),next=merge(scannerState,{license});await chrome.storage.local.set({scannerState:next});
      if(license.status==='active')telemetryHeartbeat(telemetryState(next),settings,true);
      sendResponse({ok:license.status==='active',license})
    }).catch(e=>sendResponse({ok:false,error:String(e?.message||e)}));return true
  }
  if(message?.type==='ATS_CLEAR_LICENSE'){
    chrome.storage.local.get(['scannerState','settings']).then(async({scannerState,settings={}})=>{
      await telemetryEvent('license_removed',{},settings);await clearLicense();
      const next=merge(scannerState,{scanner:'idle',license:DEFAULT_LICENSE,signal:{state:'WAIT',score:0,grade:'—',confirmations:'0 / 6',direction:null,hint:'Licença removida.',provisional:true}});
      await chrome.storage.local.set({scannerState:next});sendResponse({ok:true})
    });return true
  }
  if(message?.type==='ATS_PREPARE_TRADE'){
    prepareTrade(String(message.direction||'').toUpperCase()).then(sendResponse).catch(e=>sendResponse({ok:false,error:String(e?.message||e)}));return true
  }
  if(message?.type==='ATS_CLEAR_TRADE_INTENT'){
    chrome.storage.local.get('scannerState').then(({scannerState})=>chrome.storage.local.set({scannerState:merge(scannerState,{tradeIntent:null})}).then(()=>sendResponse({ok:true})));return true
  }
  if(message?.type==='ATS_GET_PLATFORM_CONFIG'){
    let host=message.host||'';if(!host&&sender?.url)try{host=new URL(sender.url).hostname}catch{}
    const platform=detectPlatform(host);sendResponse({ok:!!platform,platform:platform?{...platform}:null});return
  }
  if(message?.type==='ATS_DOM_CATALOG'){
    const p=message.payload||{};
    chrome.storage.local.get(['scannerState','settings']).then(async({scannerState,settings={}})=>{
      if(!sameTarget(scannerState,sender))return sendResponse({ok:true,ignored:true});
      const prefs=settings.scanPreferences||{},domCatalog={candidates:Array.isArray(p.candidates)?p.candidates.slice(0,100):[],assetCount:Number(p.assetCount)||0,timeframe:p.timeframe||null,expiration:p.expiration||null,instrumentType:p.instrumentType||'unknown',lastSeen:Date.now()},net=scannerState?.diagnostics?.network?.candidates||[],marketCatalog=catalogFrom([...net,...domCatalog.candidates],prefs),next=merge(scannerState,{marketCatalog,diagnostics:{...(scannerState?.diagnostics||{}),domCatalog}});
      await chrome.storage.local.set({scannerState:next});sendResponse({ok:true,catalog:marketCatalog})
    }).catch(e=>sendResponse({ok:false,error:String(e?.message||e)}));return true
  }
  if(message?.type==='ATS_NETWORK_DIAGNOSTIC'){
    const p=message.payload||{};
    chrome.storage.local.get(['scannerState','settings']).then(async({scannerState,settings={}})=>{
      if(!sameTarget(scannerState,sender))return sendResponse({ok:true,ignored:true});
      let host='';try{host=new URL(sender?.url||'').hostname}catch{}
      const platform=detectPlatform(host),prefs=settings.scanPreferences||{},network={messages:p.messages||{},connections:p.connections||{},endpoints:Array.isArray(p.endpoints)?p.endpoints.slice(-20):[],keys:Array.isArray(p.keys)?p.keys.slice(0,120):[],candidates:Array.isArray(p.candidates)?p.candidates.slice(0,100).map(x=>({...x,source:'network'})):[],candidateCount:Number(p.candidateCount)||0,lastSeen:Date.now()},dom=scannerState?.diagnostics?.domCatalog?.candidates||[],marketCatalog=catalogFrom([...network.candidates,...dom],prefs),next=merge(scannerState,{platformId:scannerState?.platformId||platform?.id||null,platformName:scannerState?.platformName||platform?.name||null,marketCatalog,diagnostics:{...(scannerState?.diagnostics||{}),network}});
      await chrome.storage.local.set({scannerState:next});sendResponse({ok:true,catalog:marketCatalog})
    }).catch(e=>sendResponse({ok:false,error:String(e?.message||e)}));return true
  }
  if(message?.type==='ATS_PLATFORM_SNAPSHOT'){
    const snapshot=message.payload||{};
    chrome.storage.local.get(['scannerState','settings']).then(async({scannerState,settings={}})=>{
      if(!sameTarget(scannerState,sender))return sendResponse({ok:true,ignored:true});
      const prefs=settings.scanPreferences||{},analysisTimeframe=prefs.timeframe&&prefs.timeframe!=='AUTO'?prefs.timeframe:(snapshot.timeframe||null),targetExpiration=prefs.expiration&&prefs.expiration!=='AUTO'?prefs.expiration:(snapshot.expiration||null),enriched={...snapshot,analysisTimeframe,targetExpiration},license=await syncLicense(settings,scannerState);
      let activeScanner=scannerState?.scanner;if(licenseRequired(settings)&&license.status!=='active')activeScanner='idle';
      let next=merge(scannerState,{...enriched,scanner:activeScanner,license,connection:'online',lastSeen:Date.now()}),pipeline=processSnapshot(enriched,next,riskFrom(settings,license));
      next=merge(next,pipeline);
      const previousState=scannerState?.signal?.state||null,becameConfirm=next.signal?.state==='CONFIRM'&&previousState!=='CONFIRM';
      if(becameConfirm){
        const usage=await consumeSignal(settings);
        if(!usage.ok){
          const hint=usage.error==='daily_limit_reached'?'Limite diário do plano atingido.':usage.error==='trial_limit_reached'?'O teste já utilizou todas as entradas disponíveis.':'Licença inválida para liberar novo sinal.';
          next=merge(next,{license:{...license,...(usage.license||{}),...licenseError(usage)},signal:{...next.signal,state:'NO_TRADE',direction:null,hint}})
        }else{
          next=merge(next,{license:{...license,...(usage.license||{}),...(usage.usage||{}),status:'active',error:null}});
          next=telemetryState(next);
          const record=localSignalRecord(next),history=[record,...(next.signalHistory||[])].slice(0,12);next=merge(next,{signalHistory:history});
          await telemetryEvent('signal_confirmed',{signalId:record.id,platformId:next.platformId,platformName:next.platformName,asset:next.asset,direction:record.direction,entryPrice:record.entryPrice,score:record.score,grade:record.grade,timeframe:record.timeframe,expiration:record.expiration,durationMs:durationMs(record.expiration,record.timeframe),regime:record.regime,confirmations:record.confirmations,feedQuality:next.telemetry.feedQuality,reasons:next.signal?.reasons||[]},settings)
        }
      }
      next=telemetryState(next);
      if(next.signal?.state!==previousState){await telemetryEvent('signal_state',{from:previousState,to:next.signal?.state,direction:next.signal?.direction||null,asset:next.asset||null,score:next.signal?.score??0,provisional:!!next.signal?.provisional},settings)}
      await chrome.storage.local.set({scannerState:next});
      telemetryHeartbeat(next,settings,becameConfirm);
      sendResponse({ok:true,signal:next.signal,license:next.license})
    }).catch(e=>sendResponse({ok:false,error:String(e?.message||e)}));return true
  }
  if(message?.type==='ATS_GET_STATE'){
    chrome.storage.local.get('scannerState').then(({scannerState})=>sendResponse(merge(scannerState)));return true
  }
  if(message?.type==='ATS_SET_SCANNER'){
    chrome.storage.local.get(['scannerState','settings']).then(async({scannerState,settings={}})=>{
      const scanning=!!message.enabled,license=await syncLicense(settings,scannerState,true);
      if(scanning&&licenseRequired(settings)&&license.status!=='active'){
        const next=merge(scannerState,{scanner:'idle',license,signal:{state:'WAIT',score:0,grade:'—',confirmations:'0 / 6',direction:null,hint:'Ative uma licença válida para iniciar o scanner.',provisional:true}});await chrome.storage.local.set({scannerState:next});return sendResponse({ok:false,error:'license_required',state:next})
      }
      let next=merge(scannerState,{scanner:scanning?'scanning':'idle',license,signal:{state:scanning?'SEARCHING':'WAIT',score:0,grade:'—',confirmations:'0 / 6',direction:null,timeframe:scannerState?.analysisTimeframe||null,targetExpiration:scannerState?.targetExpiration||null,hint:scanning?'Iniciando leitura do mercado.':'Scanner pausado.',provisional:true}});
      next=telemetryState(next);await chrome.storage.local.set({scannerState:next});
      await telemetryEvent(scanning?'scanner_started':'scanner_stopped',{platformId:next.platformId,asset:next.asset},settings);telemetryHeartbeat(next,settings,true);
      sendResponse({ok:true,state:next})
    });return true
  }
  if(message?.type==='ATS_RESET_STATE'){
    resetOrchestrator();chrome.storage.local.set({scannerState:DEFAULT_STATE}).then(()=>sendResponse({ok:true}));return true
  }
});