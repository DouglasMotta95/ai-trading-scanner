const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const apiBase = location.origin;
let metrics = {}, plans = [], licenses = [], clients = [], auditEvents = [];
let licenseFilter = 'all', selectedLicenseKey = '', modalMode = 'trial', activeTemplate = 'trial';

const api = async (path, opt = {}) => {
  const r = await fetch(`${apiBase}${path}`, {
    credentials: 'include',
    ...opt,
    headers: {'content-type':'application/json', ...(opt.headers || {})}
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(data.error || `HTTP ${r.status}`);
    err.status = r.status;
    throw err;
  }
  return data;
};
const toast = msg => {
  const el = $('#toast'); el.textContent = msg; el.classList.add('show');
  clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove('show'), 1900);
};
const fmtDate = v => v ? new Date(v).toLocaleDateString('pt-BR') : 'Sem expiração';
const fmtTime = v => v ? new Date(v).toLocaleTimeString('pt-BR', {hour:'2-digit', minute:'2-digit'}) : '—';
const ago = v => {
  if (!v) return '—';
  const s = Math.max(0, Math.floor((Date.now() - v) / 1000));
  if (s < 60) return `${s}s atrás`;
  if (s < 3600) return `${Math.floor(s / 60)}min atrás`;
  if (s < 86400) return `${Math.floor(s / 3600)}h atrás`;
  return `${Math.floor(s / 86400)}d atrás`;
};
const remainingDays = l => {
  if (!l?.expiresAt) return null;
  return Math.max(0, Math.ceil((Date.parse(l.expiresAt) - Date.now()) / 86400000));
};
const statusOf = l => {
  if (l.status === 'revoked') return 'blocked';
  if (l.expiresAt && Date.parse(l.expiresAt) <= Date.now()) return 'expired';
  return 'active';
};
const statusLabel = l => ({active:'ATIVA', blocked:'BLOQUEADA', expired:'EXPIRADA'})[statusOf(l)];

function pageMeta(name) {
  return ({
    dashboard:['Central de controle','Ações rápidas, licenças e clientes em um único painel.'],
    licenses:['Licenças','Busque, filtre e gerencie cada acesso em poucos toques.'],
    clients:['Clientes','Dispositivos conectados e presença em tempo real.'],
    messages:['Mensagens','Modelos automáticos para enviar ao cliente.'],
    operations:['Operação ao vivo','Extensões online, scanners, heartbeat, sinais e resultados observados.'],
    system:['Sistema','Sessão administrativa, backend e versão ativa.']
  })[name] || ['Central de controle',''];
}
function setPage(name) {
  $$('[data-page]').forEach(b => b.classList.toggle('active', b.dataset.page === name));
  $$('[data-view]').forEach(v => v.classList.toggle('active', v.dataset.view === name));
  const [title, sub] = pageMeta(name); $('#pageTitle').textContent = title; $('#pageSub').textContent = sub;
  if (name === 'operations') loadOperations(true);
  if (innerWidth < 900) scrollTo({top:0, behavior:'smooth'});
}
$$('[data-page]').forEach(b => b.onclick = () => setPage(b.dataset.page));
$$('[data-page-jump]').forEach(b => b.onclick = () => setPage(b.dataset.pageJump));

