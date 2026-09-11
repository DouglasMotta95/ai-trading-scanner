const $=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)];
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmtDate=v=>v?new Date(v).toLocaleDateString('pt-BR'):'Sem expiração';
const ago=v=>{if(!v)return'—';const s=Math.max(0,Math.round((Date.now()-v)/1000));return s<60?`${s}s atrás`:s<3600?`${Math.floor(s/60)}min atrás`:`${Math.floor(s/3600)}h atrás`};
const currentOrigin=(location.protocol==='http:'||location.protocol==='https:')?location.origin:'http://localhost:8787';
let cfg={apiBase:sessionStorage.getItem('atsAdminApi')||currentOrigin,adminKey:sessionStorage.getItem('atsAdminKey')||''};
let plans=[],metrics={},licenses=[],clients=[],modalMode='license',activeTemplate='trial';

$('#apiBase').value=cfg.apiBase;
$('#adminKey').value=cfg.adminKey;

const api=async(path,opt={})=>{
  const r=await fetch(`${cfg.apiBase.replace(/\/$/,'')}${path}`,{...opt,headers:{'content-type':'application/json','x-admin-key':cfg.adminKey,...(opt.headers||{})}});
  const data=await r.json().catch(()=>({}));
  if(!r.ok)throw new Error(data.error||`HTTP ${r.status}`);
  return data;
};

function toast(msg){const el=$('#toast');el.textContent=msg;el.classList.add('show');clearTimeout(toast.t);toast.t=setTimeout(()=>el.classList.remove('show'),1800)}
function pageMeta(name){return({overview:['Visão geral','Controle de licenças, clientes e operação em um só lugar.'],licenses:['Licenças','Crie, controle, renove ou resete acessos da extensão.'],clients:['Clientes','Acompanhe dispositivos ativados e presença em tempo real.'],messages:['Mensagens','Modelos prontos e personalizáveis para enviar aos clientes.'],system:['Sistema','Saúde do backend e informações da infraestrutura.']})[name]||['Visão geral','Controle central.']}
function setPage(name){
  $$('[data-page]').forEach(b=>b.classList.toggle('active',b.dataset.page===name));
  $$('[data-view]').forEach(v=>v.classList.toggle('active',v.dataset.view===name));
  const [title,sub]=pageMeta(name);$('#pageTitle').textContent=title;$('#pageSub').textContent=sub;
  if(innerWidth<900)scrollTo({top:0,behavior:'smooth'});
}
$$('[data-page]').forEach(b=>b.onclick=()=>setPage(b.dataset.page));
$$('[data-page-jump]').forEach(b=>b.onclick=()=>setPage(b.dataset.pageJump));

