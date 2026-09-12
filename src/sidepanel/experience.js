(() => {
  if (globalThis.__ATS_EXPERIENCE__) return;
  globalThis.__ATS_EXPERIENCE__ = true;

  const $ = id => document.getElementById(id);
  const money = v => Number.isFinite(Number(v)) ? new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(v)) : 'não identificado';
  const normTf = v => String(v || '').trim().toUpperCase();
  const normExp = v => String(v || '').trim().toLowerCase().replace(/\s+/g, '');
  let state = {};
  let prefs = {};
  let readBusy = false;
  let lastRead = 0;

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
      .execution-panel .section-note{line-height:1.5}
      .truth-note{margin-top:8px;color:#76869a;font-size:7px;line-height:1.45}.truth-note b{color:#b6c1d0}
      @media(max-width:430px){.config-panel .line-controls,.platform-confirm{grid-template-columns:1fr}}
    `;
    document.head.appendChild(s);
  }

  function organize() {
    style();
    const market = document.querySelector('.market-hero');
    const config = document.querySelector('.config-panel');
    const execution = document.querySelector('.execution-panel');
    const analysis = document.querySelector('.analysis-panel');
    if (market && config && market.previousElementSibling !== config) market.before(config);
    if (market && execution && market.nextElementSibling !== execution) market.after(execution);
    if (analysis && execution && analysis.previousElementSibling !== execution && market) market.after(execution);

    const brandSub = document.querySelector('.brand p'); if (brandSub) brandSub.textContent = 'TERMINAL INTELIGENTE DE MERCADO';
    const execEye = execution?.querySelector('.eyebrow'); if (execEye) execEye.textContent = 'ENTRADA NA PLATAFORMA';
    const execTitle = execution?.querySelector('h2'); if (execTitle) execTitle.textContent = 'Sua entrada aparece aqui';
    const safe = execution?.querySelector('.mini-tag'); if (safe) safe.textContent = 'CONFIRMAÇÃO MANUAL';
    const universe = document.querySelector('.universe-panel');
    if (universe) { const e = universe.querySelector('.eyebrow'); const h = universe.querySelector('h2'); if (e) e.textContent = 'ATIVOS ENCONTRADOS'; if (h) h.textContent = 'Radar da plataforma'; }
    const configEye = config?.querySelector('.eyebrow'); if (configEye) configEye.textContent = 'CONFIGURAÇÃO DA OPERAÇÃO';
    const configTitle = config?.querySelector('h2'); if (configTitle) configTitle.textContent = 'Defina como quer operar';
    const configTag = config?.querySelector('.mini-tag'); if (configTag) configTag.textContent = 'SINCRONIZA COM A CASATRADE';

    const controls = config?.querySelector('.line-controls');
    if (controls && !$('tradeAmount')) {
      const label = document.createElement('label');
      label.innerHTML = '<small>VALOR DA ENTRADA</small><input id="tradeAmount" inputmode="decimal" placeholder="Ex.: 20,00" autocomplete="off">';
      controls.prepend(label);
    }
    if (config && !$('platformObserved')) {
      config.insertAdjacentHTML('beforeend', `
        <div id="platformObserved" class="platform-confirm">
          <div><span>VALOR NA CASATRADE</span><b id="platformAmount">não identificado</b></div>
          <div><span>VELA NA CASATRADE</span><b id="platformTimeframe">não identificado</b></div>
          <div><span>EXPIRAÇÃO NA CASATRADE</span><b id="platformExpiration">não identificado</b></div>
        </div>
        <div id="platformSyncRow" class="sync-row warn"><div><strong id="platformSyncTitle">Conecte a CasaTrade</strong><small id="platformSyncText">O ATS só inicia a leitura quando valor, vela e expiração estiverem iguais nos dois lados.</small></div><button id="syncPlatformBtn">APLICAR DE NOVO</button></div>
        <p class="truth-note"><b>Fonte de verdade:</b> o ATS lê de volta o que ficou configurado na CasaTrade. Se não conseguir confirmar, a leitura fica bloqueada.</p>
      `);
      $('syncPlatformBtn')?.addEventListener('click', syncNow);
    }

    const tf = $('analysisTimeframe');
    if (tf && ![...tf.options].some(o => o.value === 'M2')) {
      const o = document.createElement('option'); o.value = 'M2'; o.textContent = 'M2 • 2 MIN';
      const m5 = [...tf.options].find(o => o.value === 'M5'); tf.insertBefore(o, m5 || null);
    }
    $('prepareBuy')?.querySelector('strong') && ($('prepareBuy').querySelector('strong').textContent = 'COMPRA');
    $('prepareBuy')?.querySelector('small') && ($('prepareBuy').querySelector('small').textContent = 'PREPARAR ENTRADA');
    $('prepareSell')?.querySelector('strong') && ($('prepareSell').querySelector('strong').textContent = 'VENDA');
    $('prepareSell')?.querySelector('small') && ($('prepareSell').querySelector('small').textContent = 'PREPARAR ENTRADA');
  }

  async function loadPrefs() {
    const { settings = {} } = await chrome.storage.local.get('settings');
    prefs = settings.scanPreferences || {};
    const amount = $('tradeAmount'); if (amount && document.activeElement !== amount) amount.value = Number(prefs.tradeAmount ?? prefs.stake) > 0 ? String(prefs.tradeAmount ?? prefs.stake).replace('.', ',') : '';
  }
  async function savePrefs() {
    const amount = Number(String($('tradeAmount')?.value || '').replace(',', '.'));
    const tf = $('analysisTimeframe')?.value || '';
    const exp = $('targetExpiration')?.value || '';
    const { settings = {} } = await chrome.storage.local.get('settings');
    const next = { ...(settings.scanPreferences || {}), tradeAmount: amount, stake: amount, timeframe: tf, expiration: exp, preflightConfigured: Number.isFinite(amount) && amount > 0 && !!tf && tf !== 'AUTO' && !!exp && exp !== 'AUTO' };
    await chrome.storage.local.set({ settings: { ...settings, scanPreferences: next } });
    prefs = next;
  }
  async function syncNow() {
    await savePrefs();
    const title = $('platformSyncTitle'), text = $('platformSyncText'), row = $('platformSyncRow');
    if (title) title.textContent = 'Aplicando configuração...';
    if (text) text.textContent = 'Estou ajustando valor, vela e expiração diretamente na CasaTrade e depois vou conferir.';
    row?.classList.remove('ok', 'bad'); row?.classList.add('warn');
    const r = await chrome.runtime.sendMessage({ type: 'ATS_SYNC_PLATFORM_PREFERENCES' }).catch(() => ({ ok: false, error: 'sync_failed' }));
    await refresh(true);
    return r;
  }
  function aligned(s = state) { return !!s.platformControls?.aligned; }
  function configured() {
    const amount = Number(prefs.tradeAmount ?? prefs.stake);
    return Number.isFinite(amount) && amount > 0 && !!prefs.timeframe && prefs.timeframe !== 'AUTO' && !!prefs.expiration && prefs.expiration !== 'AUTO';
  }
  function renderTruth(s = {}) {
    const p = s.platformControls || {}, o = p.observed || {};
    if ($('platformAmount')) $('platformAmount').textContent = o.amount == null ? 'não identificado' : money(o.amount);
    if ($('platformTimeframe')) $('platformTimeframe').textContent = o.timeframe || 'não identificado';
    if ($('platformExpiration')) $('platformExpiration').textContent = o.expiration || 'não identificado';
    const row = $('platformSyncRow'), title = $('platformSyncTitle'), text = $('platformSyncText');
    row?.classList.remove('ok', 'warn', 'bad');
    if (!configured()) {
      row?.classList.add('warn'); if (title) title.textContent = 'Defina valor, vela e expiração'; if (text) text.textContent = 'Preencha os três campos. Depois o ATS aplica tudo na CasaTrade e confere o resultado.';
    } else if (!s.targetTabId || s.connection === 'offline') {
      row?.classList.add('warn'); if (title) title.textContent = 'Conecte a CasaTrade'; if (text) text.textContent = 'Abra a plataforma e clique em CONECTAR. A configuração será aplicada automaticamente.';
    } else if (p.aligned) {
      row?.classList.add('ok'); if (title) title.textContent = 'CasaTrade sincronizada'; if (text) text.textContent = 'Valor, vela e expiração conferidos. A análise usa exatamente o que está na plataforma.';
    } else {
      row?.classList.add('bad'); if (title) title.textContent = 'Configuração ainda não bate';
      const miss = [!p.amountOk ? 'valor' : null, !p.timeframeOk ? 'vela' : null, !p.expirationOk ? 'expiração' : null].filter(Boolean);
      if (text) text.textContent = `Ainda não consegui confirmar ${miss.join(', ') || 'os controles'} na CasaTrade. A leitura permanece bloqueada para não analisar um tempo diferente.`;
    }
  }
  function humanizeSignal(s = {}) {
    const sig = s.signal || {}, st = String(sig.state || 'WAIT');
    const hint = $('scannerHint');
    if (!hint) return;
    if (!s.asset || !s.price) hint.textContent = 'Estou procurando o ativo e a cotação reais da CasaTrade. Ainda não vou gerar entrada.';
    else if (!aligned(s)) hint.textContent = 'Antes de analisar, preciso confirmar que valor, vela e expiração estão iguais na CasaTrade.';
    else if (sig.provisional) hint.textContent = 'Estou recebendo movimento da plataforma, mas o feed ainda não foi validado. Posso observar, mas não vou inventar uma entrada.';
    else if (st === 'SEARCHING') hint.textContent = `Estou analisando ${s.asset} em ${s.timeframe || 'tempo não identificado'} com os dados reais recebidos da plataforma.`;
    else if (st === 'WATCH') hint.textContent = 'Existe movimento interessante, mas ainda faltam confirmações. Aguarde antes de entrar.';
    else if (st === 'CONFIRM') hint.textContent = `${sig.direction === 'SELL' ? 'Venda' : 'Compra'} confirmada pelo motor. Confira o card de entrada logo abaixo.`;
    else if (st === 'NO_TRADE') hint.textContent = 'As condições atuais não passaram pelos filtros. Melhor não entrar agora.';
  }
  function enforceTradeButtons(s = {}) {
    const sig = s.signal || {}, confirm = sig.state === 'CONFIRM' && aligned(s) && !sig.provisional;
    const buy = $('prepareBuy'), sell = $('prepareSell'), panel = document.querySelector('.execution-panel');
    if (buy) buy.disabled = !(confirm && sig.direction === 'BUY');
    if (sell) sell.disabled = !(confirm && sig.direction === 'SELL');
    panel?.classList.toggle('signal-ready', confirm);
    panel?.classList.toggle('sell-ready', confirm && sig.direction === 'SELL');
    const note = $('manualStatus');
    if (note && s.tradeIntent?.status !== 'prepared') {
      note.textContent = confirm
        ? `${sig.direction === 'BUY' ? 'COMPRA' : 'VENDA'} liberada • ${s.asset || 'ativo'} • ${s.timeframe || '—'} • expiração ${s.expiration || '—'}. Clique apenas na direção confirmada.`
        : 'Quando houver uma entrada realmente confirmada, o botão correto será liberado aqui. Antes disso, nenhuma direção fica disponível.';
    }
  }
  async function refresh(forceRead = false) {
    try {
      state = await chrome.runtime.sendMessage({ type: 'ATS_GET_STATE' }).catch(() => ({}));
      await loadPrefs();
      const now = Date.now();
      if (!readBusy && state.targetTabId && (forceRead || now - lastRead > 1800)) {
        readBusy = true; lastRead = now;
        await chrome.runtime.sendMessage({ type: 'ATS_READ_PLATFORM_CONTROLS' }).catch(() => null);
        readBusy = false;
        state = await chrome.runtime.sendMessage({ type: 'ATS_GET_STATE' }).catch(() => state);
      }
      renderTruth(state); humanizeSignal(state); enforceTradeButtons(state);
      if ($('timeframe')) $('timeframe').textContent = state.timeframe || 'NÃO IDENTIFICADO';
      if ($('expiration')) $('expiration').textContent = state.expiration || 'NÃO IDENTIFICADO';
    } catch { readBusy = false; }
  }

  document.addEventListener('change', async e => {
    if (!['analysisTimeframe', 'targetExpiration'].includes(e.target?.id)) return;
    await syncNow();
  });
  $('tradeAmount')?.addEventListener('change', syncNow);
  document.addEventListener('blur', e => { if (e.target?.id === 'tradeAmount') syncNow(); }, true);
  document.addEventListener('click', e => {
    const id = e.target?.closest?.('button')?.id;
    if (id === 'toggleScanner' && state.scanner !== 'scanning') {
      if (!configured() || !aligned(state)) {
        e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
        renderTruth(state);
        $('platformSyncRow')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
      }
    }
    if (id === 'prepareBuy' || id === 'prepareSell') {
      const dir = id === 'prepareBuy' ? 'BUY' : 'SELL';
      if (state.signal?.state !== 'CONFIRM' || state.signal?.direction !== dir || state.signal?.provisional || !aligned(state)) {
        e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
      }
    }
    if (id === 'connectBtn') setTimeout(() => syncNow(), 850);
  }, true);

  chrome.storage.onChanged.addListener(c => { if (c.scannerState || c.settings) setTimeout(() => refresh(false), 40); });
  organize();
  loadPrefs().then(() => {
    const amount = $('tradeAmount'); if (amount) amount.addEventListener('change', syncNow);
    refresh(true);
  });
  setInterval(() => refresh(false), 900);
})();