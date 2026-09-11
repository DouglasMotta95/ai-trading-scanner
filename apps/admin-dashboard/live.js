(() => {
  const q = s => document.querySelector(s);
  const qa = s => [...document.querySelectorAll(s)];
  const safe = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const fmtTime = v => v ? new Date(v).toLocaleTimeString('pt-BR', {hour:'2-digit',minute:'2-digit',second:'2-digit'}) : '—';
  const fmtDateTime = v => v ? new Date(v).toLocaleString('pt-BR') : '—';
  const agoText = v => {
    if (!v) return '—';
    const s = Math.max(0, Math.floor((Date.now() - v) / 1000));
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s/60)}min`;
    if (s < 86400) return `${Math.floor(s/3600)}h`;
    return `${Math.floor(s/86400)}d`;
  };
  let operations = {summary:{}, sessions:[], signals:[], events:[]};
  let busy = false;
  let signalFilter = 'all';

  function injectNav() {
    const rail = q('.rail-nav');
    if (rail && !rail.querySelector('[data-page="operations"]')) {
      const system = rail.querySelector('[data-page="system"]');
      const html = '<button data-page="operations"><span>◈</span><b>Operação</b></button>';
      system ? system.insertAdjacentHTML('beforebegin', html) : rail.insertAdjacentHTML('beforeend', html);
    }
    const mobile = q('.mobile-bar');
    if (mobile && !mobile.querySelector('[data-page="operations"]')) {
      mobile.insertAdjacentHTML('beforeend', '<button data-page="operations"><span>◈</span><b>Live</b></button>');
    }
  }

  function injectDashboardStrip() {
    const metricGrid = q('#metricGrid');
    if (!metricGrid || q('#liveDashboardStrip')) return;
    metricGrid.insertAdjacentHTML('afterend', `
      <section id="liveDashboardStrip" class="live-dashboard-strip">
        <div class="live-strip-title"><span class="live-pulse"></span><div><b>OPERAÇÃO AO VIVO</b><small>Dados enviados pelas extensões autenticadas</small></div></div>
        <div id="liveStripStats" class="live-strip-stats"></div>
        <button class="live-strip-open" data-page="operations">ABRIR CENTRAL LIVE →</button>
      </section>`);
  }

  function injectView() {
    const workspace = q('.workspace');
    if (!workspace || q('[data-view="operations"]')) return;
    workspace.insertAdjacentHTML('beforeend', `
      <section class="view live-view" data-view="operations">
        <section class="live-heading">
          <div><span class="eyebrow">EXTENSÃO → BACKEND → PAINEL</span><h2>Operação ao vivo</h2><p>Acompanhe scanners conectados, estados de sinal, entradas confirmadas e resultados observados pelo feed.</p></div>
          <div class="live-heading-actions"><span id="liveSync" class="live-sync">SINCRONIZANDO</span><button id="liveRefresh" class="btn primary">ATUALIZAR</button></div>
        </section>
        <div id="liveSummary" class="live-summary-grid"></div>
        <section class="section-card live-clients-card">
          <div class="section-head"><div><span class="eyebrow">AGORA</span><h3>Scanners conectados</h3><p>Último heartbeat recebido em tempo real.</p></div><span id="liveClientCount" class="count-badge green">0 ONLINE</span></div>
          <div id="liveSessions" class="live-sessions"></div>
        </section>
        <section class="section-card live-signals-card">
          <div class="section-head live-signals-head"><div><span class="eyebrow">ENTRADAS</span><h3>Histórico de sinais confirmados</h3><p>Resultado calculado pela primeira cotação recebida depois da expiração.</p></div>
            <div class="live-filters"><button class="active" data-live-filter="all">Todos</button><button data-live-filter="pending">Pendentes</button><button data-live-filter="win">Wins</button><button data-live-filter="loss">Losses</button></div>
          </div>
          <div id="liveSignals" class="live-signals"></div>
          <p class="live-disclaimer">A taxa exibida é observacional, baseada no feed capturado pela extensão. Não representa garantia de resultado nem substitui validação por backtest/forward test.</p>
        </section>
        <div class="live-two-col">
          <section class="section-card"><div class="section-head"><div><span class="eyebrow">EVENTOS</span><h3>Fluxo da extensão</h3></div><span id="liveEventCount" class="count-badge">0</span></div><div id="liveEvents" class="live-events"></div></section>
          <section class="section-card"><div class="section-head"><div><span class="eyebrow">QUALIDADE</span><h3>Como ler esta tela</h3></div></div><div class="live-guide">
            <div><i class="good"></i><span><b>Feed estruturado</b><small>Melhor condição para liberar sinais operacionais.</small></span></div>
            <div><i class="warn"></i><span><b>Feed provisório</b><small>Serve para acompanhar setup, mas não deve confirmar entrada.</small></span></div>
            <div><i class="info"></i><span><b>Resultado observado</b><small>Compara preço de entrada com a cotação recebida após a expiração.</small></span></div>
          </div></section>
        </div>
      </section>`);
  }

  const previousSetPage = setPage;
  setPage = function(name) {
    previousSetPage(name);
    if (name === 'operations') {
      q('#pageTitle').textContent = 'Operação ao vivo';
      q('#pageSub').textContent = 'Scanners, entradas e resultados recebidos diretamente das extensões.';
      loadOperations(true);
    }
  };

  function bindNav() {
    qa('[data-page="operations"]').forEach(btn => {
      if (btn.dataset.liveBound) return;
      btn.dataset.liveBound = '1';
      btn.addEventListener('click', () => setPage('operations'));
    });
  }

  function stateLabel(s) {
    const st = String(s.signalState || '').toUpperCase();
    if (st === 'CONFIRM') return 'ENTRADA CONFIRMADA';
    if (st === 'WATCH') return 'ACOMPANHANDO';
    if (st === 'SEARCHING') return 'ANALISANDO';
    if (st === 'NO_TRADE') return 'NÃO ENTRAR';
    if (st === 'WAIT') return 'AGUARDANDO';
    return st || 'SEM ESTADO';
  }
  function stateTone(s) {
    const st = String(s.signalState || '').toUpperCase();
    if (st === 'CONFIRM') return s.direction === 'SELL' ? 'sell' : 'buy';
    if (st === 'WATCH') return 'watch';
    if (st === 'NO_TRADE') return 'blocked';
    return 'neutral';
  }
  function outcomeLabel(v) {
    return ({win:'WIN',loss:'LOSS',draw:'EMPATE',pending:'PENDENTE',unknown:'INDEFINIDO'})[v] || String(v || 'PENDENTE').toUpperCase();
  }

  function renderSummary() {
    const s = operations.summary || {};
    const accuracy = s.observedAccuracy == null ? '—' : `${s.observedAccuracy}%`;
    q('#liveSummary').innerHTML = [
      ['●','CLIENTES ONLINE',s.onlineClients ?? 0,'heartbeat nos últimos 20s','green'],
      ['◉','SCANNERS ATIVOS',s.scanningClients ?? 0,'leitura em execução','blue'],
      ['↗','SINAIS CONFIRMADOS',s.confirmedSignals ?? 0,`${s.pendingSignals ?? 0} aguardando resultado`,'violet'],
      ['✓','ACERTO OBSERVADO',accuracy,`${s.wins ?? 0} win • ${s.losses ?? 0} loss`,'gold']
    ].map(([i,l,v,h,t]) => `<article class="live-kpi ${t}"><span>${i}</span><small>${l}</small><strong>${safe(v)}</strong><em>${safe(h)}</em></article>`).join('');

    const strip = q('#liveStripStats');
    if (strip) strip.innerHTML = `<div><strong>${s.onlineClients ?? 0}</strong><small>ONLINE</small></div><div><strong>${s.scanningClients ?? 0}</strong><small>SCANNERS</small></div><div><strong>${s.confirmedSignals ?? 0}</strong><small>SINAIS</small></div><div><strong>${safe(accuracy)}</strong><small>OBSERVADO</small></div>`;
  }

  function renderSessions() {
    const rows = operations.sessions || [];
    const online = rows.filter(x => x.online).length;
    q('#liveClientCount').textContent = `${online} ONLINE`;
    q('#liveSessions').innerHTML = rows.length ? rows.map(s => {
      const quality = s.feedQuality == null ? '—' : `${Math.round(s.feedQuality)}%`;
      const platform = s.platformName || s.platformId || 'Plataforma';
      const name = s.customerName || 'Cliente';
      const dir = s.direction || '';
      return `<article class="live-session ${s.online ? 'online' : 'offline'}">
        <div class="live-session-main"><span class="presence"><i></i>${s.online ? 'ONLINE' : `OFFLINE • ${agoText(s.lastSeen)}`}</span><div><b>${safe(name)}</b><small>${safe(platform)} • ${safe(s.asset || 'sem ativo')}</small></div></div>
        <div class="live-session-signal"><span class="live-state ${stateTone(s)}">${safe(stateLabel(s))}</span><strong>${dir ? safe(dir) : '—'} ${s.score == null ? '' : `• ${Math.round(s.score)}`}</strong><small>${safe(s.timeframe || 'AUTO')} • ${safe(s.expiration || 'AUTO')}</small></div>
        <div class="live-session-feed"><span>FEED</span><b>${safe(quality)}</b><small>${s.structured ? 'ESTRUTURADO' : 'PROVISÓRIO'} • v${safe(s.version || '—')}</small></div>
        <button class="live-client-open" data-live-license="${safe(s.licenseKey)}">VER CLIENTE</button>
      </article>`;
    }).join('') : '<div class="attention-empty">Nenhuma extensão enviou heartbeat ainda.</div>';
    qa('[data-live-license]').forEach(btn => btn.onclick = () => {
      selectedLicenseKey = btn.dataset.liveLicense;
      setPage('licenses'); renderLicenses(); renderInspector();
    });
  }

  function renderSignals() {
    const all = operations.signals || [];
    const rows = signalFilter === 'all' ? all : all.filter(x => x.outcome === signalFilter);
    q('#liveSignals').innerHTML = rows.length ? rows.map(s => `<article class="live-signal-row">
      <div class="signal-identity"><span class="direction ${s.direction === 'SELL' ? 'sell' : 'buy'}">${safe(s.direction)}</span><div><b>${safe(s.asset)}</b><small>${safe(s.customerName || 'Cliente')} • ${safe(s.platformName || s.platformId || 'Plataforma')}</small></div></div>
      <div><span>ENTRADA</span><b>${safe(s.entryPrice)}</b><small>${fmtTime(s.entryAt)}</small></div>
      <div><span>EXPIRAÇÃO</span><b>${safe(s.expiration || s.timeframe || '—')}</b><small>${fmtTime(s.expiresAt)}</small></div>
      <div><span>SCORE</span><b>${Math.round(Number(s.score || 0))}</b><small>${safe(s.confirmations || s.grade || '—')}</small></div>
      <div><span>SAÍDA</span><b>${s.exitPrice == null ? '—' : safe(s.exitPrice)}</b><small>${s.resolvedAt ? fmtTime(s.resolvedAt) : 'aguardando'}</small></div>
      <em class="outcome ${safe(s.outcome)}">${outcomeLabel(s.outcome)}</em>
    </article>`).join('') : '<div class="attention-empty">Nenhum sinal neste filtro.</div>';
  }

  function renderEvents() {
    const rows = operations.events || [];
    q('#liveEventCount').textContent = rows.length;
    q('#liveEvents').innerHTML = rows.length ? rows.slice(0,30).map(e => {
      const d = e.data || {};
      const labels = {
        scanner_started:'Scanner iniciado', scanner_stopped:'Scanner pausado', platform_connected:'Plataforma conectada',
        signal_confirmed:'Entrada confirmada', signal_state:'Estado do sinal alterado', license_activated:'Licença ativada'
      };
      return `<div class="live-event"><i></i><div><b>${safe(labels[e.type] || e.type)}</b><small>${safe(e.customerName || 'Cliente')} ${d.asset ? `• ${safe(d.asset)}` : ''} ${d.direction ? `• ${safe(d.direction)}` : ''}</small></div><time>${fmtTime(e.at)}</time></div>`;
    }).join('') : '<div class="attention-empty">Os eventos da extensão aparecerão aqui.</div>';
  }

  function renderAll() {
    renderSummary(); renderSessions(); renderSignals(); renderEvents();
    const sync = q('#liveSync'); if (sync) sync.textContent = `ATUALIZADO ${new Date().toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'})}`;
  }

  async function loadOperations(force = false) {
    if (busy && !force) return;
    busy = true;
    try {
      operations = await api('/v1/admin/operations');
      renderAll();
    } catch (e) {
      if (e.status !== 401) toast(`Operação live: ${e.message}`);
    } finally { busy = false; }
  }

  function bindControls() {
    q('#liveRefresh')?.addEventListener('click', () => loadOperations(true));
    qa('[data-live-filter]').forEach(btn => btn.onclick = () => {
      signalFilter = btn.dataset.liveFilter;
      qa('[data-live-filter]').forEach(x => x.classList.toggle('active', x === btn));
      renderSignals();
    });
  }

  injectNav(); injectDashboardStrip(); injectView(); bindNav(); bindControls();
  loadOperations();
  setInterval(() => {
    if (document.hidden || q('#authGate')?.hidden === false) return;
    loadOperations();
  }, 5000);
})();