function metric(icon, label, value, hint, tone='') {
  return `<article class="metric ${tone}"><span class="metric-icon">${icon}</span><small>${esc(label)}</small><strong>${esc(value)}</strong><em>${esc(hint)}</em></article>`;
}
function renderMetrics() {
  $('#metricGrid').innerHTML = [
    metric('🔑','Licenças ativas',metrics.activeLicenses ?? 0,`${metrics.licenses ?? 0} emitidas`),
    metric('🎁','Testes ativos',metrics.activeTrials ?? 0,'Trial em andamento'),
    metric('●','Clientes online',metrics.licensedOnline ?? 0,'último minuto'),
    metric('◉','Scanners ativos',metrics.scanners ?? 0,'em leitura'),
    metric('↗','Sinais hoje',metrics.signalsToday ?? 0,'consumo dos planos'),
    metric('⚠','Vencendo em 3 dias',metrics.expiringSoon ?? 0,'pedem renovação')
  ].join('');
  $('#buildVersion').textContent = metrics.version || '—';
}
function renderPlans() {
  $('#planStrip').innerHTML = plans.map(p => `<div class="plan-card"><b>${esc(p.label)}</b><span>${p.dailySignals == null ? 'ILIMITADO' : `${p.dailySignals} SINAIS/DIA`}</span><small>${p.deviceLimit} dispositivo${p.deviceLimit === 1 ? '' : 's'}</small></div>`).join('') || '<div class="empty-panel">Nenhum plano configurado.</div>';
  $('#licensePlan').innerHTML = plans.filter(p => p.id !== 'trial').map(p => `<option value="${esc(p.id)}">${esc(p.label)} • ${p.dailySignals == null ? 'ilimitado' : `${p.dailySignals}/dia`}</option>`).join('');
}
function renderRecent() {
  const list = licenses.slice(0, 5);
  $('#recentLicenses').innerHTML = list.length ? list.map(l => `<button class="compact-row" data-open-license="${esc(l.key)}"><span class="identity"><b>${esc(l.customerName || 'Sem nome')}</b><small>${esc(l.planLabel)} • ${esc(l.key)}</small></span><span class="right"><b>${statusLabel(l)}</b><small>${esc(fmtDate(l.expiresAt))}</small></span></button>`).join('') : '<div class="empty-panel">Nenhuma licença gerada ainda.</div>';
  $$('[data-open-license]').forEach(b => b.onclick = () => { selectedLicenseKey = b.dataset.openLicense; setPage('licenses'); renderLicenses(); renderInspector(); });
}
const auditText = e => ({trial_created:'Teste grátis criado',license_created:'Licença criada',license_renewed:'Licença renovada',license_revoked:'Licença bloqueada',license_activated:'Licença reativada',license_reset_full:'Cliente resetado',license_reset_devices:'Dispositivos resetados',license_reset_usage:'Consumo resetado',admin_login:'Acesso ao painel'})[e.action] || String(e.action || 'Ação administrativa').replaceAll('_',' ');
function renderAudit() {
  $('#auditList').innerHTML = auditEvents.length ? auditEvents.slice(0, 7).map(e => `<div class="timeline-row"><i></i><div><b>${esc(auditText(e))}</b><small>${esc(e.customerName || e.licenseKey || 'Admin')}</small></div><time>${esc(fmtTime(e.at))}</time></div>`).join('') : '<div class="empty-panel">As ações do painel aparecerão aqui.</div>';
}
function renderLicenseSelects() {
  const options = licenses.map(l => `<option value="${esc(l.key)}">${esc(l.customerName || 'Sem nome')} • ${esc(l.planLabel)} • ${esc(l.key)}</option>`).join('');
  $('#resetLicense').innerHTML = options;
  $('#renewLicense').innerHTML = options;
}
function filteredLicenses() {
  const q = ($('#licenseSearch').value || '').trim().toLowerCase();
  return licenses.filter(l => {
    const matchText = !q || [l.customerName,l.email,l.key,l.plan,l.planLabel].some(v => String(v || '').toLowerCase().includes(q));
    if (!matchText) return false;
    const status = statusOf(l);
    if (licenseFilter === 'all') return true;
    if (licenseFilter === 'trial') return l.plan === 'trial';
    if (licenseFilter === 'active') return status === 'active';
    if (licenseFilter === 'expired') return status === 'expired';
    if (licenseFilter === 'blocked') return status === 'blocked';
    return true;
  });
}
function renderLicenses() {
  const list = filteredLicenses(); $('#licenseCount').textContent = list.length;
  $('#licensesList').innerHTML = list.length ? list.map(l => {
    const status = statusOf(l), days = remainingDays(l);
    return `<button class="license-item ${selectedLicenseKey === l.key ? 'active' : ''}" data-license-key="${esc(l.key)}"><span class="license-main"><b>${esc(l.customerName || 'Sem nome')}</b><small>${esc(l.key)}</small><span class="license-meta"><i class="pill ${status === 'active' ? 'on' : 'off'}">${statusLabel(l)}</i><i class="pill ${l.plan === 'trial' ? 'trial' : ''}">${esc(l.planLabel)}</i><i class="pill">${l.usedToday}${l.dailyLimit == null ? '' : `/${l.dailyLimit}`} hoje</i></span></span><span class="license-side"><strong>${days == null ? '∞' : `${days}d`}</strong><small>${esc(fmtDate(l.expiresAt))}</small></span></button>`;
  }).join('') : '<div class="empty-panel">Nenhuma licença encontrada neste filtro.</div>';
  $$('[data-license-key]').forEach(b => b.onclick = () => { selectedLicenseKey = b.dataset.licenseKey; renderLicenses(); renderInspector(); });
  if (!selectedLicenseKey && list[0]) { selectedLicenseKey = list[0].key; renderInspector(); }
}
function renderInspector() {
  const l = licenses.find(x => x.key === selectedLicenseKey);
  if (!l) { $('#licenseInspector').innerHTML = '<div class="empty-panel">Selecione uma licença para ver detalhes e ações.</div>'; return; }
  const days = remainingDays(l), status = statusOf(l);
  $('#licenseInspector').innerHTML = `<div class="inspect-head"><div><span class="eyebrow">DETALHES</span><b>${esc(l.customerName || 'Sem nome')}</b><small>${esc(l.email || 'Sem e-mail')}</small></div><span class="pill ${status === 'active' ? 'on' : 'off'}">${statusLabel(l)}</span></div><div class="inspect-key">${esc(l.key)}</div><div class="inspect-grid"><div class="inspect-stat"><span>PLANO</span><b>${esc(l.planLabel)}</b></div><div class="inspect-stat"><span>VALIDADE</span><b>${days == null ? 'Sem limite' : `${days} dias`}</b></div><div class="inspect-stat"><span>USO HOJE</span><b>${l.usedToday}${l.dailyLimit == null ? '' : ` / ${l.dailyLimit}`}</b></div><div class="inspect-stat"><span>DISPOSITIVOS</span><b>${l.devices} / ${l.deviceLimit}</b></div></div><div class="inspect-actions"><button class="btn secondary" id="copyKeyAction">COPIAR LICENÇA</button><button class="btn primary" id="resetAction">RESETAR</button><button class="btn secondary" id="renewAction">RENOVAR</button><button class="btn secondary" id="toggleAction">${l.status === 'active' ? 'BLOQUEAR' : 'REATIVAR'}</button></div>`;
  $('#copyKeyAction').onclick = () => copyText(l.key, 'Licença copiada');
  $('#resetAction').onclick = () => openModal('reset', l.key);
  $('#renewAction').onclick = () => openModal('renew', l.key);
  $('#toggleAction').onclick = async () => {
    const op = l.status === 'active' ? 'revoke' : 'activate';
    if (op === 'revoke' && !confirm(`Bloquear a licença de ${l.customerName || l.email || l.key}?`)) return;
    try { await api(`/v1/admin/licenses/${encodeURIComponent(l.key)}/${op}`, {method:'POST'}); toast(op === 'revoke' ? 'Licença bloqueada' : 'Licença reativada'); await refreshData(); }
    catch (e) { toast(`Falha: ${e.message}`); }
  };
}
function renderClients() {
  const q = ($('#clientSearch').value || '').trim().toLowerCase();
  const list = clients.filter(c => !q || [c.customerName,c.email,c.licenseKey,c.planLabel,c.installationId].some(v => String(v || '').toLowerCase().includes(q)));
  const online = clients.filter(c => c.online).length; $('#onlineBadge').textContent = `${online} ONLINE`;
  $('#clientsGrid').innerHTML = list.length ? list.map(c => `<article class="client-card"><div class="client-top"><div><b>${esc(c.customerName || 'Sem nome')}</b><small>${esc(c.licenseKey)}</small></div><span class="online-dot ${c.online ? 'on' : ''}">${c.online ? 'ONLINE' : 'OFFLINE'}</span></div><div class="client-meta"><div><span>PLANO</span><b>${esc(c.planLabel || c.plan)}</b></div><div><span>VERSÃO</span><b>${esc(c.version || '—')}</b></div><div><span>ÚLTIMA ATIVIDADE</span><b>${esc(ago(c.lastSeen))}</b></div><div><span>DISPOSITIVO</span><b>${esc(String(c.installationId || '').slice(0, 10) || '—')}</b></div></div><div class="client-actions"><button class="btn primary full" data-client-reset="${esc(c.licenseKey)}">RESETAR EXTENSÃO</button></div></article>`).join('') : '<div class="empty-panel">Nenhum dispositivo encontrado.</div>';
  $$('[data-client-reset]').forEach(b => b.onclick = () => openModal('reset', b.dataset.clientReset));
}
function renderSystem(health, authStatus) {
  $('#systemHealth').innerHTML = [['API',health.ok ? 'ONLINE' : 'OFFLINE'],['Autenticação',health.adminAuthConfigured ? 'ATIVA' : 'NÃO CONFIGURADA'],['Licenças carregadas',health.licenses ?? 0],['Backend',health.version || metrics.version || '—']].map(([a,b]) => `<div class="system-row"><span>${esc(a)}</span><b>${esc(b)}</b></div>`).join('');
  const product = $('#productReadiness');
  if (product) product.innerHTML = [
    ['Extensão publicada', health.extensionLatestVersion ? `v${health.extensionLatestVersion}` : '—'],
    ['Download oficial', health.extensionDownloadConfigured ? 'ATIVO' : 'PENDENTE'],
    ['E-mail', health.emailDeliveryConfigured ? 'ATIVO' : 'PENDENTE'],
    ['Pagamento', health.paymentsConfigured ? 'ATIVO' : 'PENDENTE'],
    ['Login Google', health.googleConfigured ? 'ATIVO' : 'PENDENTE']
  ].map(([a,b]) => `<div class="system-row"><span>${esc(a)}</span><b>${esc(b)}</b></div>`).join('');
  $('#sessionInfo').textContent = `Sessão segura lembrada por até ${authStatus.sessionDays || 30} dias.`;
}

