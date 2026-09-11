(() => {
  const q = s => document.querySelector(s);
  const qa = s => [...document.querySelectorAll(s)];
  let attention = [];
  let autoRefreshBusy = false;

  const safe = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const daysLeft = l => l?.expiresAt ? Math.ceil((Date.parse(l.expiresAt) - Date.now()) / 86400000) : null;
  const isActive = l => l?.status === 'active' && (!l.expiresAt || Date.parse(l.expiresAt) > Date.now());

  const baseMessageFor = messageFor;
  messageFor = function(type, l = {}) {
    const name = String(l.customerName || '').trim() || 'Cliente';
    const key = l.key || q('#msgKey')?.value.trim() || 'SUA-LICENÇA';
    const plan = l.planLabel || l.plan || q('#msgPlan')?.value.trim() || 'Plano';
    const d = remainingDays(l);
    const validity = d == null ? 'sem expiração' : `${d} dia${d === 1 ? '' : 's'}`;
    if (type === 'trial') {
      const total = l.totalLimit ?? 2;
      return `🎁 *TESTE CONTROLADO LIBERADO!*\n\nOlá, ${name}! Seu teste do *AI Trading Scanner* foi criado com sucesso.\n\n✅ Plano: ${plan}\n⏳ Validade: ${validity}\n🎯 Limite do teste: ${total} sinal${total === 1 ? '' : 'is'} no total\n📱 Segurança: 1 aparelho por licença\n\n🔑 *Sua licença:*\n${key}\n\nDepois da primeira ativação, essa licença fica vinculada ao aparelho. A troca de dispositivo só pode ser liberada pelo administrador.\n\nAbra a extensão, cole a licença e conecte o scanner. 🚀`;
    }
    if (type === 'reset') {
      return `♻️ *NOVO APARELHO LIBERADO!*\n\nOlá, ${name}! O vínculo anterior do seu *AI Trading Scanner* foi removido.\n\n🔑 Licença: ${key}\n\nAgora você pode ativar a extensão em um novo aparelho. O consumo já realizado foi mantido por segurança. ✅`;
    }
    return baseMessageFor(type, l);
  };

  const baseSampleFor = sampleFor;
  sampleFor = function(type) {
    if (type === 'trial') return {customerName:q('#msgName')?.value || 'Cliente', key:q('#msgKey')?.value || 'ATS-XXXXXX-XXXXXX-XXXX', planLabel:q('#msgPlan')?.value || 'Trial', dailyLimit:2, totalLimit:2, usedTotal:0, expiresAt:new Date(Date.now()+3*86400000).toISOString()};
    const sample = baseSampleFor(type);
    if (sample.planLabel === 'Pro') sample.dailyLimit = 30;
    return sample;
  };

  const baseShowResult = showResult;
  showResult = function(title, l, type) {
    baseShowResult(title, l, type);
    const box = q('#resultLicense');
    if (!box || !l) return;
    const rule = l.isTrial || l.plan === 'trial'
      ? `${l.totalLimit ?? 2} sinais totais • 1 aparelho`
      : `${l.dailyLimit == null ? 'sem limite diário' : `${l.dailyLimit} sinais/dia`} • 1 aparelho`;
    box.innerHTML = `<span>LICENÇA</span><strong>${safe(l.key)}</strong><small>${safe(l.planLabel || l.plan)} • ${safe(fmtDate(l.expiresAt))} • ${safe(rule)}</small>`;
  };

  const baseRenderPlans = renderPlans;
  renderPlans = function() {
    baseRenderPlans();
    const cards = qa('#planStrip .plan-card');
    cards.forEach((card, i) => {
      const p = plans[i]; if (!p) return;
      const label = p.id === 'trial' ? `${p.totalSignals ?? 2} SINAIS NO TOTAL` : (p.dailySignals == null ? 'ILIMITADO' : `${p.dailySignals} SINAIS/DIA`);
      card.querySelector('span').textContent = label;
      card.querySelector('small').textContent = '1 aparelho por licença';
    });
  };

  const baseOpenModal = openModal;
  openModal = function(mode, key='') {
    baseOpenModal(mode, key);
    if (mode === 'trial') {
      q('#modalTitle').textContent = 'Gerar teste controlado';
      q('#modalDescription').textContent = 'Teste limitado a 2 sinais no total e travado em um único aparelho.';
      q('#submitActionBtn').textContent = 'GERAR TESTE CONTROLADO';
    }
    if (mode === 'reset') {
      q('#modalTitle').textContent = 'Liberar novo aparelho';
      q('#modalDescription').textContent = 'Remove apenas o vínculo do aparelho atual. O consumo já realizado é mantido.';
      q('#submitActionBtn').textContent = 'LIBERAR NOVO APARELHO';
    }
    if (mode === 'renew') {
      q('#renewFields')?.classList.remove('form-grid');
      q('#renewFields')?.classList.add('form-stack');
    }
  };

  qa('[data-renew-days]').forEach(btn => btn.addEventListener('click', () => {
    const days = Number(btn.dataset.renewDays || 30);
    q('#renewDays').value = days;
    qa('[data-renew-days]').forEach(x => x.classList.toggle('active', x === btn));
  }));

  const baseRenderInspector = renderInspector;
  renderInspector = function() {
    baseRenderInspector();
    const l = licenses.find(x => x.key === selectedLicenseKey);
    const root = q('#licenseInspector');
    if (!l || !root) return;
    const grid = root.querySelector('.inspect-grid');
    if (grid && !grid.querySelector('[data-total-usage]')) {
      const totalText = l.totalLimit == null ? `${l.usedTotal ?? 0}` : `${l.usedTotal ?? 0} / ${l.totalLimit}`;
      grid.insertAdjacentHTML('beforeend', `<div class="inspect-stat" data-total-usage><span>USO TOTAL</span><b>${safe(totalText)}</b></div><div class="inspect-stat"><span>VÍNCULO</span><b>${l.deviceLocked ? 'APARELHO VINCULADO' : 'LIVRE'}</b></div>`);
    }
    const actions = root.querySelector('.inspect-actions');
    if (actions && !actions.querySelector('.quick-renew-inspector')) {
      const bar = document.createElement('div');
      bar.className = 'quick-renew-inspector';
      bar.innerHTML = '<span>Renovação rápida</span><button data-qrenew="7">+7</button><button data-qrenew="15">+15</button><button data-qrenew="30">+30</button><button data-qrenew="90">+90</button>';
      actions.insertAdjacentElement('afterend', bar);
      bar.querySelectorAll('[data-qrenew]').forEach(b => b.onclick = async () => {
        b.disabled = true;
        try {
          const r = await api(`/v1/admin/licenses/${encodeURIComponent(l.key)}/renew`, {method:'POST', body:JSON.stringify({days:Number(b.dataset.qrenew)})});
          showResult('Acesso renovado', r.license, 'renew'); toast(`+${b.dataset.qrenew} dias adicionados`); await refreshData();
        } catch (e) { toast(`Falha: ${e.message}`); }
        finally { b.disabled = false; }
      });
    }
  };

  function buildAttention() {
    const items = [];
    for (const l of licenses) {
      const days = daysLeft(l);
      if (l.status === 'revoked') items.push({priority:4, icon:'⛔', title:l.customerName || 'Sem nome', text:'Licença bloqueada', key:l.key, action:'activate', label:'REATIVAR'});
      else if (days != null && days <= 0) items.push({priority:5, icon:'⌛', title:l.customerName || 'Sem nome', text:'Licença expirada', key:l.key, action:'renew', label:'RENOVAR'});
      else if (days != null && days <= 3) items.push({priority:3, icon:'⚠️', title:l.customerName || 'Sem nome', text:`Vence em ${days} dia${days === 1 ? '' : 's'}`, key:l.key, action:'renew', label:'RENOVAR'});
      if (l.plan === 'trial' && isActive(l) && l.totalLimit != null && (l.remainingTotal ?? l.totalLimit) <= 1) items.push({priority:2, icon:'🎯', title:l.customerName || 'Trial', text:`Trial com ${l.remainingTotal ?? 0} sinal restante`, key:l.key, action:'view', label:'VER'});
    }
    const cutoff = Date.now() - 24 * 3600000;
    for (const c of clients) if (!c.online && c.lastSeen && c.lastSeen < cutoff) {
      const l = licenses.find(x => x.key === c.licenseKey);
      if (l && isActive(l)) items.push({priority:1, icon:'◌', title:c.customerName || 'Cliente', text:`Offline há ${ago(c.lastSeen)}`, key:c.licenseKey, action:'view', label:'VER'});
    }
    attention = items.sort((a,b) => b.priority - a.priority).slice(0, 12);
  }

  function attentionAction(item) {
    if (item.action === 'renew') return openModal('renew', item.key);
    if (item.action === 'activate') {
      api(`/v1/admin/licenses/${encodeURIComponent(item.key)}/activate`, {method:'POST'}).then(async () => { toast('Licença reativada'); await refreshData(); }).catch(e => toast(`Falha: ${e.message}`));
      return;
    }
    selectedLicenseKey = item.key; setPage('licenses'); renderLicenses(); renderInspector();
  }

  function renderAttention() {
    buildAttention();
    const count = attention.length;
    if (q('#attentionCount')) q('#attentionCount').textContent = `${count} PENDÊNCIA${count === 1 ? '' : 'S'}`;
    if (q('#notifyCount')) q('#notifyCount').textContent = count;
    if (q('#notifyPanelCount')) q('#notifyPanelCount').textContent = `${count} item${count === 1 ? '' : 's'}`;
    const html = count ? attention.slice(0, 6).map((x,i) => `<div class="attention-row"><span class="attention-icon">${x.icon}</span><div><b>${safe(x.title)}</b><small>${safe(x.text)}</small></div><button class="attention-action" data-attention="${i}">${x.label}</button></div>`).join('') : '<div class="attention-empty">✓ Nada urgente agora. Operação em dia.</div>';
    if (q('#attentionList')) q('#attentionList').innerHTML = html;
    if (q('#notifyList')) q('#notifyList').innerHTML = count ? attention.map((x,i) => `<div class="notify-item"><div><b>${x.icon} ${safe(x.title)}</b><small>${safe(x.text)}</small></div><button data-notify-action="${i}">${x.label}</button></div>`).join('') : '<div class="attention-empty">Sem pendências.</div>';
    qa('[data-attention]').forEach(b => b.onclick = () => attentionAction(attention[Number(b.dataset.attention)]));
    qa('[data-notify-action]').forEach(b => b.onclick = () => { q('#notifyPanel').hidden = true; attentionAction(attention[Number(b.dataset.notifyAction)]); });
    const hero = q('#heroSummary'); if (hero) hero.textContent = count ? `Você tem ${count} ação${count === 1 ? '' : 'ões'} que merece${count === 1 ? '' : 'm'} atenção hoje. Resolva tudo pelos atalhos abaixo.` : 'Tudo em ordem. Continue acompanhando licenças, clientes e consumo em tempo real.';
  }

  function renderCommercial() {
    const paid = licenses.filter(l => l.plan !== 'trial' && isActive(l)).length;
    const trials = licenses.filter(l => l.plan === 'trial' && isActive(l)).length;
    const renewals = metrics.renewals ?? auditEvents.filter(e => e.action === 'license_renewed').length;
    const locked = licenses.filter(l => l.deviceLocked).length;
    const root = q('#commercialStats'); if (!root) return;
    root.innerHTML = [
      ['ACESSOS PAGOS', paid, 'licenças ativas fora do Trial'],
      ['TRIALS ATIVOS', trials, 'máximo de 2 sinais totais'],
      ['RENOVAÇÕES', renewals, 'registradas nesta execução'],
      ['APARELHOS VINCULADOS', locked, '1 vínculo por licença']
    ].map(([a,b,c]) => `<div class="commercial-card"><span>${a}</span><strong>${b}</strong><small>${c}</small></div>`).join('');
  }

  function renderGreeting() {
    const h = new Date().getHours();
    const prefix = h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite';
    if (q('#greetingTitle')) q('#greetingTitle').textContent = `${prefix}. Sua operação está aqui.`;
    if (q('#lastSync')) q('#lastSync').textContent = `última leitura ${new Date().toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'})}`;
    if (q('#syncChip')) q('#syncChip').textContent = `✓ atualizado ${new Date().toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'})}`;
  }

  function addMotion() {
    qa('.metric,.quick-card,.section-card,.client-card,.license-item,.plan-card').forEach((el,i) => {
      if (el.dataset.opsMotion) return; el.dataset.opsMotion = '1'; el.classList.add('reveal'); el.style.animationDelay = `${Math.min(i*20,160)}ms`;
    });
  }

  function renderOps() { renderAttention(); renderCommercial(); renderGreeting(); addMotion(); renderInspector(); }

  const baseRefreshData = refreshData;
  refreshData = async function() {
    const result = await baseRefreshData();
    renderOps();
    return result;
  };

  q('#notifyBtn')?.addEventListener('click', e => { e.stopPropagation(); q('#notifyPanel').hidden = !q('#notifyPanel').hidden; });
  document.addEventListener('click', e => { if (!e.target.closest('.notify-wrap') && q('#notifyPanel')) q('#notifyPanel').hidden = true; });

  q('#globalSearch')?.addEventListener('input', e => {
    const term = e.target.value.trim().toLowerCase();
    if (!term) return;
    const l = licenses.find(x => [x.customerName,x.email,x.key,x.planLabel].some(v => String(v || '').toLowerCase().includes(term)));
    if (!l) return;
    selectedLicenseKey = l.key;
  });
  q('#globalSearch')?.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    const term = e.currentTarget.value.trim(); if (!term) return;
    setPage('licenses'); q('#licenseSearch').value = term; renderLicenses(); renderInspector();
  });
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); q('#globalSearch')?.focus(); }
  });

  setInterval(async () => {
    if (document.hidden || q('#authGate')?.hidden === false || autoRefreshBusy) return;
    autoRefreshBusy = true;
    try { await refreshData(); } finally { autoRefreshBusy = false; }
  }, 15000);

  setTimeout(renderOps, 500);
})();