function kpi(icon,label,value,hint='') {return `<article class="kpi"><span class="kpi-icon">${icon}</span><small>${esc(label)}</small><strong>${esc(value)}</strong><em>${esc(hint)}</em></article>`}
function renderOverview(){
  const m=metrics||{};
  $('#kpis').innerHTML=[
    kpi('🔑','Licenças ativas',m.activeLicenses??0,`${m.licenses??0} emitidas`),
    kpi('🎁','Testes ativos',m.activeTrials??0,'Trial em andamento'),
    kpi('●','Clientes online',m.licensedOnline??0,'último minuto'),
    kpi('◉','Scanners ativos',m.scanners??0,'em leitura'),
    kpi('↗','Sinais hoje',m.signalsToday??0,'consumo diário'),
    kpi('⛔','Bloqueadas',m.revokedLicenses??0,'licenças revogadas')
  ].join('');
  $('#navLicenseCount').textContent=m.activeLicenses??0;
  $('#navOnlineCount').textContent=m.licensedOnline??0;
  $('#platforms').innerHTML=(m.platforms||[]).length?(m.platforms||[]).map(p=>`<div class="stack-row"><div><b>${esc(p.name)}</b><small>plataforma observada</small></div><strong>${p.online} online</strong></div>`).join(''):'<div class="empty-state compact">Nenhuma plataforma com sessão ativa.</div>';
  $('#overviewActivity').innerHTML=`<div class="activity-grid"><div class="activity-card"><span>Clientes licenciados online</span><b>${m.licensedOnline??0}</b></div><div class="activity-card"><span>Scanners ativos</span><b>${m.scanners??0}</b></div><div class="activity-card"><span>Sinais consumidos hoje</span><b>${m.signalsToday??0}</b></div><div class="activity-card"><span>Instalações registradas</span><b>${m.installations??0}</b></div></div>`;
  $('#version').textContent=m.version||'—';
}
function renderPlans(){
  const html=plans.map(p=>`<div class="stack-row"><div><b>${esc(p.label)}</b><small>${p.deviceLimit} dispositivo${p.deviceLimit===1?'':'s'}</small></div><strong>${p.dailySignals==null?'ILIMITADO':`${p.dailySignals}/DIA`}</strong></div>`).join('');
  $('#planSummary').innerHTML=html||'<div class="empty-state compact">Nenhum plano configurado.</div>';
  $('#planCards').innerHTML=html;
  $('#licensePlan').innerHTML=plans.filter(p=>p.id!=='trial').map(p=>`<option value="${esc(p.id)}">${esc(p.label)} • ${p.dailySignals==null?'ilimitado':`${p.dailySignals} sinais/dia`}</option>`).join('');
}
function statusLabel(l){if(l.status==='revoked')return'REVOGADA';if(l.expiresAt&&Date.parse(l.expiresAt)<=Date.now())return'EXPIRADA';return'ATIVA'}
function licenseRows(list){
  if(!list.length)return'<div class="empty-state">Nenhuma licença encontrada.</div>';
  return `<div class="data-head"><span>Cliente</span><span>Plano</span><span>Uso</span><span>Expira</span><span>Status</span><span>Ações</span></div>`+list.map(l=>`<div class="data-row"><span class="identity"><b>${esc(l.customerName||'Sem nome')}</b><small>${esc(l.email||l.key)}</small></span><span>${esc(l.planLabel||l.plan)}</span><span>${l.usedToday}${l.dailyLimit==null?'':' / '+l.dailyLimit}</span><span>${esc(fmtDate(l.expiresAt))}</span><span><i class="status-dot ${l.status==='active'?'on':'off'}"></i>${statusLabel(l)}</span><span class="row-actions"><button class="mini-btn" data-copy-license="${esc(l.key)}">COPIAR</button><button class="mini-btn primary" data-reset-license="${esc(l.key)}">RESET</button><button class="mini-btn ${l.status==='active'?'danger':'primary'}" data-license-action="${esc(l.key)}" data-action="${l.status==='active'?'revoke':'activate'}">${l.status==='active'?'BLOQUEAR':'REATIVAR'}</button></span></div>`).join('');
}
function renderLicenses(){const q=($('#licenseSearch')?.value||'').trim().toLowerCase();const list=!q?licenses:licenses.filter(l=>[l.customerName,l.email,l.key,l.planLabel,l.plan].some(v=>String(v||'').toLowerCase().includes(q)));$('#licensesTable').innerHTML=licenseRows(list);bindLicenseActions();populateResetSelect()}
function bindLicenseActions(){
  $$('[data-copy-license]').forEach(b=>b.onclick=async()=>{await navigator.clipboard.writeText(b.dataset.copyLicense);toast('Licença copiada')});
  $$('[data-reset-license]').forEach(b=>b.onclick=()=>openResetFor(b.dataset.resetLicense));
  $$('[data-license-action]').forEach(b=>b.onclick=async()=>{const op=b.dataset.action,key=b.dataset.licenseAction;b.disabled=true;try{await api(`/v1/admin/licenses/${encodeURIComponent(key)}/${op}`,{method:'POST'});toast(op==='revoke'?'Licença bloqueada':'Licença reativada');await refreshData()}catch(e){toast(`Falha: ${e.message}`)}finally{b.disabled=false}});
}
function renderClients(){
  const q=($('#clientSearch')?.value||'').trim().toLowerCase();
  const list=!q?clients:clients.filter(c=>[c.customerName,c.email,c.licenseKey,c.planLabel,c.installationId].some(v=>String(v||'').toLowerCase().includes(q)));
  const online=clients.filter(x=>x.online).length;$('#onlineCount').textContent=`${online} ONLINE`;
  $('#clientsTable').innerHTML=list.length?`<div class="data-head"><span>Cliente</span><span>Plano</span><span>Versão</span><span>Última atividade</span><span>Status</span><span>Ações</span></div>${list.map(c=>`<div class="data-row"><span class="identity"><b>${esc(c.customerName||'Sem nome')}</b><small>${esc(c.licenseKey)}</small></span><span>${esc(c.planLabel||c.plan)}</span><span>${esc(c.version||'—')}</span><span>${esc(ago(c.lastSeen))}</span><span><i class="status-dot ${c.online?'on':'off'}"></i>${c.online?'ONLINE':'OFFLINE'}</span><span class="row-actions"><button class="mini-btn primary" data-reset-license="${esc(c.licenseKey)}">RESETAR</button></span></div>`).join('')}`:'<div class="empty-state">Nenhum dispositivo ativado.</div>';
  $$('[data-reset-license]').forEach(b=>b.onclick=()=>openResetFor(b.dataset.resetLicense));
}
function populateResetSelect(){const s=$('#resetLicense');if(!s)return;s.innerHTML=licenses.map(l=>`<option value="${esc(l.key)}">${esc(l.customerName||'Sem nome')} • ${esc(l.planLabel||l.plan)} • ${esc(l.key)}</option>`).join('')}

