(() => {
  const q = s => document.querySelector(s);
  const qa = s => [...document.querySelectorAll(s)];
  const h = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const money = v => Number(v || 0).toLocaleString('pt-BR', {style:'currency', currency:'BRL'});
  const dateTime = v => v ? new Date(v).toLocaleString('pt-BR') : '—';
  let crmSettings = null;
  let securityRows = [];
  let healthState = {};
  let selectedBulk = new Set();

  function injectNavigation() {
    const rail = q('.rail-nav');
    if (rail && !rail.querySelector('[data-page="business"]')) {
      rail.insertAdjacentHTML('beforeend', '<button data-page="business"><span>▦</span><b>Comercial</b></button><button data-page="security"><span>🛡</span><b>Segurança</b></button>');
    }
    const mobile = q('.mobile-bar');
    if (mobile && !mobile.querySelector('[data-page="business"]')) mobile.insertAdjacentHTML('beforeend', '<button class="crm-mobile-more" data-page="business"><span>▦</span><b>Mais</b></button>');
  }

  function injectViews() {
    const workspace = q('.workspace');
    if (!workspace || q('[data-view="business"]')) return;
    workspace.insertAdjacentHTML('beforeend', `
      <section class="view crm-view" data-view="business">
        <section class="crm-heading"><div><span class="eyebrow">GESTÃO COMERCIAL</span><h2>Negócio, planos e operação</h2><p>Financeiro estimado, funil, configurações comerciais, backup e ações em lote.</p></div><div class="crm-heading-actions"><button class="btn secondary" id="exportCsvBtn">EXPORTAR CSV</button><button class="btn primary" id="backupBtn">BACKUP JSON</button></div></section>
        <div id="financeCards" class="crm-kpi-grid"></div>
        <div class="crm-two-col">
          <section class="section-card"><div class="section-head"><div><span class="eyebrow">FUNIL</span><h3>Jornada comercial</h3></div><span class="mini-tag">VISÃO GERAL</span></div><div id="funnelView" class="funnel-view"></div></section>
          <section class="section-card"><div class="section-head"><div><span class="eyebrow">MARCA</span><h3>Configuração do produto</h3></div><span class="mini-tag">EDITÁVEL</span></div><form id="brandForm" class="crm-form"><label>Nome do produto<input id="brandProductName"></label><label>Nome curto<input id="brandShort"></label><label>WhatsApp comercial<input id="brandWhatsapp" inputmode="tel" placeholder="5511999999999"></label><label class="wide">Mensagem de suporte<textarea id="brandSupport"></textarea></label><label class="crm-toggle wide"><input id="brandTrialEnabled" type="checkbox"><span>Permitir geração de Trial pelo painel</span></label><button class="btn primary wide" type="submit">SALVAR CONFIGURAÇÕES</button></form></section>
        </div>
        <section class="section-card crm-plans"><div class="section-head"><div><span class="eyebrow">PLANOS</span><h3>Planos editáveis</h3><p>Uma licença continua limitada a um único aparelho.</p></div></div><div id="editablePlans" class="editable-plans"></div></section>
        <section class="section-card crm-bulk"><div class="section-head"><div><span class="eyebrow">LOTE</span><h3>Ações em vários clientes</h3></div><span id="bulkCount" class="count-badge">0 selecionados</span></div><div class="bulk-toolbar"><button data-bulk-action="renew" class="btn secondary">+30 DIAS</button><button data-bulk-action="activate" class="btn secondary">REATIVAR</button><button data-bulk-action="revoke" class="btn secondary">BLOQUEAR</button><button data-bulk-action="reset-devices" class="btn secondary">LIBERAR APARELHO</button></div><div id="bulkList" class="bulk-list"></div></section>
      </section>
      <section class="view crm-view" data-view="security">
        <section class="crm-heading"><div><span class="eyebrow">CENTRAL DE SEGURANÇA</span><h2>Proteção das licenças</h2><p>Tentativas em aparelhos diferentes, trocas liberadas e histórico de vínculo.</p></div><button id="securityRefresh" class="btn primary">ATUALIZAR</button></section>
        <div id="securityCards" class="crm-kpi-grid"></div>
        <div class="crm-two-col security-columns">
          <section class="section-card"><div class="section-head"><div><span class="eyebrow">BLOQUEIOS</span><h3>Tentativas recentes</h3></div><span id="securityEventCount" class="count-badge">0</span></div><div id="securityList" class="security-list"></div></section>
          <section class="section-card"><div class="section-head"><div><span class="eyebrow">SISTEMA</span><h3>Saúde e armazenamento</h3></div></div><div id="crmHealth" class="system-list"></div></section>
        </div>
      </section>`);

    document.body.insertAdjacentHTML('beforeend', `
      <aside id="customerDrawer" class="customer-drawer" hidden><div class="drawer-overlay" data-close-customer></div><section class="drawer-panel"><div class="drawer-head"><div><span class="eyebrow">FICHA DO CLIENTE</span><h2 id="drawerName">Cliente</h2><p id="drawerSub">—</p></div><button data-close-customer>×</button></div><div id="drawerBody"></div></section></aside>
      <div id="onboardingModal" class="onboarding-modal" hidden><div class="drawer-overlay" data-close-onboarding></div><section class="onboarding-card"><button class="modal-x" data-close-onboarding>×</button><span class="eyebrow">PRONTO PARA O CLIENTE</span><h2>Ativação em 4 passos</h2><div id="onboardingSteps" class="onboarding-steps"></div><div class="onboarding-actions"><button id="copyOnboarding" class="btn primary">COPIAR PASSO A PASSO</button><button id="whatsappOnboarding" class="btn whatsapp-btn">ABRIR WHATSAPP</button></div></section></div>`);
  }

  function bindNewNavigation() {
    qa('[data-page]').forEach(btn => {
      if (btn.dataset.crmBound) return;
      btn.dataset.crmBound = '1';
      btn.addEventListener('click', () => {
        if (btn.dataset.page === 'business' || btn.dataset.page === 'security') setPage(btn.dataset.page);
      });
    });
  }

  function updatePageMeta(name) {
    if (name === 'business') {
      q('#pageTitle').textContent = 'Gestão comercial'; q('#pageSub').textContent = 'Planos, financeiro, funil e operações em lote.';
    } else if (name === 'security') {
      q('#pageTitle').textContent = 'Central de segurança'; q('#pageSub').textContent = 'Proteção contra compartilhamento de licença e histórico de dispositivos.';
    }
  }

  const originalSetPage = setPage;
  setPage = function(name) {
    originalSetPage(name);
    updatePageMeta(name);
    if (name === 'business') renderBusiness();
    if (name === 'security') renderSecurity();
  };

  async function loadCrmData() {
    try {
      const [s, sec, health] = await Promise.all([
        api('/v1/admin/settings'), api('/v1/admin/security'), fetch(`${apiBase}/health`).then(r => r.json())
      ]);
      crmSettings = s.settings || {}; securityRows = sec.events || []; healthState = health || {};
    } catch (e) { if (e.status !== 401) toast(`CRM: ${e.message}`); }
  }

  function renderFinance() {
    const root = q('#financeCards'); if (!root) return;
    const activePaid = metrics.paidLicenses ?? licenses.filter(l => l.plan !== 'trial' && l.status === 'active').length;
    const revenue = metrics.estimatedMonthlyRevenue ?? 0;
    const avg = activePaid ? revenue / activePaid : 0;
    root.innerHTML = [
      ['💰','RECEITA ESTIMADA', money(revenue), 'com base nos preços dos planos ativos'],
      ['👥','CLIENTES PAGOS', activePaid, 'licenças pagas ativas'],
      ['↻','RENOVAÇÕES', metrics.renewals ?? 0, 'registradas no histórico'],
      ['🎫','TICKET MÉDIO', money(avg), 'estimativa por cliente ativo']
    ].map(([i,l,v,s]) => `<article class="crm-kpi"><span>${i}</span><small>${l}</small><strong>${v}</strong><em>${s}</em></article>`).join('');
  }

  function renderFunnel() {
    const f = metrics.funnel || {};
    const rows = [
      ['Trials criados', f.trialsCreated ?? 0], ['Licenças pagas criadas', f.paidCreated ?? 0],
      ['Clientes pagos ativos', f.activePaid ?? metrics.paidLicenses ?? 0], ['Expirados', f.expired ?? metrics.expiredLicenses ?? 0]
    ];
    const max = Math.max(1, ...rows.map(x => Number(x[1]) || 0));
    q('#funnelView').innerHTML = rows.map(([label, value], i) => `<div class="funnel-row"><div><span>${h(label)}</span><b>${value}</b></div><div class="funnel-track"><i style="width:${Math.max(4,(value/max)*100)}%"></i></div></div>`).join('');
  }

  function renderBrand() {
    if (!crmSettings || !q('#brandForm')) return;
    q('#brandProductName').value = crmSettings.productName || 'AI Trading Scanner';
    q('#brandShort').value = crmSettings.brandShort || 'ATS';
    q('#brandWhatsapp').value = crmSettings.whatsapp || '';
    q('#brandSupport').value = crmSettings.supportText || '';
    q('#brandTrialEnabled').checked = crmSettings.trialEnabled !== false;
    const mark = q('.brand-mark'); if (mark) mark.textContent = crmSettings.brandShort || 'ATS';
  }

  function renderEditablePlans() {
    const root = q('#editablePlans'); if (!root) return;
    root.innerHTML = plans.map(p => `<form class="plan-editor" data-plan-editor="${h(p.id)}"><div class="plan-editor-head"><div><span>${p.id === 'trial' ? '🎁' : p.id === 'unlimited' ? '∞' : '◆'}</span><div><b>${h(p.label)}</b><small>${h(p.id.toUpperCase())}</small></div></div><em>1 aparelho</em></div><label>Nome<input name="label" value="${h(p.label)}"></label>${p.id !== 'unlimited' ? `<label>Sinais/dia<input name="dailySignals" type="number" min="1" value="${p.dailySignals ?? ''}"></label>` : '<div class="plan-locked">Sinais/dia <b>ILIMITADO</b></div>'}${p.id === 'trial' ? `<label>Sinais totais<input name="totalSignals" type="number" min="1" max="2" value="${p.totalSignals ?? 2}"></label>` : ''}<label>Validade padrão<input name="defaultDays" type="number" min="1" value="${p.defaultDays ?? 30}"></label><label>Preço R$<input name="price" type="number" min="0" step="0.01" value="${Number(p.price || 0)}"></label><button class="btn primary full" type="submit">SALVAR ${h(p.label).toUpperCase()}</button></form>`).join('');
    qa('[data-plan-editor]').forEach(form => form.onsubmit = async e => {
      e.preventDefault(); const id = form.dataset.planEditor; const fd = new FormData(form); const payload = Object.fromEntries(fd.entries());
      ['dailySignals','totalSignals','defaultDays','price'].forEach(k => { if (k in payload) payload[k] = Number(payload[k]); });
      try { await api(`/v1/admin/plans/${encodeURIComponent(id)}`, {method:'POST', body:JSON.stringify(payload)}); toast('Plano atualizado'); await refreshData(); await loadCrmData(); renderBusiness(); }
      catch (err) { toast(`Falha: ${err.message}`); }
    });
  }

  function renderBulk() {
    const root = q('#bulkList'); if (!root) return;
    const rows = licenses.slice(0, 100);
    root.innerHTML = rows.length ? rows.map(l => `<label class="bulk-row"><input type="checkbox" data-bulk-key="${h(l.key)}" ${selectedBulk.has(l.key) ? 'checked' : ''}><span><b>${h(l.customerName || 'Sem nome')}</b><small>${h(l.planLabel)} • ${h(l.key)}</small></span><em>${l.status === 'active' ? 'ATIVA' : 'BLOQUEADA'}</em></label>`).join('') : '<div class="attention-empty">Nenhuma licença.</div>';
    qa('[data-bulk-key]').forEach(el => el.onchange = () => { el.checked ? selectedBulk.add(el.dataset.bulkKey) : selectedBulk.delete(el.dataset.bulkKey); updateBulkCount(); });
    updateBulkCount();
  }
  function updateBulkCount() { if (q('#bulkCount')) q('#bulkCount').textContent = `${selectedBulk.size} selecionado${selectedBulk.size === 1 ? '' : 's'}`; }

  async function bulkAction(action) {
    if (!selectedBulk.size) return toast('Selecione pelo menos uma licença');
    const payload = { keys:[...selectedBulk], action, ...(action === 'renew' ? {days:30} : {}) };
    try { const r = await api('/v1/admin/licenses/bulk', {method:'POST', body:JSON.stringify(payload)}); toast(`${r.count || 0} licença(s) atualizada(s)`); selectedBulk.clear(); await refreshData(); renderBusiness(); }
    catch (e) { toast(`Falha: ${e.message}`); }
  }

  function renderBusiness() {
    renderFinance(); renderFunnel(); renderBrand(); renderEditablePlans(); renderBulk();
  }

  function renderSecurity() {
    const root = q('#securityCards'); if (!root) return;
    root.innerHTML = [
      ['🛡️','TENTATIVAS BLOQUEADAS', metrics.blockedDeviceAttempts ?? securityRows.length, 'outros aparelhos impedidos'],
      ['📱','APARELHOS VINCULADOS', licenses.filter(l => l.deviceLocked).length, 'licenças já presas a um aparelho'],
      ['♻','TROCAS LIBERADAS', metrics.deviceChanges ?? licenses.reduce((n,l)=>n+(l.deviceChanges||0),0), 'histórico de trocas'],
      ['🔐','REGRA ATIVA','1:1','uma licença por aparelho']
    ].map(([i,l,v,s]) => `<article class="crm-kpi security-kpi"><span>${i}</span><small>${l}</small><strong>${h(v)}</strong><em>${s}</em></article>`).join('');
    q('#securityEventCount').textContent = securityRows.length;
    q('#securityList').innerHTML = securityRows.length ? securityRows.slice(0,80).map(e => `<article class="security-event"><div class="security-event-icon">⚠</div><div><b>${h(e.customerName || e.licenseKey)}</b><small>Tentativa em outro aparelho • ${h(dateTime(e.at))}</small><code>${h(String(e.installationId || '').slice(0,18))}…</code></div><button class="btn secondary" data-security-open="${h(e.licenseKey)}">VER CLIENTE</button></article>`).join('') : '<div class="attention-empty">✓ Nenhuma tentativa bloqueada registrada.</div>';
    qa('[data-security-open]').forEach(b => b.onclick = () => openCustomer(b.dataset.securityOpen));
    q('#crmHealth').innerHTML = [
      ['Backend', healthState.ok ? 'ONLINE' : 'OFFLINE'], ['Versão', healthState.version || metrics.version || '—'],
      ['Armazenamento', healthState.storage === 'database-ready' ? 'Banco configurado' : 'Arquivo persistente'], ['Licenças', healthState.licenses ?? licenses.length],
      ['Auto atualização', '15 segundos'], ['Sessão admin', '30 dias']
    ].map(([a,b]) => `<div class="system-row"><span>${h(a)}</span><b>${h(b)}</b></div>`).join('');
  }

  async function openCustomer(key) {
    const drawer = q('#customerDrawer'); if (!drawer) return;
    drawer.hidden = false; document.body.style.overflow = 'hidden';
    q('#drawerBody').innerHTML = '<div class="drawer-loading">Carregando ficha...</div>';
    try {
      const p = await api(`/v1/admin/customers/${encodeURIComponent(key)}`), l = p.license;
      q('#drawerName').textContent = l.customerName || 'Sem nome'; q('#drawerSub').textContent = `${l.planLabel} • ${l.key}`;
      const current = p.devices?.[0];
      q('#drawerBody').innerHTML = `
        <div class="profile-status"><span class="pill ${l.status === 'active' ? 'on' : 'off'}">${l.status === 'active' ? 'ATIVA' : 'BLOQUEADA'}</span><span class="pill">${h(l.planLabel)}</span><span class="pill">${l.deviceLocked ? '🔒 APARELHO VINCULADO' : 'APARELHO LIVRE'}</span></div>
        <div class="profile-grid"><div><span>USO HOJE</span><b>${l.usedToday}${l.dailyLimit == null ? '' : ` / ${l.dailyLimit}`}</b></div><div><span>USO TOTAL</span><b>${l.usedTotal}${l.totalLimit == null ? '' : ` / ${l.totalLimit}`}</b></div><div><span>VENCIMENTO</span><b>${h(fmtDate(l.expiresAt))}</b></div><div><span>TROCAS</span><b>${l.deviceChanges || 0}</b></div></div>
        <section class="profile-section"><div class="profile-section-head"><b>Aparelho atual</b><button class="btn secondary" data-profile-reset="${h(l.key)}">LIBERAR NOVO APARELHO</button></div>${current ? `<div class="device-box"><code>${h(current.installationId)}</code><span>Versão ${h(current.version || '—')} • última atividade ${h(dateTime(current.lastSeen))}</span></div>` : '<div class="profile-empty">Nenhum aparelho vinculado.</div>'}</section>
        <section class="profile-section"><b>Histórico de aparelhos</b><div class="profile-history">${(p.deviceHistory || []).length ? p.deviceHistory.map(d => `<div><span>📱 ${h(String(d.installationId || '').slice(0,22))}</span><small>liberado em ${h(dateTime(d.removedAt))}</small></div>`).join('') : '<div class="profile-empty">Nenhuma troca registrada.</div>'}</div></section>
        <section class="profile-section"><b>Atividade administrativa</b><div class="profile-history">${(p.history || []).length ? p.history.slice(0,12).map(e => `<div><span>${h(String(e.action || '').replaceAll('_',' '))}</span><small>${h(dateTime(e.at))}</small></div>`).join('') : '<div class="profile-empty">Sem histórico.</div>'}</div></section>
        <section class="profile-section"><b>Segurança</b><div class="profile-history danger">${(p.security || []).length ? p.security.slice(0,12).map(e => `<div><span>⚠ Tentativa em outro aparelho</span><small>${h(dateTime(e.at))} • ${h(String(e.installationId || '').slice(0,16))}…</small></div>`).join('') : '<div class="profile-empty">Nenhuma tentativa irregular.</div>'}</div></section>`;
      q('[data-profile-reset]')?.addEventListener('click', () => { drawer.hidden = true; document.body.style.overflow = ''; openModal('reset', l.key); });
    } catch (e) { q('#drawerBody').innerHTML = `<div class="profile-empty">Falha ao carregar: ${h(e.message)}</div>`; }
  }

  function enhanceClientCards() {
    qa('.client-card').forEach(card => {
      if (card.dataset.crmProfile) return; card.dataset.crmProfile = '1';
      const reset = card.querySelector('[data-client-reset]'); if (!reset) return;
      const key = reset.dataset.clientReset;
      const btn = document.createElement('button'); btn.className = 'btn secondary full profile-open-btn'; btn.textContent = 'VER FICHA COMPLETA'; btn.onclick = () => openCustomer(key);
      reset.parentElement?.appendChild(btn);
    });
  }

  function enhanceInspector() {
    const root = q('#licenseInspector'); if (!root || root.querySelector('.profile-open-inspector')) return;
    const l = licenses.find(x => x.key === selectedLicenseKey); if (!l) return;
    const b = document.createElement('button'); b.className = 'btn secondary full profile-open-inspector'; b.textContent = 'ABRIR FICHA COMPLETA DO CLIENTE'; b.onclick = () => openCustomer(l.key); root.appendChild(b);
  }

  function onboardingText(l) {
    const name = crmSettings?.productName || 'AI Trading Scanner';
    return `✅ ATIVAÇÃO DO ${name.toUpperCase()}\n\n1️⃣ Instale/abra a extensão.\n2️⃣ Cole a licença: ${l?.key || 'SUA-LICENÇA'}\n3️⃣ Ative no aparelho que será usado normalmente.\n4️⃣ Abra a plataforma e conecte o scanner.\n\n🔒 Importante: a licença fica vinculada ao primeiro aparelho. Para trocar de dispositivo, o administrador precisa liberar o vínculo.`;
  }
  function showOnboarding(l) {
    const modal = q('#onboardingModal'); if (!modal) return;
    modal.dataset.license = l?.key || ''; modal.hidden = false;
    q('#onboardingSteps').innerHTML = '<div><b>1</b><span>Instalar ou abrir a extensão</span></div><div><b>2</b><span>Colar a licença gerada</span></div><div><b>3</b><span>Ativar no aparelho principal</span></div><div><b>4</b><span>Abrir a plataforma e conectar o scanner</span></div><aside>🔒 Depois da primeira ativação, a licença fica presa a esse aparelho.</aside>';
  }

  const originalShowResult = showResult;
  showResult = function(title, l, type) {
    originalShowResult(title, l, type);
    const actions = q('.result-actions'); if (!actions) return;
    actions.querySelectorAll('.crm-result-action').forEach(x => x.remove());
    const wa = document.createElement('button'); wa.className = 'btn whatsapp-btn crm-result-action'; wa.textContent = 'WHATSAPP'; wa.onclick = () => window.open(`https://wa.me/?text=${encodeURIComponent(q('#resultMessage').value)}`, '_blank');
    const guide = document.createElement('button'); guide.className = 'btn secondary crm-result-action'; guide.textContent = 'PASSO A PASSO'; guide.onclick = () => showOnboarding(l);
    actions.append(wa, guide);
  };

  async function saveBrand(e) {
    e.preventDefault();
    const payload = { productName:q('#brandProductName').value.trim(), brandShort:q('#brandShort').value.trim(), whatsapp:q('#brandWhatsapp').value.trim(), supportText:q('#brandSupport').value.trim(), trialEnabled:q('#brandTrialEnabled').checked };
    try { const r = await api('/v1/admin/settings', {method:'POST', body:JSON.stringify(payload)}); crmSettings = r.settings; renderBrand(); toast('Configurações salvas'); }
    catch (err) { toast(`Falha: ${err.message}`); }
  }

  function download(name, content, type='application/json') {
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([content], {type})); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  async function backup() {
    try { const data = await api('/v1/admin/backup'); download(`ats-backup-${new Date().toISOString().slice(0,10)}.json`, JSON.stringify(data,null,2)); toast('Backup gerado'); }
    catch (e) { toast(`Falha: ${e.message}`); }
  }
  function exportCsv() {
    const cols = ['Cliente','Email','Licença','Plano','Status','UsoHoje','UsoTotal','Vencimento','AparelhoVinculado','Trocas','Preço'];
    const rows = licenses.map(l => [l.customerName,l.email,l.key,l.planLabel,l.status,l.usedToday,l.usedTotal,l.expiresAt,l.deviceLocked?'sim':'não',l.deviceChanges||0,l.price||0]);
    const csv = [cols,...rows].map(r => r.map(v => `"${String(v ?? '').replaceAll('"','""')}"`).join(';')).join('\n');
    download(`ats-clientes-${new Date().toISOString().slice(0,10)}.csv`, '\ufeff'+csv, 'text/csv;charset=utf-8'); toast('CSV exportado');
  }

  function bindStatic() {
    q('#brandForm')?.addEventListener('submit', saveBrand);
    q('#backupBtn')?.addEventListener('click', backup); q('#exportCsvBtn')?.addEventListener('click', exportCsv);
    q('#securityRefresh')?.addEventListener('click', async () => { await loadCrmData(); renderSecurity(); toast('Segurança atualizada'); });
    qa('[data-bulk-action]').forEach(b => b.onclick = () => bulkAction(b.dataset.bulkAction));
    qa('[data-close-customer]').forEach(b => b.onclick = () => { q('#customerDrawer').hidden = true; document.body.style.overflow = ''; });
    qa('[data-close-onboarding]').forEach(b => b.onclick = () => q('#onboardingModal').hidden = true);
    q('#copyOnboarding')?.addEventListener('click', () => {
      const l = licenses.find(x => x.key === q('#onboardingModal').dataset.license); copyText(onboardingText(l), 'Passo a passo copiado');
    });
    q('#whatsappOnboarding')?.addEventListener('click', () => {
      const l = licenses.find(x => x.key === q('#onboardingModal').dataset.license); window.open(`https://wa.me/?text=${encodeURIComponent(onboardingText(l))}`, '_blank');
    });
  }

  const originalRefresh = refreshData;
  refreshData = async function() {
    const r = await originalRefresh(); await loadCrmData(); renderBusiness(); renderSecurity(); enhanceClientCards(); enhanceInspector(); return r;
  };
  const originalRenderClients = renderClients;
  renderClients = function() { originalRenderClients(); enhanceClientCards(); };
  const originalRenderInspector = renderInspector;
  renderInspector = function() { originalRenderInspector(); enhanceInspector(); };

  injectNavigation(); injectViews(); bindNewNavigation(); bindStatic();
  loadCrmData().then(() => { renderBusiness(); renderSecurity(); renderBrand(); });
})();