async function refreshData() {
  const tasks = [
    api('/v1/admin/metrics'), api('/v1/admin/plans'), api('/v1/admin/licenses'), api('/v1/admin/clients'), api('/v1/admin/audit'), fetch(`${apiBase}/health`).then(r => r.json()), api('/v1/admin/auth/status')
  ];
  const settled = await Promise.allSettled(tasks);
  const failures = settled.filter(x => x.status === 'rejected').map(x => x.reason);
  if (failures.some(e => e?.status === 401)) return showLogin();
  const value = i => settled[i].status === 'fulfilled' ? settled[i].value : null;
  const m=value(0),p=value(1),l=value(2),c=value(3),a=value(4),h=value(5),s=value(6);
  if(m)metrics=m;if(p)plans=p.plans||[];if(l)licenses=l.licenses||[];if(c)clients=c.clients||[];if(a)auditEvents=a.events||[];
  renderMetrics(); renderPlans(); renderRecent(); renderAudit(); renderLicenseSelects(); renderLicenses(); renderInspector(); renderClients();
  if(h&&s)renderSystem(h,s);
  if(failures.length) toast(`Atualização parcial: ${failures.length} fonte${failures.length===1?'':'s'} indisponível${failures.length===1?'':'is'}.`);
}

function showLogin() { $('#authGate').hidden = false; $('#loginKey').focus(); }
function hideLogin() { $('#authGate').hidden = true; }
async function loginWithKey(key) {
  const r = await fetch(`${apiBase}/v1/admin/auth/login`, {method:'POST', credentials:'include', headers:{'content-type':'application/json'}, body:JSON.stringify({adminKey:key})});
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'Chave inválida');
  sessionStorage.removeItem('atsAdminKey');
  return data;
}
async function bootstrapAuth() {
  try { await api('/v1/admin/auth/status'); hideLogin(); await refreshData(); return; }
  catch {}
  const legacyKey = sessionStorage.getItem('atsAdminKey');
  if (legacyKey) {
    try { await loginWithKey(legacyKey); hideLogin(); await refreshData(); return; } catch {}
  }
  showLogin();
}
$('#loginBtn').onclick = async () => {
  const key = $('#loginKey').value.trim(); if (!key) return;
  $('#loginBtn').disabled = true; $('#loginMsg').textContent = 'Validando acesso...';
  try { const r = await loginWithKey(key); $('#loginKey').value = ''; $('#loginMsg').textContent = `Dispositivo lembrado por ${r.expiresInDays || 30} dias.`; hideLogin(); toast('Acesso liberado'); await refreshData(); }
  catch (e) { $('#loginMsg').textContent = 'Chave inválida. Confira e tente novamente.'; }
  finally { $('#loginBtn').disabled = false; }
};
$('#loginKey').addEventListener('keydown', e => { if (e.key === 'Enter') $('#loginBtn').click(); });
async function logout() { try { await api('/v1/admin/auth/logout', {method:'POST'}); } catch {} showLogin(); }
$('#logoutBtn').onclick = logout; $('#logoutBtn2').onclick = logout;