async function loadMetrics(){metrics=await api('/v1/admin/metrics');renderOverview()}
async function loadLicenses(){({licenses}=await api('/v1/admin/licenses'));renderLicenses()}
async function loadClients(){({clients}=await api('/v1/admin/clients'));renderClients()}
async function loadSystem(){
  const r=await fetch(`${cfg.apiBase.replace(/\/$/,'')}/health`),h=await r.json();
  $('#systemHealth').innerHTML=[['API',h.ok?'ONLINE':'OFFLINE'],['Autenticação admin',h.adminAuthConfigured?'ATIVA':'NÃO CONFIGURADA'],['Licenças carregadas',h.licenses??0],['Horário backend',new Date(h.time).toLocaleTimeString('pt-BR')]].map(([a,b])=>`<div class="health-row"><span>${esc(a)}</span><b>${esc(b)}</b></div>`).join('');
}
async function refreshData(){await Promise.all([loadMetrics(),loadLicenses(),loadClients(),loadSystem()])}

async function connect(){
  cfg={apiBase:$('#apiBase').value.trim().replace(/\/$/,''),adminKey:$('#adminKey').value.trim()};
  sessionStorage.setItem('atsAdminApi',cfg.apiBase);sessionStorage.setItem('atsAdminKey',cfg.adminKey);
  $('#connectMsg').textContent='Conectando...';
  try{
    const p=await api('/v1/admin/plans');plans=p.plans||[];renderPlans();await refreshData();
    $('#live').className='live';$('#live').innerHTML='<i></i><b>ONLINE</b>';$('#sideBackend').textContent='ONLINE';$('.sidebar-status').classList.add('online');
    $('#connectMsg').textContent='Painel conectado ao backend com dados reais.';toast('Backend conectado');
  }catch(e){$('#live').className='live off';$('#live').innerHTML='<i></i><b>OFFLINE</b>';$('#sideBackend').textContent='DESCONECTADO';$('.sidebar-status').classList.remove('online');$('#connectMsg').textContent=`Falha: ${e.message}`}
}

function daysText(l){if(!l.expiresAt)return'sem expiração';const days=Math.max(1,Math.ceil((Date.parse(l.expiresAt)-Date.now())/86400000));return`${days} dia${days===1?'':'s'}`}
function clientName(l){return String(l?.customerName||'').trim()||'Olá'}
function makeMessage(type,l={}){
  const name=clientName(l),key=l.key||'SUA-LICENÇA',plan=l.planLabel||l.plan||'Plano',limit=l.dailyLimit==null?'sem limite diário':`${l.dailyLimit} sinais por dia`,valid=daysText(l);
  if(type==='trial')return `🎁 *SEU TESTE GRÁTIS ESTÁ LIBERADO!*\n\n${name}, seu acesso ao *AI Trading Scanner* foi criado com sucesso.\n\n✅ Plano: ${plan}\n⏳ Validade: ${valid}\n📊 Limite: ${limit}\n\n🔑 *Sua licença:*\n${key}\n\nPara ativar, abra a extensão, cole a licença no campo de ativação e conecte o scanner à plataforma.\n\nAproveite o período de teste para conhecer todos os recursos. 🚀`;
  if(type==='renew')return `✅ *ACESSO RENOVADO!*\n\n${name}, sua licença do *AI Trading Scanner* foi renovada com sucesso.\n\n🔑 Licença: ${key}\n📦 Plano: ${plan}\n⏳ Validade: ${valid}\n\nSeu acesso continua liberado normalmente. 🚀`;
  if(type==='reset')return `♻️ *EXTENSÃO RESETADA!*\n\n${name}, o vínculo do seu *AI Trading Scanner* foi resetado com sucesso.\n\n🔑 Licença: ${key}\n\nAgora você pode abrir a extensão novamente e ativar o acesso no dispositivo. ✅`;
  return `🔑 *ACESSO LIBERADO!*\n\n${name}, sua licença do *AI Trading Scanner* já está ativa.\n\n✅ Plano: ${plan}\n⏳ Validade: ${valid}\n📊 Limite: ${limit}\n\n🔑 *Sua licença:*\n${key}\n\nAbra a extensão, cole o código acima e faça a ativação. 🚀`;
}
function renderTemplate(type){activeTemplate=type;$$('[data-template]').forEach(b=>b.classList.toggle('active',b.dataset.template===type));const sample=type==='trial'?{customerName:'Cliente',planLabel:'Trial',dailyLimit:3,expiresAt:new Date(Date.now()+3*86400000).toISOString(),key:'ATS-XXXXXX-XXXXXX-XXXX'}:{customerName:'Cliente',planLabel:'Pro',dailyLimit:20,expiresAt:new Date(Date.now()+30*86400000).toISOString(),key:'ATS-XXXXXX-XXXXXX-XXXX'};$('#messageEditor').value=makeMessage(type,sample)}
$$('[data-template]').forEach(b=>b.onclick=()=>renderTemplate(b.dataset.template));

