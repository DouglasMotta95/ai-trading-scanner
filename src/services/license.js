import{installationId,saveClientToken,clearClientToken}from'./telemetry.js';
const LICENSE_KEY='atsLicenseKey',PUBLIC_API='https://ats-control-center-v07-production.up.railway.app';
const base=s=>{const raw=String(s?.apiBase||'').trim();if(!raw)return PUBLIC_API;if(/ats-control-center-live-production|ats-control-center-production-|ai-trading-scanner-production-/i.test(raw))return PUBLIC_API;return raw.replace(/\/$/,'')};
export const isDevBuild=()=>!chrome.runtime.getManifest().update_url;
export const licenseRequired=(settings={})=>settings.licenseRequired!==false&&(!isDevBuild()||settings.forceLicense===true);
export async function savedLicenseKey(){const x=await chrome.storage.local.get(LICENSE_KEY);return String(x[LICENSE_KEY]||'').trim()}
export async function saveLicenseKey(key=''){key=String(key||'').trim();await chrome.storage.local.set({[LICENSE_KEY]:key});return key}
async function call(settings,path,payload){try{const r=await fetch(`${base(settings)}${path}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)}),data=await r.json().catch(()=>({}));return{ok:r.ok,status:r.status,...data}}catch{return{ok:false,error:'backend_unreachable'}}}
async function acceptSession(r,licenseKey=''){if(r?.ok&&r.clientToken){await saveClientToken(r.clientToken,r.clientTokenExpiresAt);if(licenseKey)await saveLicenseKey(licenseKey)}return r}
export async function activateLicense(settings={},key=''){
  const installationIdValue=await installationId(),licenseKey=String(key||'').trim();
  if(!licenseKey)return{ok:false,error:'license_required'};
  const r=await call(settings,'/v1/license/activate',{licenseKey,installationId:installationIdValue,version:chrome.runtime.getManifest().version});
  return acceptSession(r,licenseKey)
}
export async function validateLicense(settings={}){
  const licenseKey=await savedLicenseKey();
  if(!licenseKey&&!licenseRequired(settings))return{ok:true,license:{status:'active',plan:'developer',planLabel:'Developer',dailyLimit:null,usedToday:0,remainingToday:null,totalLimit:null,usedTotal:0,remainingTotal:null,development:true,linked:false}};
  if(!licenseKey)return{ok:false,error:'license_required'};
  const r=await call(settings,'/v1/license/validate',{licenseKey,installationId:await installationId(),version:chrome.runtime.getManifest().version});
  return acceptSession(r,licenseKey)
}
export async function consumeSignal(settings={}){
  const licenseKey=await savedLicenseKey();
  if(!licenseKey&&!licenseRequired(settings))return{ok:true,usage:{dailyLimit:null,usedToday:0,remainingToday:null,totalLimit:null,usedTotal:0,remainingTotal:null},development:true};
  if(!licenseKey)return{ok:false,error:'license_required'};
  return call(settings,'/v1/license/consume',{licenseKey,installationId:await installationId(),type:'signal',version:chrome.runtime.getManifest().version})
}
export async function clearLicense(){await saveLicenseKey('');await clearClientToken()}