function messageFor(type, l = {}) {
  const name = String(l.customerName || '').trim() || 'Cliente';
  const key = l.key || $('#msgKey').value.trim() || 'SUA-LICENÇA';
  const plan = l.planLabel || l.plan || $('#msgPlan').value.trim() || 'Plano';
  const limit = l.dailyLimit == null ? 'sem limite diário' : `${l.dailyLimit} sinais por dia`;
  const days = remainingDays(l); const validity = days == null ? 'sem expiração' : `${days} dia${days === 1 ? '' : 's'}`;
  if (type === 'trial') return `🎁 *TESTE GRÁTIS LIBERADO!*\n\nOlá, ${name}! Seu acesso de teste ao *AI Trading Scanner* foi criado.\n\n✅ Plano: ${plan}\n⏳ Validade: ${validity}\n📊 Limite: ${limit}\n\n🔑 *Licença:*\n${key}\n\nAbra a extensão, cole a licença e conecte o scanner à plataforma. Aproveite o teste! 🚀`;
  if (type === 'renew') return `✅ *ACESSO RENOVADO!*\n\nOlá, ${name}! Sua licença do *AI Trading Scanner* foi renovada com sucesso.\n\n🔑 Licença: ${key}\n📦 Plano: ${plan}\n⏳ Validade atual: ${validity}\n\nSeu acesso continua liberado normalmente. 🚀`;
  if (type === 'reset') return `♻️ *EXTENSÃO LIBERADA NOVAMENTE!*\n\nOlá, ${name}! O reset do seu *AI Trading Scanner* foi concluído.\n\n🔑 Licença: ${key}\n\nOs vínculos anteriores foram limpos e você já pode ativar a extensão novamente. ✅`;
  if (type === 'blocked') return `⛔ *ACESSO TEMPORARIAMENTE BLOQUEADO*\n\nOlá, ${name}. A licença ${key} do *AI Trading Scanner* está bloqueada no momento.\n\nSe o acesso já deveria estar liberado, entre em contato para conferirmos a situação.`;
  return `🔑 *AI TRADING SCANNER LIBERADO!*\n\nOlá, ${name}! Seu acesso foi ativado com sucesso.\n\n✅ Plano: ${plan}\n⏳ Validade: ${validity}\n📊 Limite: ${limit}\n\n🔑 *Licença:*\n${key}\n\nAbra a extensão, cole o código acima e faça a ativação. 🚀`;
}
function sampleFor(type) {
  return type === 'trial' ? {customerName:$('#msgName').value || 'Cliente', key:$('#msgKey').value || 'ATS-XXXXXX-XXXXXX-XXXX', planLabel:$('#msgPlan').value || 'Trial', dailyLimit:3, expiresAt:new Date(Date.now()+3*86400000).toISOString()} : {customerName:$('#msgName').value || 'Cliente', key:$('#msgKey').value || 'ATS-XXXXXX-XXXXXX-XXXX', planLabel:$('#msgPlan').value || 'Pro', dailyLimit:20, expiresAt:new Date(Date.now()+30*86400000).toISOString()};
}
function renderTemplate(type) { activeTemplate = type; $$('[data-template]').forEach(b => b.classList.toggle('active', b.dataset.template === type)); $('#messageEditor').value = messageFor(type, sampleFor(type)); }
$$('[data-template]').forEach(b => b.onclick = () => renderTemplate(b.dataset.template));
['msgName','msgKey','msgPlan'].forEach(id => $(`#${id}`).addEventListener('input', () => renderTemplate(activeTemplate)));