function openModal(mode,key=''){
  modalMode=mode;const modal=$('#actionModal');modal.hidden=false;document.body.style.overflow='hidden';
  const config={license:['🔑','GERAR ACESSO','Nova licença','Escolha o plano e a validade do acesso.'],trial:['🎁','TESTE GRÁTIS','Criar teste grátis','Gere um acesso Trial e receba a mensagem pronta para enviar.'],reset:['♻','RESET DE ACESSO','Resetar cliente','Libere novamente o vínculo da extensão e zere o consumo diário.']}[mode];
  $('#modalIcon').textContent=config[0];$('#modalKicker').textContent=config[1];$('#modalTitle').textContent=config[2];$('#modalSub').textContent=config[3];
  $('#commonFields').hidden=mode==='reset';$('#licenseFields').hidden=mode!=='license';$('#trialFields').hidden=mode!=='trial';$('#resetFields').hidden=mode!=='reset';
  $('#submitAction').textContent=mode==='trial'?'GERAR TESTE GRÁTIS':mode==='reset'?'RESETAR CLIENTE':'GERAR LICENÇA';
  populateResetSelect();if(key&&$('#resetLicense'))$('#resetLicense').value=key;
}
function closeModal(){ $('#actionModal').hidden=true;document.body.style.overflow='' }
$$('[data-open]').forEach(b=>b.onclick=()=>openModal(b.dataset.open));
$$('[data-close-modal]').forEach(b=>b.onclick=closeModal);
function openResetFor(key){openModal('reset',key)}

function openResult(title,l,message){
  $('#resultTitle').textContent=title;$('#licenseResult').innerHTML=`<span>${esc(l.planLabel||l.plan||'ACESSO')}</span><strong>${esc(l.key||'')}</strong><small>${esc(l.customerName||'Cliente')} • ${esc(fmtDate(l.expiresAt))}${l.dailyLimit==null?'':' • '+l.dailyLimit+' sinais/dia'}</small>`;$('#resultMessage').value=message;$('#resultDrawer').hidden=false;
}
function closeDrawer(){$('#resultDrawer').hidden=true}
$('#closeDrawer').onclick=closeDrawer;
async function copyText(text){await navigator.clipboard.writeText(text);toast('Mensagem copiada')}
async function shareText(text){if(navigator.share){try{await navigator.share({text})}catch{}}else await copyText(text)}
$('#copyResult').onclick=()=>copyText($('#resultMessage').value);
$('#shareResult').onclick=()=>shareText($('#resultMessage').value);
$('#copyMessage').onclick=()=>copyText($('#messageEditor').value);
$('#shareMessage').onclick=()=>shareText($('#messageEditor').value);

$('#actionForm').onsubmit=async e=>{
  e.preventDefault();const btn=$('#submitAction');btn.disabled=true;
  try{
    if(modalMode==='reset'){
      const key=$('#resetLicense').value;if(!key)throw new Error('Selecione uma licença');
      const r=await api(`/v1/admin/licenses/${encodeURIComponent(key)}/reset`,{method:'POST'});closeModal();openResult('Cliente resetado',r.license,makeMessage('reset',r.license));toast('Cliente resetado');
    }else if(modalMode==='trial'){
      const r=await api('/v1/admin/trials',{method:'POST',body:JSON.stringify({customerName:$('#customerName').value.trim(),email:$('#customerEmail').value.trim(),days:Number($('#trialDays').value)||3})});closeModal();openResult('Teste grátis gerado',r.license,makeMessage('trial',r.license));toast('Teste grátis criado');
    }else{
      const r=await api('/v1/admin/licenses',{method:'POST',body:JSON.stringify({customerName:$('#customerName').value.trim(),email:$('#customerEmail').value.trim(),plan:$('#licensePlan').value,days:Number($('#licenseDays').value)||30})});closeModal();openResult('Licença gerada',r.license,makeMessage('license',r.license));toast('Licença criada');
    }
    await refreshData();
  }catch(err){toast(`Falha: ${err.message}`)}finally{btn.disabled=false}
};

$('#connect').onclick=connect;
$('#refreshAll').onclick=()=>refreshData().then(()=>toast('Painel atualizado')).catch(e=>toast(`Falha: ${e.message}`));
$('#refreshLicenses').onclick=()=>refreshData().catch(e=>toast(`Falha: ${e.message}`));
$('#licenseSearch').addEventListener('input',renderLicenses);
$('#clientSearch').addEventListener('input',renderClients);
renderTemplate('trial');renderOverview();
if(cfg.adminKey)connect();
