(() => {
  if (globalThis.__ATS_PREFLIGHT__) return;
  globalThis.__ATS_PREFLIGHT__ = true;

  const $ = id => document.getElementById(id);
  let cachedState = {};
  let cachedPrefs = {};

  const tfMs = raw => {
    const s = String(raw || '').toUpperCase();
    let m = s.match(/^S(\d+)$/); if (m) return Number(m[1]) * 1000;
    m = s.match(/^M(\d+)$/); if (m) return Number(m[1]) * 60000;
    m = s.match(/^H(\d+)$/); if (m) return Number(m[1]) * 3600000;
    return 0;
  };
  const expMs = raw => {
    const s = String(raw || '').toLowerCase().replace(/\s+/g, '');
    let m = s.match(/^(\d+)s$/); if (m) return Number(m[1]) * 1000;
    m = s.match(/^(\d+)m(?:in)?$/); if (m) return Number(m[1]) * 60000;
    return 0;
  };
  const normTf = v => {
    const s = String(v || '').trim().toUpperCase();
    if (/^\d+S$/.test(s)) return `S${s.replace('S','')}`;
    if (/^\d+M$/.test(s)) return `M${s.replace('M','')}`;
    return s;
  };
  const normExp = v => {
    const s = String(v || '').trim().toLowerCase().replace(/\s+/g, '');
    const m = s.match(/^(\d+)(s|seg|segundos?|m|min|minutos?)$/);
    if (!m) return s;
    return /^(s|seg)/.test(m[2]) ? `${Number(m[1])}s` : `${Number(m[1])}m`;
  };
  const money = v => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(v || 0));

  function inject() {
    if ($('atsPreflight')) return;
    const style = document.createElement('style');
    style.textContent = `
      [hidden]{display:none!important}html,body{min-width:360px}
      .ats-preflight{margin:0 0 10px;padding:16px;border:1px solid #7d6a2d;background:linear-gradient(145deg,#1d1809,#0a0d13);border-radius:18px;color:#f6f8fb}
      .ats-preflight.ready{border-color:#2e725c;background:linear-gradient(145deg,#081b14,#0a0d13)}
      .ats-preflight-head{display:flex;justify-content:space-between;gap:12px;align-items:center}.ats-preflight-head b{font-size:13px}.ats-preflight-head small{display:block;color:#8d9bad;font-size:8px;margin-top:4px;line-height:1.45}.ats-preflight-badge{padding:6px 8px;border-radius:9px;background:#2a220b;color:#f0ca67;font-size:7px;font-weight:1000;letter-spacing:.7px}.ats-preflight.ready .ats-preflight-badge{background:#0d2b20;color:#67e9b2}
      .ats-preflight-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:12px}.ats-preflight label{display:grid;gap:5px;padding:9px;border:1px solid #ffffff0c;border-radius:11px;background:#060a10}.ats-preflight label span{font-size:6px;color:#67768a;letter-spacing:.9px}.ats-preflight input,.ats-preflight select{width:100%;border:0;outline:0;background:transparent;color:#fff;font-size:10px;font-weight:900}.ats-preflight option{background:#0b1119}.ats-preflight-save{width:100%;margin-top:9px;padding:12px;border:0;border-radius:11px;background:linear-gradient(120deg,#5b73f1,#68d6ff);color:white;font-size:8px;font-weight:1000;cursor:pointer}.ats-preflight-status{display:block;margin-top:9px;padding:8px 9px;border-radius:9px;background:#080c12;color:#e9c967;font-size:8px;line-height:1.45}.ats-preflight.ready .ats-preflight-status{color:#82dcbf}.ats-universe{margin-top:10px;padding:15px;border:1px solid #ffffff0d;background:#070c13;border-radius:18px}.ats-universe-head{display:flex;justify-content:space-between;gap:10px;align-items:center}.ats-universe-head b{font-size:12px}.ats-universe-head small{color:#65758a;font-size:7px}.ats-universe-list{display:grid;gap:7px;margin-top:10px}.ats-universe-row{display:grid;grid-template-columns:1fr auto auto;gap:8px;align-items:center;padding:10px;border:1px solid #ffffff08;border-radius:11px;background:#060a10}.ats-universe-row strong{font-size:10px}.ats-universe-row small{display:block;color:#6f7f93;font-size:7px;margin-top:2px}.ats-universe-row em{font-style:normal;font-size:7px;font-weight:1000}.ats-universe-row .buy{color:#66e7af}.ats-universe-row .sell{color:#ff8296}.ats-universe-row .watch{color:#e9c967}.ats-universe-empty{color:#6d7b8d;font-size:8px;line-height:1.45;padding:6px 0}
      @media(max-width:430px){.ats-preflight-grid{grid-template-columns:1fr}}
    `;
    document.head.appendChild(style);

    const card = document.createElement('section');
    card.id = 'atsPreflight';
    card.className = 'ats-preflight';
    card.innerHTML = `
      <div class="ats-preflight-head"><div><b>ANTES DE INICIAR</b><small>Defina valor, vela e expiração. O scanner bloqueia combinações perigosas.</small></div><span id="atsPreflightBadge" class="ats-preflight-badge">CONFIGURAR</span></div>
      <div class="ats-preflight-grid">
        <label><span>VALOR PLANEJADO</span><input id="atsStake" inputmode="decimal" placeholder="Ex.: 20,00"></label>
        <label><span>ANALISAR</span><select id="atsScope"><option value="all">TODOS OS ATIVOS DETECTADOS</option><option value="current">SOMENTE ATIVO ATUAL</option></select></label>
        <label><span>VELA / TIMEFRAME</span><select id="atsTf"><option value="">SELECIONE</option><option value="S5">S5 • 5 SEG</option><option value="S15">S15 • 15 SEG</option><option value="S30">S30 • 30 SEG</option><option value="M1">M1 • 1 MIN</option><option value="M5">M5 • 5 MIN</option><option value="M15">M15 • 15 MIN</option></select></label>
        <label><span>EXPIRAÇÃO DA ENTRADA</span><select id="atsExp"><option value="">SELECIONE</option><option value="5s">5 SEG</option><option value="15s">15 SEG</option><option value="30s">30 SEG</option><option value="60s">1 MIN</option><option value="2m">2 MIN</option><option value="5m">5 MIN</option></select></label>
      </div>
      <button id="atsPreflightSave" class="ats-preflight-save">SALVAR CONFIGURAÇÃO</button>
      <span id="atsPreflightStatus" class="ats-preflight-status">Configure antes de iniciar a leitura.</span>
    `;
    const anchor = document.querySelector('.rail-status') || document.querySelector('.market-hero');
    anchor?.before(card);

    const universe = document.createElement('section');
    universe.id = 'atsUniverse';
    universe.className = 'ats-universe';
    universe.innerHTML = `<div class="ats-universe-head"><div><b>RADAR DE ATIVOS ABERTOS</b><small>Analisa os ativos estruturados detectados no feed.</small></div><span id="atsUniverseCount" class="ats-preflight-badge">0</span></div><div id="atsUniverseList" class="ats-universe-list"><div class="ats-universe-empty">Inicie o scanner para aquecer cada ativo detectado.</div></div>`;
    const universeAnchor = document.querySelector('.universe-panel');
    universeAnchor?.before(universe);

    $('atsPreflightSave').addEventListener('click', save);
  }

  async function loadPrefs() {
    const { settings = {} } = await chrome.storage.local.get('settings');
    cachedPrefs = settings.scanPreferences || {};
    if ($('atsStake')) $('atsStake').value = cachedPrefs.stake ? String(cachedPrefs.stake).replace('.', ',') : '';
    if ($('atsScope')) $('atsScope').value = cachedPrefs.scanScope || 'all';
    if ($('atsTf')) $('atsTf').value = cachedPrefs.timeframe && cachedPrefs.timeframe !== 'AUTO' ? cachedPrefs.timeframe : '';
    if ($('atsExp')) $('atsExp').value = cachedPrefs.expiration && cachedPrefs.expiration !== 'AUTO' ? cachedPrefs.expiration : '';
  }

  function validate(prefs, state) {
    const stake = Number(String(prefs.stake ?? '').replace(',', '.'));
    if (!Number.isFinite(stake) || stake <= 0) return { ok: false, text: 'Informe o valor planejado da entrada.' };
    if (!prefs.timeframe || prefs.timeframe === 'AUTO') return { ok: false, text: 'Escolha o tempo da vela antes de iniciar.' };
    if (!prefs.expiration || prefs.expiration === 'AUTO') return { ok: false, text: 'Escolha a expiração da entrada antes de iniciar.' };
    const t = tfMs(prefs.timeframe), e = expMs(prefs.expiration);
    if (t && e && e < t) return { ok: false, text: `Bloqueado: expiração ${prefs.expiration} é menor que a vela ${prefs.timeframe}. Ajuste para evitar entrada fora do tempo.` };
    const platformTf = normTf(state?.timeframe);
    if (platformTf && !['AUTO','UNKNOWN'].includes(platformTf) && platformTf !== normTf(prefs.timeframe)) return { ok: false, text: `A CasaTrade está em ${platformTf}, mas o scanner está configurado em ${prefs.timeframe}. Alinhe o gráfico antes de iniciar.` };
    const platformExp = normExp(state?.expiration);
    if (platformExp && platformExp !== 'unknown' && expMs(platformExp) && expMs(platformExp) !== expMs(prefs.expiration)) return { ok: false, text: `A CasaTrade está com expiração ${platformExp}, mas você escolheu ${prefs.expiration}. Ajuste a expiração na plataforma antes de iniciar.` };
    return { ok: true, text: `Pronto • ${money(stake)} • ${prefs.timeframe} • expiração ${prefs.expiration} • ${prefs.scanScope === 'current' ? 'ativo atual' : 'todos os ativos'}` };
  }

  async function save() {
    const stake = Number(String($('atsStake').value || '').replace(',', '.'));
    const next = {
      ...cachedPrefs,
      stake,
      scanScope: $('atsScope').value || 'all',
      timeframe: $('atsTf').value,
      expiration: $('atsExp').value,
      preflightConfigured: true
    };
    const check = validate(next, cachedState);
    $('atsPreflightStatus').textContent = check.text;
    if (!check.ok) return;
    const { settings = {} } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...settings, scanPreferences: next } });
    cachedPrefs = next;
    if ($('analysisTimeframe')) $('analysisTimeframe').value = next.timeframe;
    if ($('targetExpiration')) $('targetExpiration').value = next.expiration;
    renderPreflight();
  }

  function renderPreflight() {
    if (!$('atsPreflight')) return;
    const check = validate(cachedPrefs, cachedState);
    $('atsPreflight').classList.toggle('ready', check.ok);
    $('atsPreflightBadge').textContent = check.ok ? 'PRONTO' : 'CONFIGURAR';
    $('atsPreflightStatus').textContent = check.text;
    const manual = $('manualStatus');
    if (manual && cachedPrefs.stake && cachedState?.tradeIntent?.status !== 'prepared') {
      manual.textContent = `Plano de entrada: ${money(cachedPrefs.stake)} • vela ${cachedPrefs.timeframe || '—'} • expiração ${cachedPrefs.expiration || '—'}. A ordem final continua manual.`;
    }
  }

  function renderUniverse() {
    const list = Array.isArray(cachedState?.universeAnalysis) ? cachedState.universeAnalysis : [];
    if (!$('atsUniverseList')) return;
    $('atsUniverseCount').textContent = String(list.length);
    if (!list.length) {
      $('atsUniverseList').innerHTML = `<div class="ats-universe-empty">${cachedPrefs.scanScope === 'current' ? 'Radar multiativo desativado nesta configuração.' : 'Aguardando cotações estruturadas dos ativos abertos.'}</div>`;
      return;
    }
    $('atsUniverseList').innerHTML = list.slice(0, 6).map(x => {
      const s = x.signal || {}, dir = s.direction || '—', cls = dir === 'BUY' ? 'buy' : dir === 'SELL' ? 'sell' : 'watch';
      const status = s.state === 'CONFIRM' ? 'PRONTO P/ CONFIRMAR' : s.state === 'WATCH' ? 'OBSERVAR' : s.state === 'SEARCHING' ? 'AQUECENDO' : s.state || 'AGUARDAR';
      return `<div class="ats-universe-row"><div><strong>${String(x.asset || '—')}</strong><small>${String(x.timeframe || '—')} • exp. ${String(x.expiration || '—')} • ${Math.min(Number(s.warmup?.current || 0), 21)}/21 candles</small></div><em class="${cls}">${dir}</em><em class="${cls}">${status} • ${Math.round(Number(s.score || 0))}</em></div>`;
    }).join('');
  }

  async function refresh() {
    try {
      const [state, stored] = await Promise.all([
        chrome.runtime.sendMessage({ type: 'ATS_GET_STATE' }).catch(() => ({})),
        chrome.storage.local.get('settings')
      ]);
      cachedState = state || {};
      cachedPrefs = stored.settings?.scanPreferences || cachedPrefs || {};
      renderPreflight();
      renderUniverse();
    } catch {}
  }

  document.addEventListener('click', e => {
    const btn = e.target?.closest?.('#toggleScanner');
    if (!btn || cachedState?.scanner === 'scanning') return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    const check = validate(cachedPrefs, cachedState);
    if (!check.ok) {
      $('atsPreflightStatus').textContent = check.text;
      $('atsPreflight')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    chrome.runtime.sendMessage({ type: 'ATS_SET_SCANNER', enabled: true }).catch(() => {});
  }, true);

  inject();
  loadPrefs().then(refresh);
  chrome.storage.onChanged.addListener(changes => {
    if (changes.settings) {
      cachedPrefs = changes.settings.newValue?.scanPreferences || {};
      renderPreflight();
    }
    if (changes.scannerState) {
      cachedState = changes.scannerState.newValue || {};
      renderPreflight();
      renderUniverse();
    }
  });
  setInterval(refresh, 1500);
})();