function openModal(mode, key='') {
  modalMode = mode; $('#actionModal').hidden = false; document.body.style.overflow = 'hidden';
  const cfg = {
    trial:['🎁','TESTE GRÁTIS','Gerar teste grátis','Cria o Trial e monta a mensagem pronta para enviar.','GERAR TESTE GRÁTIS'],
    license:['🔑','NOVA LICENÇA','Gerar licença','Escolha o plano e a validade do cliente.','GERAR LICENÇA'],
    reset:['♻','RESET DE CLIENTE','Resetar extensão','Limpa dispositivos, zera o uso de hoje e reativa a licença.','RESETAR CLIENTE'],
    renew:['↻','RENOVAÇÃO','Renovar acesso','Adicione dias à validade e reative o acesso.','RENOVAR ACESSO']
  }[mode];
  $('#modalIcon').textContent = cfg[0]; $('#modalKicker').textContent = cfg[1]; $('#modalTitle').textContent = cfg[2]; $('#modalDescription').textContent = cfg[3]; $('#submitActionBtn').textContent = cfg[4];
  $('#customerFields').hidden = !['trial','license'].includes(mode); $('#trialFields').hidden = mode !== 'trial'; $('#licenseFields').hidden = mode !== 'license'; $('#resetFields').hidden = mode !== 'reset'; $('#renewFields').hidden = mode !== 'renew';
  renderLicenseSelects(); if (key && mode === 'reset') $('#resetLicense').value = key; if (key && mode === 'renew') $('#renewLicense').value = key;
  setTimeout(() => { if (!$('#customerFields').hidden) $('#customerName').focus(); }, 50);
}
function closeModal() { $('#actionModal').hidden = true; document.body.style.overflow = ''; }
$$('[data-action-open]').forEach(b => b.onclick = () => openModal(b.dataset.actionOpen));
$$('[data-close-modal]').forEach(b => b.onclick = closeModal);

