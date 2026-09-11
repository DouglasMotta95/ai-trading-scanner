import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VERSION = '0.9.2';
const PUBLIC_PORT = Number(process.env.PORT || 8787);
const ATS_CHILD_PORT = Number(process.env.ATS_V08_PORT || 8791);
const ATS_CORE_PORT = Number(process.env.ATS_INTERNAL_PORT || 8792);
const ADMIN_KEY = process.env.ATS_ADMIN_KEY || process.env.ATS_API_KEY || '';
const DATA_DIR = path.resolve(process.env.ATS_DATA_DIR || path.resolve(__dirname, '../data'));
const CUSTOMER_DIR = path.resolve(__dirname, '../../apps/customer-portal');
const CUSTOMER_FILE = path.join(DATA_DIR, 'customer-state.json');
const SESSION_COOKIE = 'ats_customer_session';
const SESSION_DAYS = Math.max(1, Number(process.env.CUSTOMER_SESSION_DAYS || 30));
const ACCOUNT_TOKEN_DAYS = Math.max(1, Number(process.env.ACCOUNT_TOKEN_DAYS || 30));
const GOOGLE_CLIENT_ID = String(process.env.GOOGLE_CLIENT_ID || '').trim();
const RESEND_API_KEY = String(process.env.RESEND_API_KEY || '').trim();
const EMAIL_FROM = String(process.env.EMAIL_FROM || '').trim();
const MP_ACCESS_TOKEN = String(process.env.MERCADOPAGO_ACCESS_TOKEN || '').trim();
const MP_WEBHOOK_SECRET = String(process.env.MERCADOPAGO_WEBHOOK_SECRET || '').trim();
const PAYMENTS_CONFIGURED = !!(MP_ACCESS_TOKEN && MP_WEBHOOK_SECRET);
const PUBLIC_BASE_URL = String(process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
const CASA_TRADE_URL = String(process.env.CASA_TRADE_URL || '').trim();
const SUPPORT_WHATSAPP = String(process.env.SUPPORT_WHATSAPP || '5535991429262').replace(/\D/g,'');
const SALES_PRICES = {
  starter: Number(process.env.SALES_STARTER_PRICE || 79.90),
  pro: Number(process.env.SALES_PRO_PRICE || 149.90),
  unlimited: Number(process.env.SALES_UNLIMITED_PRICE || 299.90),
  lifetime: Number(process.env.SALES_LIFETIME_PRICE || 2997.00)
};
const LIFETIME_DAYS = 36500;

let state = { accounts: [], orders: [], trialDevices: {}, paymentEvents: [] };
const connectCodes = new Map();
const rateBuckets = new Map();
const now = () => Date.now();
const cleanEmail = v => String(v || '').trim().toLowerCase().slice(0, 180);
const cleanName = v => String(v || '').trim().slice(0, 120);
const safeEq = (a,b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x,y);
};
const secret = label => crypto.createHash('sha256').update(`${label}:${ADMIN_KEY || 'dev-only-change-me'}`).digest();
const sign = (label, payload) => crypto.createHmac('sha256', secret(label)).update(payload).digest('base64url');
const b64 = v => Buffer.from(v).toString('base64url');
const unb64 = v => Buffer.from(v,'base64url').toString('utf8');
const issueToken = (label, data, ttlMs) => {
  const payload = b64(JSON.stringify({...data,iat:now(),exp:now()+ttlMs,nonce:crypto.randomBytes(8).toString('hex')}));
  return `${payload}.${sign(label,payload)}`;
};
const readToken = (label, raw) => {
  const [payload,sig] = String(raw || '').split('.');
  if (!payload || !sig || !safeEq(sig,sign(label,payload))) return null;
  try { const data = JSON.parse(unb64(payload)); return Number(data.exp)>now() ? data : null; } catch { return null; }
};
function loadState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CUSTOMER_FILE,'utf8'));
    if (parsed && typeof parsed === 'object') state = {
      accounts:Array.isArray(parsed.accounts)?parsed.accounts:[],
      orders:Array.isArray(parsed.orders)?parsed.orders:[],
      trialDevices:parsed.trialDevices&&typeof parsed.trialDevices==='object'?parsed.trialDevices:{},
      paymentEvents:Array.isArray(parsed.paymentEvents)?parsed.paymentEvents:[]
    };
  } catch {}
}
function saveState() {
  fs.mkdirSync(DATA_DIR,{recursive:true});
  const tmp = `${CUSTOMER_FILE}.tmp`;
  fs.writeFileSync(tmp,JSON.stringify(state,null,2));
  fs.renameSync(tmp,CUSTOMER_FILE);
}
function readBody(req,max=131072) {
  return new Promise((resolve,reject)=>{
    let raw='';
    req.on('data',c=>{raw+=c;if(raw.length>max){reject(new Error('too_large'));req.destroy();}});
    req.on('end',()=>{try{resolve(raw?JSON.parse(raw):{})}catch{reject(new Error('invalid_json'))}});
  });
}
function cookies(req) {
  return Object.fromEntries(String(req.headers.cookie||'').split(';').map(x=>x.trim()).filter(Boolean).map(x=>{
    const i=x.indexOf('='); return i<0?[x,'']:[x.slice(0,i),decodeURIComponent(x.slice(i+1))];
  }));
}
function secure(req) { return String(req.headers['x-forwarded-proto']||'').toLowerCase()==='https'||!!req.socket.encrypted; }
function customerCookie(req, account) {
  const token=issueToken('customer-session',{uid:account.id},SESSION_DAYS*86400000);
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=${SESSION_DAYS*86400}; HttpOnly; SameSite=Lax${secure(req)?'; Secure':''}`;
}
function clearCookie(req){return `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure(req)?'; Secure':''}`;}
function accountFromReq(req) {
  const t=readToken('customer-session',cookies(req)[SESSION_COOKIE]);
  return t?state.accounts.find(a=>a.id===t.uid)||null:null;
}
function ipOf(req){return String(req.headers['x-forwarded-for']||req.socket.remoteAddress||'').split(',')[0].trim();}
function rate(req,key,limit=10,windowMs=60000){
  const id=`${key}:${ipOf(req)}`, t=now(), b=rateBuckets.get(id);
  if(!b||t>b.reset){rateBuckets.set(id,{count:1,reset:t+windowMs});return true}
  if(b.count>=limit)return false;b.count++;return true;
}
function response(res,status,data,headers={}) {
  res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store',...headers});
  res.end(status===204?'':JSON.stringify(data));
}
function baseUrl(req) {
  if(PUBLIC_BASE_URL)return PUBLIC_BASE_URL;
  const proto=String(req.headers['x-forwarded-proto']||'https').split(',')[0];
  return `${proto}://${req.headers.host}`;
}
async function child(pathname,{method='GET',body=null,headers={}}={}) {
  const r=await fetch(`http://127.0.0.1:${ATS_CHILD_PORT}${pathname}`,{
    method,headers:{'content-type':'application/json',...headers},
    body:body==null||['GET','HEAD'].includes(method)?undefined:JSON.stringify(body),
    redirect:'manual'
  });
  const raw=await r.text();let data;
  try{data=raw?JSON.parse(raw):{}}catch{data=raw}
  return{status:r.status,data,raw,headers:r.headers};
}
async function proxy(req,res) {
  try{
    let body=null;if(!['GET','HEAD'].includes(req.method||'GET'))body=await readBody(req,262144);
    const headers={};for(const k of ['cookie','x-admin-key','x-api-key','authorization','origin','user-agent','x-request-id','x-signature'])if(req.headers[k])headers[k]=req.headers[k];
    const r=await child(req.url,{method:req.method,body,headers});
    const out={};for(const k of ['content-type','location','set-cookie','cache-control','access-control-allow-origin','access-control-allow-credentials','vary']){const v=r.headers.get(k);if(v)out[k]=v}
    res.writeHead(r.status,out);res.end(r.raw);
  }catch(e){response(res,502,{error:'upstream_unavailable',detail:String(e?.message||e)})}
}
function serve(res,file,type){
  try{const data=fs.readFileSync(path.join(CUSTOMER_DIR,file));res.writeHead(200,{'content-type':type,'cache-control':'no-store, max-age=0'});res.end(data);return true}catch{return false}
}
function hashPassword(password,salt=crypto.randomBytes(16).toString('hex')){
  const hash=crypto.scryptSync(String(password),salt,64).toString('hex');return{salt,hash};
}
function verifyPassword(password,a){if(!a.passwordHash||!a.passwordSalt)return false;const got=crypto.scryptSync(String(password),a.passwordSalt,64).toString('hex');return safeEq(got,a.passwordHash)}
function presentLicense(a,license=null){
  if(!license)return null;
  if(a?.commercialPlan==='lifetime'&&license.plan==='unlimited')return{...license,plan:'lifetime',planLabel:'Vitalício',expiresAt:null,lifetime:true,billing:'one_time'};
  return license;
}
function publicAccount(a,license=null){
  return{id:a.id,name:a.name,email:a.email,emailVerified:!!a.emailVerified,provider:a.googleSub?'google':'email',createdAt:a.createdAt,currentLicenseKey:a.currentLicenseKey||null,trialClaimedAt:a.trialClaimedAt||null,commercialPlan:a.commercialPlan||null,license:presentLicense(a,license)};
}
async function licenseProfile(a){
  if(!a?.currentLicenseKey)return null;
  const r=await child(`/v1/admin/customers/${encodeURIComponent(a.currentLicenseKey)}`,{headers:{'x-admin-key':ADMIN_KEY}});
  return r.status===200?r.data?.license||r.data:null;
}
async function createEntitlement(a,plan='trial',days=null){
  const route=plan==='trial'?'/v1/admin/trials':'/v1/admin/licenses';
  const r=await child(route,{method:'POST',headers:{'x-admin-key':ADMIN_KEY},body:{customerName:a.name,email:a.email,plan,days}});
  if(r.status>=300||!r.data?.license?.key)throw new Error(r.data?.error||'entitlement_create_failed');
  a.currentLicenseKey=r.data.license.key;
  if(plan==='trial')a.trialClaimedAt=now();
  a.updatedAt=now();saveState();
  return r.data.license;
}
async function ensureTrial(a){
  if(a.currentLicenseKey)return licenseProfile(a);
  if(a.trialClaimedAt)throw new Error('trial_already_claimed');
  return createEntitlement(a,'trial',3);
}
async function grantPaidEntitlement(a,plan,days=30){
  const current=await licenseProfile(a);
  if(plan==='lifetime'){
    if(current?.key&&current.plan==='unlimited'&&a.commercialPlan==='lifetime')return presentLicense(a,current);
    const previousKey=a.currentLicenseKey||null;
    const created=await createEntitlement(a,'unlimited',LIFETIME_DAYS);
    a.commercialPlan='lifetime';a.updatedAt=now();saveState();
    if(previousKey&&previousKey!==created.key)await child(`/v1/admin/licenses/${encodeURIComponent(previousKey)}/revoke`,{method:'POST',headers:{'x-admin-key':ADMIN_KEY}}).catch(()=>{});
    return presentLicense(a,created);
  }
  if(current?.key&&current.plan===plan&&current.plan!=='trial'&&a.commercialPlan!=='lifetime'){
    const renewed=await child(`/v1/admin/licenses/${encodeURIComponent(current.key)}/renew`,{method:'POST',headers:{'x-admin-key':ADMIN_KEY},body:{days}});
    if(renewed.status<300&&renewed.data?.license){a.currentLicenseKey=current.key;a.commercialPlan=plan;a.updatedAt=now();saveState();return renewed.data.license}
  }
  const previousKey=a.currentLicenseKey||null;
  const created=await createEntitlement(a,plan,days);
  a.commercialPlan=plan;a.updatedAt=now();saveState();
  if(previousKey&&previousKey!==created.key){
    await child(`/v1/admin/licenses/${encodeURIComponent(previousKey)}/revoke`,{method:'POST',headers:{'x-admin-key':ADMIN_KEY}}).catch(()=>{});
  }
  return created;
}
async function sendVerification(req,a){
  const token=issueToken('email-verify',{uid:a.id,email:a.email},24*3600000);
  const url=`${baseUrl(req)}/?verify=${encodeURIComponent(token)}`;
  if(!RESEND_API_KEY||!EMAIL_FROM)return{sent:false};
  const r=await fetch('https://api.resend.com/emails',{method:'POST',headers:{authorization:`Bearer ${RESEND_API_KEY}`,'content-type':'application/json'},body:JSON.stringify({
    from:EMAIL_FROM,to:[a.email],subject:'Confirme seu e-mail • AI Trading Scanner',
    html:`<div style="font-family:Arial,sans-serif;background:#07111c;color:#eef7ff;padding:32px"><h2>Confirme seu e-mail</h2><p>Olá ${a.name||'trader'}, confirme seu cadastro para liberar seu teste do AI Trading Scanner.</p><p><a href="${url}" style="display:inline-block;background:#44e0b5;color:#04120e;padding:14px 20px;border-radius:10px;text-decoration:none;font-weight:700">CONFIRMAR E-MAIL</a></p><p>Esse link expira em 24 horas.</p></div>`
  })});
  return{sent:r.ok};
}
function verifyGoogleCredential(credential){
  return fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`).then(async r=>{
    if(!r.ok)throw new Error('google_invalid');const d=await r.json();
    if(!GOOGLE_CLIENT_ID||d.aud!==GOOGLE_CLIENT_ID||d.email_verified!=='true')throw new Error('google_invalid');
    return{sub:d.sub,email:cleanEmail(d.email),name:cleanName(d.name||d.given_name||'')};
  });
}
function pruneConnectCodes(){const t=now();for(const[code,c]of connectCodes)if(c.used||c.expiresAt<t)connectCodes.delete(code)}
function connectCode(){pruneConnectCodes();let code;do{code=String(crypto.randomInt(100000,1000000))}while(connectCodes.has(code));return code;}
function issueAccountToken(a){return issueToken('extension-account',{uid:a.id},ACCOUNT_TOKEN_DAYS*86400000)}
function accountFromBearer(req){
  const h=String(req.headers.authorization||'');if(!h.toLowerCase().startsWith('bearer '))return null;
  const t=readToken('extension-account',h.slice(7).trim());return t?state.accounts.find(a=>a.id===t.uid)||null:null;
}
async function activateForAccount(a,installationId,version){
  if(!a.currentLicenseKey)await ensureTrial(a);
  const r=await child('/v1/license/activate',{method:'POST',body:{licenseKey:a.currentLicenseKey,installationId,version}});
  if(r.status>=300||!r.data?.ok)throw Object.assign(new Error(r.data?.error||'license_activation_failed'),{status:r.status,data:r.data});
  return{...r, ...r.data, license:presentLicense(a,r.data.license),licenseKey:a.currentLicenseKey,accountToken:issueAccountToken(a),accountTokenExpiresAt:now()+ACCOUNT_TOKEN_DAYS*86400000};
}
async function publicPlans(){
  const r=await child('/v1/admin/plans',{headers:{'x-admin-key':ADMIN_KEY}});
  const rows=Array.isArray(r.data?.plans)?r.data.plans:[];
  const map=Object.fromEntries(rows.map(p=>[p.id,p]));
  const core=['trial','starter','pro','unlimited'].map(id=>{
    const p=map[id]||{id,label:id};
    return{...p,price:id==='trial'?0:(Number(p.price)>0?Number(p.price):SALES_PRICES[id]||0),recommended:id==='pro',lifetime:false,billing:'monthly'};
  });
  core.push({id:'lifetime',label:'Vitalício',dailySignals:null,totalSignals:null,deviceLimit:1,price:SALES_PRICES.lifetime,defaultDays:null,recommended:false,lifetime:true,billing:'one_time'});
  return core;
}
async function checkoutPreference(req,a,planId){
  if(!PAYMENTS_CONFIGURED)throw Object.assign(new Error('payment_not_configured'),{status:503});
  const plans=await publicPlans(), plan=plans.find(p=>p.id===planId&&p.id!=='trial');
  if(!plan)throw Object.assign(new Error('invalid_plan'),{status:422});
  const order={id:crypto.randomUUID(),accountId:a.id,plan:plan.id,amount:Number(plan.price),currency:'BRL',status:'created',createdAt:now(),updatedAt:now(),paymentId:null,preferenceId:null};
  state.orders.unshift(order);state.orders=state.orders.slice(0,3000);saveState();
  const root=baseUrl(req);
  const description=plan.lifetime?`Plano ${plan.label} • pagamento único • 1 aparelho`:`Plano ${plan.label} por 30 dias`;
  const pref=await fetch('https://api.mercadopago.com/checkout/preferences',{method:'POST',headers:{authorization:`Bearer ${MP_ACCESS_TOKEN}`,'content-type':'application/json','x-idempotency-key':order.id},body:JSON.stringify({
    items:[{id:plan.id,title:`AI Trading Scanner • ${plan.label}`,description,quantity:1,currency_id:'BRL',unit_price:Number(plan.price)}],
    payer:{email:a.email},external_reference:order.id,
    notification_url:`${root}/v1/payments/mercadopago/webhook`,
    back_urls:{success:`${root}/?payment=success`,pending:`${root}/?payment=pending`,failure:`${root}/?payment=failure`},
    auto_return:'approved',metadata:{account_id:a.id,plan_id:plan.id}
  })});
  const data=await pref.json().catch(()=>({}));
  if(!pref.ok||!data.init_point){order.status='preference_failed';order.updatedAt=now();saveState();throw Object.assign(new Error(data.message||'checkout_failed'),{status:502})}
  order.preferenceId=data.id;order.checkoutUrl=data.init_point;order.status='pending';order.updatedAt=now();saveState();
  return{checkoutUrl:data.init_point,order:{id:order.id,plan:order.plan,amount:order.amount,status:order.status}};
}
function mpSignatureValid(req,url){
  if(!MP_WEBHOOK_SECRET)return false;
  const header=String(req.headers['x-signature']||''),requestId=String(req.headers['x-request-id']||''),dataId=url.searchParams.get('data.id')||'';
  const pairs=Object.fromEntries(header.split(',').map(x=>x.trim().split('=')));
  const ts=pairs.ts,v1=pairs.v1;if(!ts||!v1)return false;
  const manifest=[dataId?`id:${String(dataId).toLowerCase()};`:'',requestId?`request-id:${requestId};`:'',`ts:${ts};`].join('');
  const expected=crypto.createHmac('sha256',MP_WEBHOOK_SECRET).update(manifest).digest('hex');
  return safeEq(expected,v1);
}
async function processPayment(paymentId){
  if(!PAYMENTS_CONFIGURED)return;
  const r=await fetch(`https://api.mercadopago.com/v1/payments/${encodeURIComponent(paymentId)}`,{headers:{authorization:`Bearer ${MP_ACCESS_TOKEN}`}});
  if(!r.ok)return;
  const p=await r.json(),order=state.orders.find(o=>o.id===p.external_reference);
  if(!order)return;
  order.paymentId=String(p.id);order.paymentStatus=p.status;order.updatedAt=now();
  if(p.status==='approved'&&order.status!=='approved'){
    const a=state.accounts.find(x=>x.id===order.accountId);if(!a)return;
    const lic=await grantPaidEntitlement(a,order.plan,order.plan==='lifetime'?LIFETIME_DAYS:30);
    order.status='approved';order.licenseKey=lic.key;order.approvedAt=now();
  } else if(p.status!=='approved') order.status=p.status||'pending';
  saveState();
}
async function syncDefaultPrices(){
  try{
    const r=await child('/v1/admin/plans',{headers:{'x-admin-key':ADMIN_KEY}});
    for(const p of r.data?.plans||[]){
      if(['starter','pro','unlimited'].includes(p.id)&&Number(p.price||0)<=0){
        await child(`/v1/admin/plans/${encodeURIComponent(p.id)}`,{method:'POST',headers:{'x-admin-key':ADMIN_KEY},body:{price:SALES_PRICES[p.id]}});
      }
    }
  }catch{}
}