(() => {
  const q=s=>document.querySelector(s),qa=s=>[...document.querySelectorAll(s)],esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let sales={accounts:[],summary:{}};
  function injectStyle(){if(q('#atsSalesStyle'))return;const s=document.createElement('style');s.id='atsSalesStyle';s.textContent=`.sales-head{display:flex;justify-content:space-between;gap:20px;align-items:end;margin:8px 0 24px}.sales-head h2{font-size:38px;margin:5px 0}.sales-head p{color:#8da5bb;margin:0}.sales-kpis{display:grid;grid-template-columns:repeat(5,1fr);gap:12px;margin-bottom:16px}.sales-kpi{padding:20px;border:1px solid #1c3650;background:linear-gradient(145deg,#0c1929,#08131f);border-radius:18px}.sales-kpi span{display:block;color:#7e98b1;font-size:10px;letter-spacing:.12em}.sales-kpi b{display:block;font-size:30px;margin:7px 0}.sales-kpi small{color:#6c879f}.sales-list{display:grid;gap:9px}.sales-row{display:grid;grid-template-columns:1.5fr 1fr .8fr .8fr .8fr auto;gap:12px;align-items:center;padding:15px;border:1px solid #1a3046;border-radius:14px;background:#091522}.sales-row>div{display:grid;gap:3px}.sales-row span{font-size:10px;color:#708ca6}.sales-row b{font-size:13px}.sales-row small{color:#7892aa}.sales-pill{display:inline-flex;width:max-content;padding:6px 9px;border-radius:99px;background:#14273a;color:#a8c0d6;font-size:10px;font-weight:900}.sales-pill.ok{background:#12352d;color:#64e7c4}.sales-pill.trial{background:#30291a;color:#ffd477}.sales-open{border:1px solid #29506d;background:#0e2031;color:#aee1ff;border-radius:10px;padding:9px 11px;cursor:pointer}.sales-empty{padding:35px;text-align:center;color:#7892aa}@media(max-width:1100px){.sales-kpis{grid-template-columns:repeat(2,1fr)}.sales-row{grid-template-columns:1fr 1fr}}@media(max-width:680px){.sales-kpis,.sales-row{grid-template-columns:1fr}.sales-head{align-items:flex-start;flex-direction:column}}`;document.head.appendChild(s)}
  function injectNav(){const rail=q('.rail-nav');if(rail&&!rail.querySelector('[data-page="sales"]')){const op=rail.querySelector('[data-page="operations"]'),sys=rail.querySelector('[data-page="system"]');(op||sys)?.insertAdjacentHTML('beforebegin','<button data-page="sales"><span>＄</span><b>Vendas</b></button>')}const mobile=q('.mobile-bar');if(mobile&&!mobile.querySelector('[data-page="sales"]'))mobile.insertAdjacentHTML('beforeend','<button data-page="sales"><span>＄</span><b>Vendas</b></button>')}
  function injectView(){const workspace=q('.workspace');if(!workspace||q('[data-view="sales"]'))return;workspace.insertAdjacentHTML('beforeend',`<section class="view" data-view="sales"><section class="sales-head"><div><span class="eyebrow">FUNIL COMERCIAL</span><h2>Vendas e contas</h2><p>Cadastro → e-mail confirmado → Trial → assinatura.</p></div><button id="salesRefresh" class="btn primary">ATUALIZAR</button></section><div id="salesKpis" class="sales-kpis"></div><section class="section-card"><div class="section-head"><div><span class="eyebrow">CONTAS ATS</span><h3>Clientes cadastrados</h3><p>Contas criadas pelo site, Google ou e-mail.</p></div><span id="salesCount" class="count-badge">0</span></div><div id="salesList" class="sales-list"></div></section></section>`)}
  function render(){const s=sales.summary||{},rows=sales.accounts||[];q('#salesKpis').innerHTML=[['CADASTROS',s.accounts||0,'contas criadas'],['VERIFICADOS',s.verified||0,'e-mails confirmados'],['TRIALS',s.trials||0,'em teste'],['CLIENTES PAGOS',s.paid||0,'planos ativos'],['VENDAS',s.approvedOrders||0,'pagamentos aprovados']].map(([l,v,h])=>`<article class="sales-kpi"><span>${l}</span><b>${v}</b><small>${h}</small></article>`).join('');q('#salesCount').textContent=`${rows.length} CONTAS`;q('#salesList').innerHTML=rows.length?rows.map(a=>{const l=a.license||{},tone=l.plan==='trial'?'trial':l.status==='active'?'ok':'';return`<article class="sales-row"><div><b>${esc(a.name||'Cliente')}</b><small>${esc(a.email||'')}</small></div><div><span>CONTA</span><b>${a.emailVerified?'E-MAIL CONFIRMADO':'AGUARDANDO CONFIRMAÇÃO'}</b></div><div><span>PLANO</span><i class="sales-pill ${tone}">${esc(l.planLabel||l.plan||'SEM ACESSO')}</i></div><div><span>APARELHO</span><b>${l.deviceLocked?'VINCULADO':'LIVRE'}</b></div><div><span>PEDIDOS</span><b>${a.orders||0}</b></div><button class="sales-open" data-sales-license="${esc(a.currentLicenseKey||'')}">VER ACESSO</button></article>`}).join(''):'<div class="sales-empty">Nenhuma conta criada pelo site ainda.</div>';qa('[data-sales-license]').forEach(b=>b.onclick=()=>{if(!b.dataset.salesLicense)return;selectedLicenseKey=b.dataset.salesLicense;setPage('licenses');renderLicenses();renderInspector()})}
  async function load(){try{sales=await api('/v1/admin/customer-accounts');render()}catch(e){if(e.status!==401)toast(`Vendas: ${e.message}`)}}
  injectStyle();injectNav();injectView();const prev=setPage;setPage=function(name){prev(name);if(name==='sales'){q('#pageTitle').textContent='Vendas e contas';q('#pageSub').textContent='Funil de cadastro, Trial, pagamento e conversão.';load()}};qa('[data-page="sales"]').forEach(b=>b.onclick=()=>setPage('sales'));q('#salesRefresh')?.addEventListener('click',load);setInterval(()=>{if(!document.hidden&&q('[data-view="sales"]')?.classList.contains('active'))load()},15000);
})();