function showResult(title, l, type) {
  $('#resultTitle').textContent = title;
  $('#resultLicense').innerHTML = `<span>LICENÇA</span><strong>${esc(l.key)}</strong><small>${esc(l.planLabel)} • ${esc(fmtDate(l.expiresAt))} • ${l.dailyLimit == null ? 'ilimitado' : `${l.dailyLimit} sinais/dia`}</small>`;
  $('#resultMessage').value = messageFor(type, l); $('#resultSheet').hidden = false;
}
$('#closeResult').onclick = () => $('#resultSheet').hidden = true;

$('#actionForm').onsubmit = async e => {
  e.preventDefault(); const btn = $('#submitActionBtn'); btn.disabled = true;
  try {
    let r, type = 'license', title = 'Acesso gerado';
    if (modalMode === 'trial') {
      r = await api('/v1/admin/trials', {method:'POST', body:JSON.stringify({customerName:$('#customerName').value.trim(), email:$('#customerEmail').value.trim(), days:Number($('#trialDays').value) || 3})}); type = 'trial'; title = 'Teste grátis gerado';
    } else if (modalMode === 'license') {
      r = await api('/v1/admin/licenses', {method:'POST', body:JSON.stringify({customerName:$('#customerName').value.trim(), email:$('#customerEmail').value.trim(), plan:$('#licensePlan').value, days:Number($('#licenseDays').value) || 30})}); type = 'license'; title = 'Licença gerada';
    } else if (modalMode === 'reset') {
      const key = $('#resetLicense').value; r = await api(`/v1/admin/licenses/${encodeURIComponent(key)}/reset`, {method:'POST'}); type = 'reset'; title = 'Cliente resetado';
    } else {
      const key = $('#renewLicense').value; r = await api(`/v1/admin/licenses/${encodeURIComponent(key)}/renew`, {method:'POST', body:JSON.stringify({days:Number($('#renewDays').value) || 30})}); type = 'renew'; title = 'Acesso renovado';
    }
    closeModal(); showResult(title, r.license, type); toast(title); $('#customerName').value = ''; $('#customerEmail').value = ''; await refreshData();
  } catch (err) { toast(`Falha: ${err.message}`); }
  finally { btn.disabled = false; }
};

async function copyText(text, ok='Copiado') { try { await navigator.clipboard.writeText(text); toast(ok); } catch { toast('Não foi possível copiar'); } }
async function shareText(text) { if (navigator.share) { try { await navigator.share({text}); return; } catch {} } await copyText(text, 'Mensagem copiada'); }
$('#copyResultBtn').onclick = () => copyText(`${$('#resultLicense').innerText}\n\n${$('#resultMessage').value}`, 'Licença e mensagem copiadas');
$('#shareResultBtn').onclick = () => shareText($('#resultMessage').value);
$('#copyMessageBtn').onclick = () => copyText($('#messageEditor').value, 'Mensagem copiada');
$('#shareMessageBtn').onclick = () => shareText($('#messageEditor').value);
$('#refreshBtn').onclick = () => refreshData().then(() => toast('Painel atualizado'));
$('#licenseSearch').addEventListener('input', renderLicenses); $('#clientSearch').addEventListener('input', renderClients);
$$('[data-license-filter]').forEach(b => b.onclick = () => { licenseFilter = b.dataset.licenseFilter; $$('[data-license-filter]').forEach(x => x.classList.toggle('active', x === b)); selectedLicenseKey = ''; renderLicenses(); renderInspector(); });