loadState();
const childProc=spawn(process.execPath,[path.join(__dirname,'server-v08.js')],{env:{...process.env,PORT:String(ATS_CHILD_PORT),ATS_INTERNAL_PORT:String(ATS_CORE_PORT)},stdio:['ignore','pipe','pipe']});
childProc.stdout.on('data',d=>process.stdout.write(`[v08] ${d}`));childProc.stderr.on('data',d=>process.stderr.write(`[v08] ${d}`));
childProc.on('exit',code=>{console.error(`ATS v08 child exited ${code}`);process.exit(code||1)});
setTimeout(syncDefaultPrices,2500);

const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost'),pathname=url.pathname;
  try{
    if(pathname==='/'||pathname==='/app/'||pathname==='/app')return serve(res,'index.html','text/html; charset=utf-8')||response(res,404,{error:'customer_ui_missing'});
    if(pathname==='/customer.css')return serve(res,'styles.css','text/css; charset=utf-8')||response(res,404,{error:'not_found'});
    if(pathname==='/customer.js')return serve(res,'app.js','text/javascript; charset=utf-8')||response(res,404,{error:'not_found'});

    if(pathname==='/v1/public/config'&&req.method==='GET'){
      const plans=await publicPlans();return response(res,200,{product:'AI Trading Scanner',version:VERSION,plans,googleClientId:GOOGLE_CLIENT_ID||null,emailDeliveryConfigured:!!(RESEND_API_KEY&&EMAIL_FROM),paymentsConfigured:PAYMENTS_CONFIGURED,supportWhatsapp:SUPPORT_WHATSAPP,casaTradeUrl:CASA_TRADE_URL||null});
    }
    if(pathname==='/v1/customer/signup'&&req.method==='POST'){
      if(!rate(req,'signup',5,3600000))return response(res,429,{error:'too_many_attempts'});
      const b=await readBody(req),email=cleanEmail(b.email),name=cleanName(b.name),password=String(b.password||'');
      if(!email.includes('@')||name.length<2||password.length<8)return response(res,422,{error:'invalid_signup'});
      if(state.accounts.some(a=>a.email===email))return response(res,409,{error:'email_in_use'});
      const h=hashPassword(password),a={id:crypto.randomUUID(),name,email,emailVerified:false,passwordHash:h.hash,passwordSalt:h.salt,createdAt:now(),updatedAt:now(),currentLicenseKey:null,trialClaimedAt:null,commercialPlan:null};
      state.accounts.push(a);saveState();const delivery=await sendVerification(req,a);
      return response(res,201,{ok:true,verificationRequired:true,emailDeliveryConfigured:delivery.sent});
    }
    if(pathname==='/v1/customer/resend-verification'&&req.method==='POST'){
      if(!rate(req,'resend',5,3600000))return response(res,429,{error:'too_many_attempts'});
      const b=await readBody(req),a=state.accounts.find(x=>x.email===cleanEmail(b.email));
      if(!a||a.emailVerified)return response(res,200,{ok:true});
      const delivery=await sendVerification(req,a);return response(res,200,{ok:true,emailDeliveryConfigured:delivery.sent});
    }
    if(pathname==='/v1/customer/verify-email'&&req.method==='POST'){
      const b=await readBody(req),t=readToken('email-verify',String(b.token||''));if(!t)return response(res,400,{error:'verification_invalid'});
      const a=state.accounts.find(x=>x.id===t.uid&&x.email===t.email);if(!a)return response(res,404,{error:'account_not_found'});
      a.emailVerified=true;a.verifiedAt=now();a.updatedAt=now();if(!a.currentLicenseKey&&!a.trialClaimedAt)await ensureTrial(a);saveState();
      return response(res,200,{ok:true,account:publicAccount(a,await licenseProfile(a))},{'set-cookie':customerCookie(req,a)});
    }
    if(pathname==='/v1/customer/login'&&req.method==='POST'){
      if(!rate(req,'login',10,60000))return response(res,429,{error:'too_many_attempts'});
      const b=await readBody(req),a=state.accounts.find(x=>x.email===cleanEmail(b.email));
      if(!a||!verifyPassword(String(b.password||''),a))return response(res,401,{error:'invalid_credentials'});
      if(!a.emailVerified)return response(res,403,{error:'email_not_verified'});
      return response(res,200,{ok:true,account:publicAccount(a,await licenseProfile(a))},{'set-cookie':customerCookie(req,a)});
    }
    if(pathname==='/v1/customer/google'&&req.method==='POST'){
      if(!GOOGLE_CLIENT_ID)return response(res,503,{error:'google_not_configured'});
      const b=await readBody(req),g=await verifyGoogleCredential(String(b.credential||''));let a=state.accounts.find(x=>x.googleSub===g.sub||x.email===g.email);
      if(!a){a={id:crypto.randomUUID(),name:g.name||g.email.split('@')[0],email:g.email,emailVerified:true,googleSub:g.sub,createdAt:now(),updatedAt:now(),currentLicenseKey:null,trialClaimedAt:null,commercialPlan:null};state.accounts.push(a)}
      else{a.googleSub=g.sub;a.emailVerified=true;a.name=a.name||g.name;a.updatedAt=now()}
      if(!a.currentLicenseKey&&!a.trialClaimedAt)await ensureTrial(a);saveState();
      return response(res,200,{ok:true,account:publicAccount(a,await licenseProfile(a))},{'set-cookie':customerCookie(req,a)});
    }
    if(pathname==='/v1/customer/logout'&&req.method==='POST')return response(res,200,{ok:true},{'set-cookie':clearCookie(req)});
    if(pathname==='/v1/customer/me'&&req.method==='GET'){
      const a=accountFromReq(req);if(!a)return response(res,401,{error:'unauthorized'});
      return response(res,200,{account:publicAccount(a,await licenseProfile(a)),orders:state.orders.filter(o=>o.accountId===a.id).slice(0,20)});
    }
    if(pathname==='/v1/customer/connect-code'&&req.method==='POST'){
      const a=accountFromReq(req);if(!a)return response(res,401,{error:'unauthorized'});
      if(!a.emailVerified)return response(res,403,{error:'email_not_verified'});
      const lic=await licenseProfile(a);
      if(!lic||lic.status!=='active'||(lic.expiresAt&&Date.parse(lic.expiresAt)<=now()))return response(res,409,{error:'access_inactive'});
      const code=connectCode();connectCodes.set(code,{accountId:a.id,expiresAt:now()+10*60000,used:false});
      return response(res,201,{ok:true,code,expiresAt:now()+10*60000});
    }
    if(pathname==='/v1/customer/extension/exchange'&&req.method==='POST'){
      if(!rate(req,'exchange',20,60000))return response(res,429,{error:'too_many_attempts'});
      pruneConnectCodes();
      const b=await readBody(req),code=String(b.code||'').replace(/\D/g,''),installationId=String(b.installationId||'').trim().slice(0,128),version=String(b.version||'').slice(0,32),c=connectCodes.get(code);
      if(!c||c.used||c.expiresAt<now()||!installationId)return response(res,400,{error:'connect_code_invalid'});
      const a=state.accounts.find(x=>x.id===c.accountId);if(!a||!a.emailVerified)return response(res,403,{error:'account_not_verified'});
      const lic=await licenseProfile(a);
      if((lic?.plan==='trial'||(!lic&&a.trialClaimedAt))&&state.trialDevices[installationId]&&state.trialDevices[installationId]!==a.id)return response(res,403,{error:'trial_device_already_used'});
      const result=await activateForAccount(a,installationId,version);c.used=true;connectCodes.delete(code);
      if(result.license?.plan==='trial'){state.trialDevices[installationId]=a.id;saveState()}
      return response(res,200,{ok:true,...result,account:{name:a.name,email:a.email}});
    }
    if(pathname==='/v1/customer/extension/refresh'&&req.method==='POST'){
      const a=accountFromBearer(req);if(!a)return response(res,401,{error:'account_token_invalid'});
      const b=await readBody(req),installationId=String(b.installationId||'').trim().slice(0,128),version=String(b.version||'').slice(0,32);
      if(!installationId)return response(res,422,{error:'installation_required'});
      const result=await activateForAccount(a,installationId,version);return response(res,200,{ok:true,...result});
    }
    if(pathname==='/v1/customer/checkout'&&req.method==='POST'){
      const a=accountFromReq(req);if(!a)return response(res,401,{error:'unauthorized'});
      const b=await readBody(req),out=await checkoutPreference(req,a,String(b.plan||''));return response(res,201,{ok:true,...out});
    }
    if(pathname==='/v1/payments/mercadopago/webhook'&&req.method==='POST'){
      if(!PAYMENTS_CONFIGURED)return response(res,503,{error:'payment_not_configured'});
      const b=await readBody(req).catch(()=>({}));
      const paymentId=String(url.searchParams.get('data.id')||b?.data?.id||'');
      if(!mpSignatureValid(req,url))return response(res,401,{error:'invalid_signature'});
      const eventKey=String(b?.id||`${paymentId}:${b?.action||''}`);if(eventKey&&state.paymentEvents.includes(eventKey))return response(res,200,{ok:true,duplicate:true});
      if(eventKey){state.paymentEvents.unshift(eventKey);state.paymentEvents=state.paymentEvents.slice(0,1000);saveState()}
      if(paymentId)processPayment(paymentId).catch(e=>console.error('payment webhook',e?.message||e));
      return response(res,200,{ok:true});
    }
    if(pathname==='/v1/admin/customer-accounts'&&req.method==='GET'){
      const r=await child('/v1/admin/auth/status',{headers:{cookie:req.headers.cookie||'','x-admin-key':req.headers['x-admin-key']||''}});
      if(r.status!==200)return response(res,401,{error:'unauthorized'});
      const rows=await Promise.all(state.accounts.map(async a=>({...publicAccount(a,await licenseProfile(a)),orders:state.orders.filter(o=>o.accountId===a.id).length})));
      const active=x=>x.license?.status==='active'&&(!x.license.expiresAt||Date.parse(x.license.expiresAt)>now());
      return response(res,200,{accounts:rows,summary:{accounts:rows.length,verified:rows.filter(x=>x.emailVerified).length,trials:rows.filter(x=>active(x)&&x.license?.plan==='trial').length,paid:rows.filter(x=>active(x)&&x.license?.plan!=='trial').length,approvedOrders:state.orders.filter(x=>x.status==='approved').length}});
    }
    if(pathname==='/health'){
      const r=await child('/health');return response(res,r.status,{...(r.data||{}),version:VERSION,sales:true,customerAccounts:true,paymentsConfigured:PAYMENTS_CONFIGURED,emailDeliveryConfigured:!!(RESEND_API_KEY&&EMAIL_FROM),googleConfigured:!!GOOGLE_CLIENT_ID,lifetimePlan:true});
    }
    return proxy(req,res);
  }catch(e){
    const status=Number(e.status)||({too_large:413,invalid_json:400}[e.message]||400);
    return response(res,status,{error:e.message||'bad_request'});
  }
});
server.listen(PUBLIC_PORT,()=>console.log(`ATS v${VERSION} sales gateway :${PUBLIC_PORT} -> v08 :${ATS_CHILD_PORT} -> core :${ATS_CORE_PORT}`));
