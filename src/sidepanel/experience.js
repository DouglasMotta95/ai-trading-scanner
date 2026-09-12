(() => {
  if (globalThis.__ATS_EXPERIENCE__) return;
  globalThis.__ATS_EXPERIENCE__ = true;

  const $ = id => document.getElementById(id);
  const money = v => Number.isFinite(Number(v)) ? new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format(Number(v)) : 'não identificado';
  let state = {}, prefs = {}, readBusy = false, lastRead = 0;

  function style() {
    if ($('atsExperienceStyle')) return;
    const s = document.createElement('style');
    s.id = 'atsExperienceStyle';
    s.textContent = `
      .config-panel{border-color:#4b73ff35;background:linear-gradient(145deg,#0b1830,#080d16)}
      .config-panel .line-controls{grid-template-columns:repeat(3,1fr)}
      .config-panel input{width:100%;border:0;outline:0;background:transparent;color:#e3e8f0;font-size:10px;font-weight:1000}
      .platform-confirm{display:grid;grid-template-columns:repeat(3,1fr);gap:7px;margin-top:10px}
      .platform-confirm>div{padding:10px;border-radius:11px;background:#060b11;border:1px solid #ffffff09}
      .platform-confirm span{display:block;color:#59677b;font-size:6px;letter-spacing:.9px;margin-bottom:4px}.platform-confirm b{font-size:9px;color:#d5deeb}
      .sync-row{display:grid;grid-template-columns:1fr auto;gap:8px;align-items:center;margin-top:9px;padding:10px 11px;border-radius:12px;background:#060b11;border:1px solid #ffffff09}
      .sync-row strong{display:block;font-size:8px}.sync-row small{display:block;color:#6e7d92;font-size:7px;margin-top:3px;line-height:1.4}
      .sync-row.ok{border-color:#3bd99b38;background:#071810}.sync-row.warn{border-color:#e7bd3c30;background:#191407}.sync-row.bad{border-color:#ff657a2c;background:#1b0b0e}
      #syncPlatformBtn{padding:9px 11px;border-radius:9px;border:1px solid #6d83ff38;background:#18244b;color:#b9c5ff;font-size:7px;font-weight:1000;cursor:pointer}
      .execution-panel{border-color:#ffffff12}.execution-panel.signal-ready{border-color:#43df9f43;box-shadow:0 0 34px #42d99b12}.execution-panel.signal-ready.sell-ready{border-color:#ff657a3d;box-shadow:0 0 34px #ff657a10}
      .execution-panel .section-note{line-height:1.5}.truth-note{margin-top:8px;color:#76869a;font-size:7px;line-height:1.45}.truth-note b{color:#b6c1d0}
      .recent-flow{margin-top:9px;padding:10px 11px;border:1px solid #ffffff08;border-radius:11px;background:#060b11;display:flex;justify-content:space-between;gap:10px;align-items:center}
      .recent-flow span{color:#64748a;font-size:7px}.recent-flow b{font-size:8px;color:#cbd5e4}
      @media(max-width:430px){.config-panel .line-controls,.platform-confirm{grid-template-columns:1fr}}
    `;
    document.head.appendChild(s);
  }

  function organize() {
    style();
    const market = document.querySelector('.market-hero'), config = document.querySelector('.config-panel'), execution = document.querySelector('.execution-panel');
    if (market && config && market.previousElementSibling !== config) market.before(config);
    if (market && execution && market.nextElementSibling !== execution) market.after(execution);
    const grid = document.querySelector('.analysis-grid');
    if (grid && !$('recentFlowText')) grid.insertAdjacentHTML('afterend','<div class="recent-flow"><span>ÚLTIMAS VELAS</span><b id="recentFlowText">aguardando histórico real</b></div>');
  }

  async function loadPrefs() {
    const {settings={}} = await chrome.storage.local.get('settings');
    prefs = settings.scanPreferences || {};
    const el = $('tradeAmount');
    if (el && document.activeElement !== el) el.value = Number(prefs.tradeAmount ?? prefs.stake) > 0 ? String(prefs.tradeAmount ?? prefs.stake).replace('.',',') : '';
  }
  async function savePrefs() {
    const amount = Number(String($('tradeAmount')?.value || '').replace(',','.'));
    const timeframe = $('analysisTimeframe')?.value || '';
    const expiration = $('targetExpiration')?.value || '';
    const {settings={}} = await chrome.storage.local.get('settings');
    const next = {...(settings.scanPreferences||{}),tradeAmount:amount,stake:amount,timeframe,expiration,preflightConfigured:Number.isFinite(amount)&&amount>0&&timeframe&&timeframe!=='AUTO'&&expiration&&expiration!=='AUTO'};
    await chrome.storage.local.set({settings:{...settings,scanPreferences:next}});
    prefs = next;
  }
  function configured() {
    const amount = Number(prefs.tradeAmount ?? prefs.stake);
    return Number.isFinite(amount)&&amount>0&&prefs.timeframe&&prefs.timeframe!=='AUTO'&&prefs.expiration&&prefs.expiration!=='AUTO';
  }
  const aligned = s => !!s?.platformControls?.aligned;

  async function syncNow() {
    await savePrefs();
    const row=$('platformSyncRow'), title=$('platformSyncTitle'), text=$('platformSyncText');
    row?.classList.remove('ok','bad'); row?.classList.add('warn');
    if(title) title.textContent='Aplicando configuração...';
    if(text) text.textContent='Ajustando valor, vela e expiração na CasaTrade e conferindo o resultado.';
    const r = await chrome.runtime.sendMessage({type:'ATS_SYNC_PLATFORM_PREFERENCES'}).catch(()=>({ok:false,error:'sync_failed'}));
    await refresh(true);
    return r;
  }

  function renderTruth(s={}) {
    const p=s.platformControls||{}, o=p.observed||{}, row=$('platformSyncRow'), title=$('platformSyncTitle'), text=$('platformSyncText');
    if($('platformAmount')) $('platformAmount').textContent=o.amount==null?'não identificado':money(o.amount);
    if($('platformTimeframe')) $('platformTimeframe').textContent=o.timeframe||'não identificado';
    if($('platformExpiration')) $('platformExpiration').textContent=o.expiration||'não identificado';
    row?.classList.remove('ok','warn','bad');
    if(!configured()){
      row?.classList.add('warn'); if(title)title.textContent='Defina valor, vela e expiração'; if(text)text.textContent='Preencha os três campos. O ATS vai aplicar e conferir tudo na CasaTrade.';
    }else if(!s.targetTabId||s.connection==='offline'){
      row?.classList.add('warn'); if(title)title.textContent='Conecte a CasaTrade'; if(text)text.textContent='Abra a plataforma e clique em CONECTAR CASATRADE. A configuração será aplicada automaticamente.';
    }else if(p.aligned){
      row?.classList.add('ok'); if(title)title.textContent='CasaTrade sincronizada'; if(text)text.textContent='Valor, vela e expiração conferidos. A análise usa exatamente o que está na plataforma.';
    }else{
      row?.classList.add('bad'); if(title)title.textContent='Ainda não está sincronizado';
      const miss=[!p.amountOk?'valor':null,!p.timeframeOk?'vela':null,!p.expirationOk?'expiração':null].filter(Boolean);
      if(text)text.textContent=`Não consegui confirmar ${miss.join(', ')||'os controles'} na CasaTrade. A análise fica bloqueada para não trabalhar com configuração diferente.`;
    }
  }

  function humanizeSignal(s={}) {
    const sig=s.signal||{}, st=String(sig.state||'WAIT'), dir=sig.direction;
    const title=$('scannerState'), badge=$('signalBadge'), gaugeDir=$('signalDirection'), hint=$('scannerHint'), structure=$('structureState');
    const names={BUY:'COMPRA',SELL:'VENDA'};
    if(gaugeDir) gaugeDir.textContent=names[dir]||'—';
    if(structure) structure.textContent=sig.provisional?'EM VALIDAÇÃO':'VALIDADOS';
    if(st==='CONFIRM') { if(title)title.textContent=`${names[dir]||'ENTRADA'} CONFIRMADA`; if(badge)badge.textContent=names[dir]||'ENTRAR'; }
    else if(st==='WATCH') { if(title)title.textContent='OPORTUNIDADE EM FORMAÇÃO'; if(badge)badge.textContent='OBSERVAR'; }
    else if(st==='SEARCHING') { if(title)title.textContent='ANALISANDO O MERCADO'; if(badge)badge.textContent='AGUARDAR'; }
    else if(st==='NO_TRADE') { if(title)title.textContent='NÃO ENTRAR AGORA'; if(badge)badge.textContent='NÃO ENTRAR'; }
    else { if(title)title.textContent='AGUARDANDO CONFIRMAÇÕES'; if(badge)badge.textContent='AGUARDAR'; }

    if(hint){
      if(!s.asset||!s.price) hint.textContent='Estou procurando o ativo e a cotação reais da CasaTrade. Ainda não vou gerar entrada.';
      else if(!aligned(s)) hint.textContent='Antes de analisar, preciso confirmar que valor, vela e expiração estão iguais na CasaTrade.';
      else if(sig.provisional) hint.textContent='Estou recebendo o movimento da plataforma, mas os dados ainda não foram validados. Posso observar, mas não vou inventar entrada.';
      else if(st==='SEARCHING') hint.textContent=`Estou analisando ${s.asset} em ${s.timeframe||'tempo não identificado'} com os dados reais da CasaTrade.`;
      else if(st==='WATCH') hint.textContent='O movimento chamou atenção, mas ainda faltam confirmações. Aguarde.';
      else if(st==='CONFIRM') hint.textContent=`${names[dir]||'Entrada'} confirmada. O botão correto foi liberado logo abaixo.`;
      else if(st==='NO_TRADE') hint.textContent='As condições atuais não passaram pelos filtros. Melhor não entrar agora.';
    }
    const recent=sig.recentFlow||{};
    if($('recentFlowText')) $('recentFlowText').textContent=recent.count>=3?`${recent.count} velas • ${recent.up||0} de alta • ${recent.down||0} de baixa`:'aguardando pelo menos 3 velas reais';
  }

  function enforceControls(s={}) {
    const sig=s.signal||{}, confirm=sig.state==='CONFIRM'&&aligned(s)&&!sig.provisional;
    const buy=$('prepareBuy'),sell=$('prepareSell'),panel=document.querySelector('.execution-panel'),toggle=$('toggleScanner');
    if(buy) buy.disabled=!(confirm&&sig.direction==='BUY');
    if(sell) sell.disabled=!(confirm&&sig.direction==='SELL');
    panel?.classList.toggle('signal-ready',confirm); panel?.classList.toggle('sell-ready',confirm&&sig.direction==='SELL');
    if(toggle){
      const canStart=s.connection==='online'&&s.license?.status==='active'&&configured()&&aligned(s);
      if(s.scanner!=='scanning') toggle.disabled=!canStart;
      const label=$('toggleLabel'); if(label) label.textContent=s.scanner==='scanning'?'PAUSAR ANÁLISE':canStart?'INICIAR ANÁLISE':'SINCRONIZE PARA INICIAR';
    }
    const note=$('manualStatus');
    if(note&&s.tradeIntent?.status!=='prepared') note.textContent=confirm?`${sig.direction==='BUY'?'COMPRA':'VENDA'} liberada • ${s.asset||'ativo'} • ${s.timeframe||'—'} • expiração ${s.expiration||'—'}. Clique somente na direção confirmada.`:'Quando houver uma entrada realmente confirmada, somente a direção correta será liberada aqui.';
  }

  function humanizeStatus(s={}) {
    const online=s.connection==='online'&&s.lastSeen&&Date.now()-s.lastSeen<7000, structured=!!s.capabilities?.structuredQuotes;
    const live=$('liveBadge'); if(live?.querySelector('span')) live.querySelector('span').textContent=online?'CONECTADO':'OFFLINE';
    if($('connectLabel')) $('connectLabel').textContent=online?'RECONECTAR CASATRADE':'CONECTAR CASATRADE';
    if($('feedMode')) $('feedMode').textContent=online?(structured?'VALIDADO':'EM VALIDAÇÃO'):'OFFLINE';
    if($('feedRail')) $('feedRail').textContent=online?(structured?'VALIDADO':'LENDO DADOS'):'SEM DADOS';
    if($('scannerRail')) $('scannerRail').textContent=s.scanner==='scanning'?'ANALISANDO':'PARADA';
    if($('timeframe')) $('timeframe').textContent=s.timeframe||'NÃO IDENTIFICADO';
    if($('expiration')) $('expiration').textContent=s.expiration||'NÃO IDENTIFICADO';
    if($('marketType')&&String($('marketType').textContent).toUpperCase()==='UNKNOWN') $('marketType').textContent='NÃO IDENTIFICADO';
  }

  async function refresh(forceRead=false) {
    try{
      state=await chrome.runtime.sendMessage({type:'ATS_GET_STATE'}).catch(()=>({}));
      await loadPrefs();
      const now=Date.now();
      if(!readBusy&&state.targetTabId&&(forceRead||now-lastRead>1800)){
        readBusy=true; lastRead=now;
        await chrome.runtime.sendMessage({type:'ATS_READ_PLATFORM_CONTROLS'}).catch(()=>null);
        readBusy=false;
        state=await chrome.runtime.sendMessage({type:'ATS_GET_STATE'}).catch(()=>state);
      }
      renderTruth(state); humanizeStatus(state); humanizeSignal(state); enforceControls(state);
    }catch{readBusy=false;}
  }

  document.addEventListener('change',e=>{if(['tradeAmount','analysisTimeframe','targetExpiration'].includes(e.target?.id)) syncNow();});
  document.addEventListener('blur',e=>{if(e.target?.id==='tradeAmount') syncNow();},true);
  document.addEventListener('click',e=>{
    const id=e.target?.closest?.('button')?.id;
    if(id==='toggleScanner'&&state.scanner!=='scanning'&&(!configured()||!aligned(state))){e.preventDefault();e.stopPropagation();e.stopImmediatePropagation();renderTruth(state);$('platformSyncRow')?.scrollIntoView({behavior:'smooth',block:'center'});return;}
    if(id==='prepareBuy'||id==='prepareSell'){
      const dir=id==='prepareBuy'?'BUY':'SELL';
      if(state.signal?.state!=='CONFIRM'||state.signal?.direction!==dir||state.signal?.provisional||!aligned(state)){e.preventDefault();e.stopPropagation();e.stopImmediatePropagation();}
    }
    if(id==='connectBtn'){setTimeout(()=>syncNow(),850);setTimeout(()=>refresh(true),1700);}
  },true);

  chrome.storage.onChanged.addListener(c=>{if(c.scannerState||c.settings)setTimeout(()=>refresh(false),40);});
  organize();
  loadPrefs().then(()=>refresh(true));
  setInterval(()=>refresh(false),500);
})();