const operationState = {summary:{}, sessions:[], signals:[], events:[]};
let operationBusy = false;
let operationFilter = 'all';
function operationStateLabel(s) {
  const state = String(s.signalState || '').toUpperCase();
  if (state === 'CONFIRM') return 'ENTRADA CONFIRMADA';
  if (state === 'WATCH') return 'ACOMPANHANDO';
  if (state === 'SEARCHING') return 'ANALISANDO';
  if (state === 'NO_TRADE') return 'NÃO ENTRAR';
  if (state === 'WAIT') return 'AGUARDANDO';
  return state || 'SEM ESTADO';
}
function operationTone(s) {
  const state = String(s.signalState || '').toUpperCase();
  if (state === 'CONFIRM') return s.direction === 'SELL' ? 'sell' : 'buy';
  if (state === 'WATCH') return 'watch';
  if (state === 'NO_TRADE') return 'blocked';
  return 'neutral';
}
const outcomeLabel = v => ({win:'WIN',loss:'LOSS',draw:'EMPATE',pending:'PENDENTE',unknown:'INDEFINIDO'})[v] || String(v || 'PENDENTE').toUpperCase();
function renderOperations() {
  const summary = operationState.summary || {};
  const accuracy = summary.observedAccuracy == null ? '—' : `${summary.observedAccuracy}%`;
  const summaryRoot = $('#liveSummary');
  if (summaryRoot) summaryRoot.innerHTML = [
    ['●','CLIENTES ONLINE',summary.onlineClients ?? 0,'heartbeat nos últimos 20s','green'],
    ['◉','SCANNERS ATIVOS',summary.scanningClients ?? 0,'leitura em execução','blue'],
    ['↗','SINAIS CONFIRMADOS',summary.confirmedSignals ?? 0,`${summary.pendingSignals ?? 0} aguardando resultado`,'violet'],
    ['✓','ACERTO OBSERVADO',accuracy,`${summary.wins ?? 0} win • ${summary.losses ?? 0} loss`,'gold']
  ].map(([icon,label,value,hint,tone]) => `<article class="live-kpi ${tone}"><span>${icon}</span><small>${label}</small><strong>${esc(value)}</strong><em>${esc(hint)}</em></article>`).join('');

  const sessions = operationState.sessions || [];
  if ($('#liveClientCount')) $('#liveClientCount').textContent = `${sessions.filter(x => x.online).length} ONLINE`;
  if ($('#liveSessions')) $('#liveSessions').innerHTML = sessions.length ? sessions.map(s => `<article class="live-session ${s.online ? 'online' : 'offline'}">
    <div class="live-session-main"><span class="presence"><i></i>${s.online ? 'ONLINE' : `OFFLINE • ${esc(ago(s.lastSeen))}`}</span><div><b>${esc(s.customerName || 'Cliente')}</b><small>${esc(s.platformName || s.platformId || 'Plataforma')} • ${esc(s.asset || 'sem ativo')}</small></div></div>
    <div class="live-session-signal"><span class="live-state ${operationTone(s)}">${esc(operationStateLabel(s))}</span><strong>${s.direction ? esc(s.direction) : '—'}${s.score == null ? '' : ` • ${Math.round(Number(s.score))}`}</strong><small>${esc(s.timeframe || 'AUTO')} • ${esc(s.expiration || 'AUTO')}</small></div>
    <div class="live-session-feed"><span>FEED</span><b>${s.feedQuality == null ? '—' : `${Math.round(Number(s.feedQuality))}%`}</b><small>${s.structured ? 'ESTRUTURADO' : 'PROVISÓRIO'} • heartbeat ${esc(ago(s.lastSeen))}</small></div>
    <button class="live-client-open" data-live-license="${esc(s.licenseKey || '')}">VER CLIENTE</button>
  </article>`).join('') : '<div class="attention-empty">Nenhuma extensão enviou heartbeat ainda.</div>';
  $$('[data-live-license]').forEach(btn => btn.onclick = () => { selectedLicenseKey = btn.dataset.liveLicense; setPage('licenses'); renderLicenses(); renderInspector(); });

  const allSignals = operationState.signals || [];
  const signals = operationFilter === 'all' ? allSignals : allSignals.filter(x => x.outcome === operationFilter);
  if ($('#liveSignals')) $('#liveSignals').innerHTML = signals.length ? signals.map(s => `<article class="live-signal-row">
    <div class="signal-identity"><span class="direction ${s.direction === 'SELL' ? 'sell' : 'buy'}">${esc(s.direction || '—')}</span><div><b>${esc(s.asset || '—')}</b><small>${esc(s.customerName || 'Cliente')} • ${esc(s.platformName || s.platformId || 'Plataforma')}</small></div></div>
    <div><span>ENTRADA</span><b>${esc(s.entryPrice ?? '—')}</b><small>${fmtTime(s.entryAt)}</small></div>
    <div><span>EXPIRAÇÃO</span><b>${esc(s.expiration || s.timeframe || '—')}</b><small>${fmtTime(s.expiresAt)}</small></div>
    <div><span>SCORE</span><b>${Math.round(Number(s.score || 0))}</b><small>${esc(s.confirmations || s.grade || '—')}</small></div>
    <div><span>SAÍDA</span><b>${s.exitPrice == null ? '—' : esc(s.exitPrice)}</b><small>${s.resolvedAt ? fmtTime(s.resolvedAt) : 'aguardando'}</small></div>
    <em class="outcome ${esc(s.outcome || 'pending')}">${esc(outcomeLabel(s.outcome))}</em>
  </article>`).join('') : '<div class="attention-empty">Nenhum sinal neste filtro.</div>';

  const events = operationState.events || [];
  if ($('#liveEventCount')) $('#liveEventCount').textContent = events.length;
  if ($('#liveEvents')) $('#liveEvents').innerHTML = events.length ? events.slice(0,30).map(e => {
    const d = e.data || {};
    const labels = {scanner_started:'Scanner iniciado',scanner_stopped:'Scanner pausado',platform_connected:'Plataforma conectada',signal_confirmed:'Entrada confirmada',signal_state:'Estado do sinal alterado',license_activated:'Licença ativada'};
    return `<div class="live-event"><i></i><div><b>${esc(labels[e.type] || e.type)}</b><small>${esc(e.customerName || 'Cliente')}${d.asset ? ` • ${esc(d.asset)}` : ''}${d.direction ? ` • ${esc(d.direction)}` : ''}</small></div><time>${fmtTime(e.at)}</time></div>`;
  }).join('') : '<div class="attention-empty">Os eventos da extensão aparecerão aqui.</div>';
  if ($('#liveSync')) $('#liveSync').textContent = `ATUALIZADO ${new Date().toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'})}`;
}
async function loadOperations(force = false) {
  if (operationBusy && !force) return;
  operationBusy = true;
  try {
    const data = await api('/v1/admin/operations');
    operationState.summary = data.summary || {};
    operationState.sessions = data.sessions || [];
    operationState.signals = data.signals || [];
    operationState.events = data.events || [];
    renderOperations();
  } catch (e) {
    if (e.status === 401) return showLogin();
    if ($('#liveSync')) $('#liveSync').textContent = 'FALHA NA ATUALIZAÇÃO';
    toast(`Operação ao vivo: ${e.message}`);
  } finally {
    operationBusy = false;
  }
}
$('#liveRefresh')?.addEventListener('click', () => loadOperations(true));
$$('[data-live-filter]').forEach(btn => btn.onclick = () => {
  operationFilter = btn.dataset.liveFilter;
  $$('[data-live-filter]').forEach(x => x.classList.toggle('active', x === btn));
  renderOperations();
});
setInterval(() => {
  if (document.hidden || $('#authGate')?.hidden === false || !$('[data-view="operations"]')?.classList.contains('active')) return;
  loadOperations();
}, 5000);

setInterval(() => { $('#heroClock').textContent = new Date().toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'}); }, 1000);
renderTemplate('trial');
bootstrapAuth();
