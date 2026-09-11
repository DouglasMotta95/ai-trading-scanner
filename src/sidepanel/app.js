const PUBLIC_API='https://ats-control-center-v07-production.up.railway.app';
const LAST_VALID_LICENSE_KEY='atsLastValidLicense';
const $=id=>document.getElementById(id);
const extensionVersion=$('extensionVersion');if(extensionVersion)extensionVersion.textContent=`v${chrome.runtime.getManifest().version} • LIVE OPS`;
const connectBtn=$('connectBtn'),toggleBtn=$('toggleScanner'),tfSelect=$('analysisTimeframe'),expSelect=$('targetExpiration'),buyBtn=$('prepareBuy'),sellBtn=$('prepareSell'),scoreGauge=$('scoreGauge');
let requested=false,lastError='',lastState={};
const fresh=s=>s.connection==='online'&&s.lastSeen&&Date.now()-s.lastSeen<7000;
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt=v=>v==null||v===''?'—':Number.isFinite(Number(v))?String(Number(v)):'—';
const activeLicense=s=>s.license?.status==='active';
const licenseStillValid=l=>{if(l?.status!=='active')return false;if(!l.expiresAt)return true;const t=Date.parse(l.expiresAt);return Number.isFinite(t)&&t>Date.now()};
function effectiveLicense(stateLicense={},cachedEntry=null){
  if(licenseStillValid(stateLicense))return stateLicense;
  if(['expired','limit','device_locked'].includes(String(stateLicense?.status||'')))return stateLicense;
  const cached=cachedEntry?.license;
  if(licenseStillValid(cached))return{...cached,status:'active',error:'backend_unreachable',syncPending:true};
  if(stateLicense?.status==='active'&&!licenseStillValid(stateLicense))return{...stateLicense,status:'expired',error:'license_expired',syncPending:false};
  return stateLicense;
}
function ensureOption(select,value){value=String(value||'').trim();if(!value||[...select.options].some(o=>o.value===value))return;const o=document.createElement('option');o.value=value;o.textContent=value;select.appendChild(o)}
function setDot(id,on){const el=$(id);if(el)el.className=on?'on':''}
function usageText(l={}){
  const trial=l.isTrial||l.plan==='trial';
  if(trial&&l.totalLimit!=null)return`Teste: ${Number(l.usedTotal)||0}/${l.totalLimit} • ${l.remainingTotal??Math.max(0,l.totalLimit-(Number(l.usedTotal)||0))} restantes`;
  if(l.dailyLimit==null)return`Uso diário: ${Number(l.usedToday)||0} • sem limite`;
  return`Uso diário: ${Number(l.usedToday)||0}/${l.dailyLimit} • ${l.remainingToday??Math.max(0,l.dailyLimit-(Number(l.usedToday)||0))} restantes`
}
function renderLicense(s={}){
  const l=s.license||{},active=l.status==='active',waiting=active&&(l.syncPending||l.error==='backend_unreachable'),trial=l.isTrial||l.plan==='trial',limit=trial&&l.totalLimit!=null?l.totalLimit:l.dailyLimit,used=trial&&l.totalLimit!=null?Number(l.usedTotal)||0:Number(l.usedToday)||0;
  $('licenseCard').classList.toggle('active',active);$('licenseCard').classList.toggle('blocked',!active);$('activationBox').hidden=active;
  $('licenseHealth').textContent=active?String(l.planLabel||l.plan||'ATIVA').toUpperCase():String(l.status||'INATIVA').toUpperCase();
  $('planBadge').textContent=active?String(l.planLabel||l.plan||'ATIVA').toUpperCase():'LICENÇA';
  $('licenseTitle').textContent=active?(waiting?'Licença ativa • aguardando sincronização':'Licença ativa'):l.status==='expired'?'Licença expirada':l.status==='limit'?'Limite do plano atingido':l.status==='device_locked'?'Licença vinculada a outro aparelho':'Ativação necessária';
  $('licenseText').textContent=active?(waiting?'Último acesso válido mantido. O ATS vai sincronizar automaticamente quando o servidor estiver disponível.':`${l.planLabel||l.plan||'Plano'} ativo${l.expiresAt?` • vence ${new Date(l.expiresAt).toLocaleDateString('pt-BR')}`:''}.`):l.status==='expired'?'Esta licença precisa ser renovada.':l.status==='device_locked'?'Esta licença já está vinculada a outro aparelho. A troca precisa ser liberada pelo administrador.':l.status==='limit'?'O limite disponível para este acesso foi utilizado.':l.error==='backend_unreachable'?'Servidor ATS indisponível no momento.':'Entre na sua conta ATS ou use uma licença manual de suporte.';
  $('licenseUsage').textContent=active?usageText(l):'Uso: —';
  $('licenseDevice').textContent=active?(l.deviceLocked||l.devices>0?'Aparelho: VINCULADO':'Aparelho: LIVRE'):'Aparelho: —';
  const pct=limit==null?0:Math.max(0,Math.min(100,limit?used/limit*100:0));
  $('quotaText').textContent=limit==null?(active?'ILIMITADO':'—'):`${used} / ${limit}`;$('quotaBar').style.width=`${pct}%`;
  $('quotaHint').textContent=trial&&l.totalLimit!=null?'O Trial usa um limite total. Ele não renova automaticamente no dia seguinte.':limit==null?'Seu plano não possui limite diário de sinais.':'Este é o limite comercial do plano. Os critérios técnicos são calculados separadamente.'
}
function renderCatalog(s={}){
  const c=s.marketCatalog||{},lines=Array.isArray(c.lines)?c.lines:[],assets=Array.isArray(c.assets)?c.assets:[];
  $('catalogCount').textContent=`${assets.length} ${assets.length===1?'ATIVO':'ATIVOS'}`;(c.timeframes||[]).forEach(v=>ensureOption(tfSelect,v));(c.expirations||[]).forEach(v=>ensureOption(expSelect,v));
  $('catalogList').innerHTML=lines.length?lines.slice(0,24).map(x=>{const src=x.source==='network'?'FEED':'DOM',meta=[x.expiration||x.timeframe||'OBSERVADO',x.payout!=null?`PAYOUT ${fmt(x.payout)}`:null].filter(Boolean).join(' • ');return`<div class="catalog-row"><div><b>${esc(x.asset)}</b><small>${esc(meta)}</small></div><span>${fmt(x.price)}</span><em class="${src==='FEED'?'feed':'dom'}">${src}</em></div>`}).join(''):'<div class="empty-state">Nenhum ativo detectado ainda. Deixe a plataforma aberta enquanto o scanner mapeia o feed.</div>'
}
function renderReasons(sig={}){
  let reasons=Array.isArray(sig.reasons)?sig.reasons.filter(Boolean).slice(0,5):[];
  if(!reasons.length&&sig.hint)reasons=String(sig.hint).split(' • ').filter(Boolean).slice(0,4);
  if(!reasons.length)reasons=['Aguardando dados suficientes para explicar o setup.'];
  $('signalReasons').innerHTML=reasons.map(r=>`<p>${esc(r)}</p>`).join('')
}
function signalTone(state,direction){if(state==='CONFIRM')return direction==='SELL'?'sell':'confirm';if(state==='WATCH')return'watch';if(state==='NO_TRADE')return'blocked';return'neutral'}
function renderSignal(s={}){
  const sig=s.signal||{},score=Number.isFinite(Number(sig.score))?Math.max(0,Math.min(100,Number(sig.score))):0,state=String(sig.state||'WAIT'),direction=sig.direction||'—',warm=sig.warmup||{current:sig.candleCount||0,required:21},pct=Math.max(0,Math.min(100,(warm.current||0)/(warm.required||21)*100)),tone=signalTone(state,direction);
  $('score').textContent=Number.isFinite(Number(sig.score))?String(Math.round(Number(sig.score))):'—';$('signalDirection').textContent=direction;$('setup').textContent=sig.grade||'—';$('confirmations').textContent=String(sig.confirmations||'0 / 6').replace(/\s*\/\s*/,' de ');$('regime').textContent=(sig.regime||'—').toUpperCase();
  const title=state==='CONFIRM'?(direction==='BUY'?'BUY • ENTRADA CONFIRMADA':'SELL • ENTRADA CONFIRMADA'):state==='WATCH'?'ACOMPANHANDO SETUP':state==='SEARCHING'?'ANALISANDO MERCADO':state==='NO_TRADE'?'NÃO ENTRAR AGORA':state==='WAIT'?'AGUARDANDO CONFLUÊNCIA':state;
  $('scannerState').textContent=title;$('scannerHint').textContent=sig.hint||'Aguardando dados suficientes.';$('warmupText').textContent=`${Math.min(warm.current||0,warm.required||21)} / ${warm.required||21} candles`;$('warmupBar').style.width=`${pct}%`;
  scoreGauge.style.setProperty('--score',`${score}%`);scoreGauge.className=`score-orb ${state==='CONFIRM'?(direction==='SELL'?'sell':'buy'):''}`;
  const command=$('signalCommand');command.className=`signal-command ${tone}`;
  const badge=$('signalBadge');badge.className=`signal-badge ${tone}`;badge.textContent=state==='CONFIRM'?direction:state==='WATCH'?'OBSERVAR':state==='NO_TRADE'?'NÃO ENTRAR':'AGUARDAR';
  $('structureState').textContent=sig.provisional?'PROVISÓRIA':'VALIDADA';
  $('signalCommandSub').textContent=state==='CONFIRM'?`Entrada validada pelo motor • ${sig.confirmations||'critérios confirmados'}. Confirme manualmente na plataforma.`:sig.provisional?'Feed ainda provisório: o scanner pode acompanhar setup, mas não deve liberar entrada confirmada.':'O scanner aguarda confluência e qualidade mínima antes de confirmar.';
  renderReasons(sig)
}
function renderHistory(s={}){
  const rows=Array.isArray(s.signalHistory)?s.signalHistory:[];
  $('signalHistory').innerHTML=rows.length?rows.slice(0,8).map(x=>`<div class="history-row"><span class="history-dir ${x.direction==='SELL'?'sell':'buy'}">${esc(x.direction||'—')}</span><div><b>${esc(x.asset||'—')} • score ${Math.round(Number(x.score||0))}</b><small>${esc(x.timeframe||'AUTO')} • ${esc(x.expiration||'AUTO')} • ${esc(x.regime||'—')}</small></div><time>${new Date(x.at).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'})}</time></div>`).join(''):'<div class="empty-state">Nenhum sinal confirmado nesta instalação ainda.</div>'
}
function render(s={}){
  lastState=s;const online=fresh(s),platform=s.platformName||'Plataforma',age=s.lastSeen?Date.now()-s.lastSeen:null,net=s.diagnostics?.network||{},dom=s.diagnostics?.domCatalog||{},ws=Number(net.connections?.ws)||0,assetCount=s.marketCatalog?.assets?.length||Number(net.candidateCount)||Number(dom.assetCount)||0,structured=!!s.capabilities?.structuredQuotes,quality=Number(s.telemetry?.feedQuality)||0,licensed=activeLicense(s),lastSyncSuccess=Number(s.telemetry?.lastSyncSuccess)||0,telemetryRecent=lastSyncSuccess>0&&Date.now()-lastSyncSuccess<20000,telemetryError=s.telemetry?.lastSyncError;
  $('liveBadge').className=`live-badge ${online?'online':'offline'}`;$('liveBadge').querySelector('span').textContent=online?'LIVE':s.connection==='connecting'?'LINK':'OFFLINE';$('platformPill').className=`pill ${online?'online':''}`;$('platformPill').textContent=online?platform.toUpperCase():s.connection==='connecting'?'CONECTANDO':'AGUARDANDO';
  $('asset').textContent=s.asset||'—';$('price').textContent=s.price||'—';$('marketType').textContent=(s.instrumentType&&s.instrumentType!=='unknown'?s.instrumentType:s.marketType||'unknown').toUpperCase();$('timeframe').textContent=s.analysisTimeframe||s.signal?.timeframe||s.timeframe||'AUTO';$('expiration').textContent=s.targetExpiration||s.signal?.targetExpiration||s.expiration||'AUTO';$('latency').textContent=online?(s.telemetry?.latency!=null?`${Math.round(s.telemetry.latency)} ms`:`${age} ms`):'—';$('quality').textContent=online?`${quality||25}/100`:'—';
  $('feedMode').textContent=online?(structured?'ESTRUTURADO':ws?'WS / PROVISÓRIO':assetCount?'DOM / PROVISÓRIO':'MAPEANDO'):'OFFLINE';$('feedHealth').textContent=online?(structured?'ESTRUTURADO':ws?`WS ${ws} • ${assetCount} ativos`:assetCount?`${assetCount} ativos • DOM`:'MAPEANDO'):'OFFLINE';$('platformRail').textContent=online?platform.toUpperCase():'OFFLINE';$('feedRail').textContent=online?(structured?'ESTRUTURADO':ws?'MAPEANDO WS':assetCount?'DOM ATIVO':'AGUARDANDO'):'SEM DADOS';$('scannerRail').textContent=s.scanner==='scanning'?'ATIVO':'PARADO';$('telemetryHealth').textContent=licensed?(telemetryRecent?'SYNC':telemetryError?'ERRO':'CONECTANDO'):'AGUARDANDO';
  setDot('platformDot',online);setDot('feedDot',online&&(ws>0||assetCount>0||structured));setDot('scannerDot',s.scanner==='scanning');setDot('telemetryDot',telemetryRecent);
  connectBtn.classList.toggle('connecting',s.connection==='connecting'||requested);$('connectLabel').textContent=online?'RECONECTAR':s.connection==='connecting'||requested?'CONECTANDO...':'CONECTAR SCANNER';toggleBtn.disabled=!online||!licensed;toggleBtn.classList.toggle('active',s.scanner==='scanning');$('toggleLabel').textContent=s.scanner==='scanning'?'PAUSAR LEITURA':'INICIAR LEITURA';buyBtn.disabled=!online||!licensed;sellBtn.disabled=!online||!licensed;
  renderLicense(s);renderSignal(s);renderHistory(s);renderCatalog(s);if(s.tradeIntent?.status==='prepared'){const h=s.tradeIntent.handoff;$('manualStatus').textContent=h?.found?`${s.tradeIntent.direction} preparada • controle localizado e destacado na plataforma.`:`${s.tradeIntent.direction} preparada • confirme manualmente na plataforma.`}if(!online&&lastError)$('scannerHint').textContent=lastError
}
function tfMs(raw){const s=String(raw||'M1').toUpperCase();let m=s.match(/^S(\d+)$/);if(m)return Number(m[1])*1000;m=s.match(/^M(\d+)$/);if(m)return Number(m[1])*60000;m=s.match(/^H(\d+)$/);if(m)return Number(m[1])*3600000;return 60000}
function updateCountdown(){const tf=lastState.analysisTimeframe||lastState.signal?.timeframe||lastState.timeframe||'M1',ms=tfMs(tf),left=Math.max(0,Math.ceil(Date.now()/ms)*ms-Date.now()),sec=Math.ceil(left/1000),min=Math.floor(sec/60),rem=sec%60;$('entryCountdown').textContent=min?`${min}:${String(rem).padStart(2,'0')}`:`0:${String(rem).padStart(2,'0')}`}
async function getState(){
  const [state,stored]=await Promise.all([
    chrome.runtime.sendMessage({type:'ATS_GET_STATE'}).catch(()=>({})),
    chrome.storage.local.get(['atsTelemetryStatus',LAST_VALID_LICENSE_KEY]).catch(()=>({}))
  ]);
  const status=stored.atsTelemetryStatus||{},license=effectiveLicense(state?.license||{},stored[LAST_VALID_LICENSE_KEY]||null);
  render({...state,license,telemetry:{...(state?.telemetry||{}),...status}})
}
async function loadPrefs(){const{settings={}}=await chrome.storage.local.get('settings'),p=settings.scanPreferences||{};ensureOption(tfSelect,p.timeframe);ensureOption(expSelect,p.expiration);tfSelect.value=p.timeframe||'AUTO';expSelect.value=p.expiration||'AUTO'}
async function savePrefs(){const{settings={}}=await chrome.storage.local.get('settings');await chrome.storage.local.set({settings:{...settings,scanPreferences:{...(settings.scanPreferences||{}),timeframe:tfSelect.value,expiration:expSelect.value}}})}
async function ensureBackendPermission(){try{const origin=`${new URL(PUBLIC_API).origin}/*`,has=await chrome.permissions.contains({origins:[origin]});if(has)return{ok:true};const granted=await chrome.permissions.request({origins:[origin]});return{ok:granted,error:granted?null:'permission_denied'}}catch{return{ok:false,error:'invalid_backend_url'}}}
function connectionError(r={}){if(r.error==='platform_not_registered')return`A página aberta (${r.host||'host desconhecido'}) ainda não está cadastrada.`;if(r.error==='active_tab_unavailable')return'Não consegui acessar a aba atual.';return`Falha ao conectar: ${r.error||'erro desconhecido'}`}
connectBtn.addEventListener('click',async()=>{requested=true;lastError='';const r=await chrome.runtime.sendMessage({type:'ATS_CONNECT_ACTIVE_TAB'}).catch(e=>({ok:false,error:e?.message||String(e)}));requested=false;if(!r?.ok)lastError=connectionError(r);setTimeout(getState,250);setTimeout(getState,1200)});
toggleBtn.addEventListener('click',async()=>{const s=await chrome.runtime.sendMessage({type:'ATS_GET_STATE'}),r=await chrome.runtime.sendMessage({type:'ATS_SET_SCANNER',enabled:s.scanner!=='scanning'});if(!r?.ok&&r?.error==='license_required')$('licenseText').textContent='Ative uma licença válida para iniciar o scanner.';getState()});
async function prepare(direction){const r=await chrome.runtime.sendMessage({type:'ATS_PREPARE_TRADE',direction}).catch(e=>({ok:false,error:e?.message||String(e)}));$('manualStatus').textContent=!r?.ok?'Não foi possível preparar a ação. Verifique conexão e licença.':r.intent?.handoff?.found?`${direction} preparada e controle destacado na plataforma.`:`${direction} preparada. Confirme na plataforma.`;getState()}
buyBtn.addEventListener('click',()=>prepare('BUY'));sellBtn.addEventListener('click',()=>prepare('SELL'));
$('activateLicense').addEventListener('click',async()=>{const key=$('licenseKey').value.trim();$('licenseText').textContent='Validando licença e vinculando este aparelho...';const permission=await ensureBackendPermission();if(!permission.ok){$('licenseText').textContent='Permissão para acessar o backend não concedida.';return}const r=await chrome.runtime.sendMessage({type:'ATS_ACTIVATE_LICENSE',key}).catch(e=>({ok:false,error:String(e)}));$('licenseText').textContent=r.ok?'Licença ativada e aparelho vinculado com sucesso.':r.error==='license_not_found'?'Licença não encontrada.':r.error==='license_expired'?'Licença expirada.':r.error==='device_locked'||r.error==='device_limit_reached'?'Esta licença já está vinculada a outro aparelho.':r.error==='trial_limit_reached'?'O Trial já utilizou todos os sinais disponíveis.':r.error==='backend_unreachable'?'Servidor ATS indisponível no momento.':`Não foi possível ativar: ${r.error||'erro desconhecido'}`;getState()});
tfSelect.addEventListener('change',savePrefs);expSelect.addEventListener('change',savePrefs);$('settingsBtn').addEventListener('click',()=>chrome.runtime.openOptionsPage());chrome.storage.onChanged.addListener(c=>{if(c.scannerState||c.atsTelemetryStatus||c[LAST_VALID_LICENSE_KEY])getState();if(c.settings)loadPrefs()});
async function boot(){
  await loadPrefs();
  await getState();
  chrome.runtime.sendMessage({type:'ATS_VALIDATE_LICENSE'}).catch(()=>null).then(()=>getState());
}
boot();setInterval(getState,1000);setInterval(updateCountdown,250);