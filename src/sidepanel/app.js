const PUBLIC_API = 'https://ats-control-center-v07-production.up.railway.app';
const LAST_VALID_LICENSE_KEY = 'atsLastValidLicense';
const $ = id => document.getElementById(id);
const connectBtn = $('connectBtn');
const toggleBtn = $('toggleScanner');
const tfSelect = $('analysisTimeframe');
const expSelect = $('targetExpiration');
const amountInput = $('tradeAmount');
const buyBtn = $('prepareBuy');
const sellBtn = $('prepareSell');
const scoreGauge = $('scoreGauge');
const extensionVersion = $('extensionVersion');
if (extensionVersion) extensionVersion.textContent = `v${chrome.runtime.getManifest().version}`;

let requested = false;
let lastError = '';
let lastState = {};
let prefs = {};
let autoConnectAt = 0;
let syncBusy = false;

const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = v => v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null;
const money = v => num(v) == null ? 'Não identificado' : new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(v));
const fresh = s => s.connection === 'online' && s.lastSeen && Date.now() - s.lastSeen < 8000;
const activeLicense = s => s.license?.status === 'active';
const licenseStillValid = l => {
  if (l?.status !== 'active') return false;
  if (!l.expiresAt) return true;
  const t = Date.parse(l.expiresAt);
  return Number.isFinite(t) && t > Date.now();
};
const effectiveLicense = (stateLicense = {}, cachedEntry = null) => {
  if (licenseStillValid(stateLicense)) return stateLicense;
  if (['expired', 'limit', 'device_locked'].includes(String(stateLicense?.status || ''))) return stateLicense;
  const cached = cachedEntry?.license;
  if (licenseStillValid(cached)) return { ...cached, status: 'active', error: 'backend_unreachable', syncPending: true };
  if (stateLicense?.status === 'active' && !licenseStillValid(stateLicense)) return { ...stateLicense, status: 'expired', error: 'license_expired', syncPending: false };
  return stateLicense;
};
const normalizeTf = v => String(v || '').trim().toUpperCase();
const normalizeExp = v => String(v || '').trim().toLowerCase().replace(/\s+/g, '');
const configuredPrefs = p => {
  const amount = num(p.tradeAmount ?? p.stake);
  return amount != null && amount > 0 && p.timeframe && p.timeframe !== 'AUTO' && p.expiration && p.expiration !== 'AUTO';
};
const aligned = s => !!s.platformControls?.aligned;
const setDot = (id, on) => { const el = $(id); if (el) el.className = on ? 'on' : ''; };
const ensureOption = (select, value) => {
  value = String(value || '').trim();
  if (!select || !value || [...select.options].some(o => o.value === value)) return;
  const o = document.createElement('option');
  o.value = value; o.textContent = value; select.appendChild(o);
};

function usageText(l = {}) {
  const trial = l.isTrial || l.plan === 'trial';
  if (trial && l.totalLimit != null) return `Teste: ${Number(l.usedTotal) || 0}/${l.totalLimit} • ${l.remainingTotal ?? Math.max(0, l.totalLimit - (Number(l.usedTotal) || 0))} restantes`;
  if (l.dailyLimit == null) return `Uso diário: ${Number(l.usedToday) || 0} • sem limite`;
  return `Uso diário: ${Number(l.usedToday) || 0}/${l.dailyLimit} • ${l.remainingToday ?? Math.max(0, l.dailyLimit - (Number(l.usedToday) || 0))} restantes`;
}

function renderLicense(s = {}) {
  const l = s.license || {};
  const active = l.status === 'active';
  const waiting = active && (l.syncPending || l.error === 'backend_unreachable');
  const trial = l.isTrial || l.plan === 'trial';
  const limit = trial && l.totalLimit != null ? l.totalLimit : l.dailyLimit;
  const used = trial && l.totalLimit != null ? Number(l.usedTotal) || 0 : Number(l.usedToday) || 0;
  $('licenseCard')?.classList.toggle('active', active);
  if ($('activationBox')) $('activationBox').hidden = active;
  if ($('licenseHealth')) $('licenseHealth').textContent = active ? String(l.planLabel || l.plan || 'ATIVA').toUpperCase() : String(l.status || 'INATIVA').toUpperCase();
  if ($('planBadge')) $('planBadge').textContent = active ? String(l.planLabel || l.plan || 'ATIVA').toUpperCase() : 'LICENÇA';
  if ($('licenseTitle')) $('licenseTitle').textContent = active
    ? (waiting ? 'Licença ativa • sincronizando' : 'Licença ativa')
    : l.status === 'expired' ? 'Licença expirada'
      : l.status === 'limit' ? 'Limite do plano atingido'
        : l.status === 'device_locked' ? 'Licença vinculada a outro aparelho'
          : 'Ativação necessária';
  if ($('licenseText')) $('licenseText').textContent = active
    ? waiting ? 'Seu último acesso válido foi mantido. A sincronização será retomada automaticamente.' : `${l.planLabel || l.plan || 'Plano'} ativo${l.expiresAt ? ` • vence ${new Date(l.expiresAt).toLocaleDateString('pt-BR')}` : ''}.`
    : l.status === 'expired' ? 'Renove seu acesso para continuar.'
      : l.status === 'device_locked' ? 'Este acesso já está vinculado a outro aparelho.'
        : l.status === 'limit' ? 'O limite disponível para este acesso foi utilizado.'
          : l.error === 'backend_unreachable' ? 'Servidor ATS indisponível no momento.'
            : 'Entre na sua conta ATS ou use uma licença manual.';
  if ($('licenseUsage')) $('licenseUsage').textContent = active ? usageText(l) : 'Uso: —';
  if ($('licenseDevice')) $('licenseDevice').textContent = active ? (l.deviceLocked || l.devices > 0 ? 'Aparelho: VINCULADO' : 'Aparelho: LIVRE') : 'Aparelho: —';
  const pct = limit == null ? 0 : Math.max(0, Math.min(100, limit ? used / limit * 100 : 0));
  if ($('quotaText')) $('quotaText').textContent = limit == null ? (active ? 'ILIMITADO' : '—') : `${used} / ${limit}`;
  if ($('quotaBar')) $('quotaBar').style.width = `${pct}%`;
  if ($('quotaHint')) $('quotaHint').textContent = trial && l.totalLimit != null ? 'O teste usa um limite total de sinais.' : limit == null ? 'Seu plano não possui limite diário de sinais.' : 'Este é o limite comercial do plano. A análise técnica é calculada separadamente.';
}

function renderPlatformSync(s = {}) {
  const pc = s.platformControls || {};
  const observed = pc.observed || {};
  if ($('platformAmount')) $('platformAmount').textContent = observed.amount == null ? 'Não identificado' : money(observed.amount);
  if ($('platformTimeframe')) $('platformTimeframe').textContent = observed.timeframe || 'Não identificado';
  if ($('platformExpiration')) $('platformExpiration').textContent = observed.expiration || 'Não identificado';
  const row = $('platformSyncRow');
  row?.classList.remove('ok', 'warn', 'bad');
  let title = 'Defina valor, vela e expiração';
  let text = 'Preencha os três campos. Depois o ATS aplica e confere tudo na CasaTrade.';
  let badge = 'CONFIGURAR';
  if (!configuredPrefs(prefs)) row?.classList.add('warn');
  else if (!s.targetTabId || !fresh(s)) {
    row?.classList.add('warn'); title = 'Conecte a CasaTrade'; text = 'Abra a plataforma. O ATS tentará sincronizar a configuração automaticamente.'; badge = 'AGUARDANDO';
  } else if (pc.aligned) {
    row?.classList.add('ok'); title = 'CasaTrade sincronizada'; text = 'Valor, vela e expiração foram lidos de volta e conferidos. A análise usa esses valores reais.'; badge = 'SINCRONIZADO';
  } else {
    row?.classList.add('bad');
    const miss = [!pc.amountOk ? 'valor' : null, !pc.timeframeOk ? 'vela' : null, !pc.expirationOk ? 'expiração' : null].filter(Boolean);
    title = 'Configuração ainda não bate'; text = `Ainda não consegui confirmar ${miss.join(', ') || 'os controles'} na CasaTrade. A análise fica bloqueada para não trabalhar com tempo diferente.`; badge = 'VERIFICAR';
  }
  if ($('platformSyncTitle')) $('platformSyncTitle').textContent = title;
  if ($('platformSyncText')) $('platformSyncText').textContent = text;
  if ($('syncBadge')) $('syncBadge').textContent = badge;
}

function renderCatalog(s = {}) {
  const c = s.marketCatalog || {};
  const analysis = new Map((s.universeAnalysis || []).map(x => [String(x.asset), x]));
  const lines = Array.isArray(c.lines) ? c.lines : [];
  const assets = Array.isArray(c.assets) ? c.assets : [];
  if ($('catalogCount')) $('catalogCount').textContent = `${assets.length} ${assets.length === 1 ? 'ATIVO' : 'ATIVOS'}`;
  for (const v of c.timeframes || []) ensureOption(tfSelect, v);
  for (const v of c.expirations || []) ensureOption(expSelect, v);
  if (!$('catalogList')) return;
  if (!lines.length) {
    $('catalogList').innerHTML = '<div class="empty-state">Ainda não encontrei ativos. Deixe a CasaTrade aberta por alguns segundos; o ATS está lendo DOM e WebSocket.</div>';
    return;
  }
  $('catalogList').innerHTML = lines.slice(0, 50).map(x => {
    const a = analysis.get(String(x.asset));
    const sig = a?.signal || {};
    const source = x.source === 'network' || x.transport === 'ws' ? 'WS' : x.transport ? String(x.transport).toUpperCase() : 'DOM';
    const state = sig.state === 'CONFIRM' ? (sig.direction === 'SELL' ? 'VENDA' : 'COMPRA') : sig.state === 'WATCH' ? 'OBSERVAR' : sig.state === 'SEARCHING' ? 'AQUECENDO' : 'AGUARDAR';
    const meta = [x.timeframe || a?.timeframe, x.expiration || a?.expiration, sig.score != null ? `score ${Math.round(Number(sig.score || 0))}` : null, state].filter(Boolean).join(' • ');
    return `<div class="catalog-row"><div><b>${esc(x.asset)}</b><small>${esc(meta || 'Mapeado')}</small></div><span>${x.price == null ? '—' : esc(x.price)}</span><em class="${source === 'WS' ? 'feed' : 'dom'}">${esc(source)}</em></div>`;
  }).join('');
}

function renderIntelligence(s = {}) {
  const intel = s.marketIntelligence || {};
  const rows = Array.isArray(intel.top) ? intel.top : [];
  if ($('intelligenceSummary')) $('intelligenceSummary').textContent = intel.summary || 'Aguardando o feed da plataforma para classificar os mercados.';
  if ($('intelligenceNote')) $('intelligenceNote').textContent = intel.note || 'O ranking usa somente dados observados. Nenhuma informação externa é inventada.';
  if ($('intelligenceBadge')) $('intelligenceBadge').textContent = intel.externalAi === 'nao_configurada' ? 'MOTOR LOCAL' : 'IA + MOTOR';
  if (!$('intelligenceList')) return;
  if (!rows.length) {
    $('intelligenceList').innerHTML = '<div class="empty-state">Aguardando ativos e cotações reais da CasaTrade.</div>';
    return;
  }
  $('intelligenceList').innerHTML = rows.map((x, i) => {
    const dir = x.direction === 'SELL' ? 'VENDA' : x.direction === 'BUY' ? 'COMPRA' : 'AGUARDAR';
    const cls = x.direction === 'SELL' ? 'sell' : x.direction === 'BUY' ? 'buy' : x.state === 'WATCH' ? 'watch' : '';
    const warm = x.warmup ? `${Math.min(Number(x.warmup.current || 0), Number(x.warmup.required || 21))}/${Number(x.warmup.required || 21)} velas` : 'histórico em formação';
    const meta = `${x.timeframe || 'tempo não identificado'} • ${x.session?.label || 'sessão não identificada'} • ${warm}`;
    return `<div class="intel-row ${cls}"><div><strong>${i + 1}. ${esc(x.asset || 'Ativo')} • ${dir}</strong><small>${esc(meta)}</small></div><span class="intel-score">${Math.round(Number(x.adjustedScore ?? x.score ?? 0))}</span></div>`;
  }).join('');
}

function renderReasons(sig = {}) {
  let reasons = Array.isArray(sig.reasons) ? sig.reasons.filter(Boolean).slice(0, 6) : [];
  if (!reasons.length && sig.hint) reasons = String(sig.hint).split(' • ').filter(Boolean).slice(0, 5);
  if (!reasons.length) reasons = ['Aguardando dados suficientes para explicar a leitura.'];
  if ($('signalReasons')) $('signalReasons').innerHTML = reasons.map(r => `<p>${esc(r)}</p>`).join('');
}

function signalTone(state, direction) {
  if (state === 'CONFIRM') return direction === 'SELL' ? 'sell' : 'confirm';
  if (state === 'WATCH') return 'watch';
  if (state === 'NO_TRADE') return 'blocked';
  return 'neutral';
}

function renderSignal(s = {}) {
  const sig = s.signal || {};
  const state = String(sig.state || 'WAIT');
  const direction = sig.direction || null;
  const score = Number.isFinite(Number(sig.score)) ? Math.max(0, Math.min(100, Number(sig.score))) : 0;
  const warm = sig.warmup || { current: sig.candleCount || 0, required: 21 };
  const required = Number(warm.required || 21);
  const current = Math.min(Number(warm.current || 0), required);
  const pct = Math.max(0, Math.min(100, current / required * 100));
  const tone = signalTone(state, direction);
  if ($('score')) $('score').textContent = Number.isFinite(Number(sig.score)) ? String(Math.round(Number(sig.score))) : '—';
  if ($('signalDirection')) $('signalDirection').textContent = direction === 'BUY' ? 'COMPRA' : direction === 'SELL' ? 'VENDA' : '—';
  if ($('setup')) $('setup').textContent = sig.grade || '—';
  if ($('confirmations')) $('confirmations').textContent = String(sig.confirmations || '0 / 6').replace(/\s*\/\s*/, ' de ');
  if ($('regime')) $('regime').textContent = String(sig.regime || '—').toUpperCase();
  const titles = {
    CONFIRM: direction === 'SELL' ? 'VENDA CONFIRMADA' : 'COMPRA CONFIRMADA',
    WATCH: 'OPORTUNIDADE EM FORMAÇÃO', SEARCHING: 'ANALISANDO O MERCADO', NO_TRADE: 'NÃO ENTRAR AGORA', WAIT: 'AGUARDANDO CONFIRMAÇÕES', IDLE: 'AGUARDANDO CONEXÃO'
  };
  if ($('scannerState')) $('scannerState').textContent = titles[state] || 'AGUARDANDO';
  let hint = sig.hint || 'Aguardando dados suficientes.';
  if (!s.asset || s.price == null) hint = 'Estou procurando o ativo e a cotação reais da CasaTrade. Ainda não vou gerar entrada.';
  else if (configuredPrefs(prefs) && !aligned(s)) hint = 'Antes de analisar, preciso confirmar que valor, vela e expiração estão iguais na CasaTrade.';
  else if (sig.provisional) hint = 'Já estou vendo movimento da plataforma, mas o feed ainda está sendo validado. Não vou inventar uma entrada.';
  else if (state === 'SEARCHING') hint = `Analisando ${s.asset} em ${s.timeframe || 'tempo não identificado'} com dados recebidos da plataforma.`;
  else if (state === 'WATCH') hint = 'Existe movimento interessante, mas ainda faltam confirmações. Aguarde.';
  else if (state === 'CONFIRM') hint = `${direction === 'SELL' ? 'Venda' : 'Compra'} confirmada pelo motor. A direção correta foi liberada logo abaixo.`;
  else if (state === 'NO_TRADE') hint = 'As condições atuais não passaram pelos filtros. Melhor não entrar agora.';
  if ($('scannerHint')) $('scannerHint').textContent = hint;
  if ($('warmupText')) $('warmupText').textContent = current >= required ? `${required}/${required} velas • análise pronta` : `${current}/${required} velas • faltam ${Math.max(0, required - current)}`;
  if ($('warmupLabel')) $('warmupLabel').textContent = current ? 'Histórico real disponível' : 'Procurando histórico da plataforma';
  if ($('warmupBar')) $('warmupBar').style.width = `${pct}%`;
  if (scoreGauge) { scoreGauge.style.setProperty('--score', `${score}%`); scoreGauge.className = `score-orb ${state === 'CONFIRM' ? (direction === 'SELL' ? 'sell' : 'buy') : ''}`; }
  const command = $('signalCommand'); if (command) command.className = `signal-command ${tone}`;
  const badge = $('signalBadge'); if (badge) { badge.className = `signal-badge ${tone}`; badge.textContent = state === 'CONFIRM' ? (direction === 'SELL' ? 'VENDA' : 'COMPRA') : state === 'WATCH' ? 'OBSERVAR' : state === 'NO_TRADE' ? 'NÃO ENTRAR' : 'AGUARDAR'; }
  if ($('structureState')) $('structureState').textContent = sig.provisional ? 'VALIDANDO' : 'VALIDADOS';
  if ($('signalCommandSub')) $('signalCommandSub').textContent = state === 'CONFIRM' ? `Entrada validada • ${sig.confirmations || 'critérios confirmados'}.` : sig.provisional ? 'Feed em validação: o ATS acompanha o mercado, mas não libera entrada confirmada.' : 'O ATS aguarda confluência e qualidade mínima antes de confirmar.';
  renderReasons(sig);

  const canTrade = state === 'CONFIRM' && !sig.provisional && aligned(s) && activeLicense(s);
  if (buyBtn) buyBtn.disabled = !(canTrade && direction === 'BUY');
  if (sellBtn) sellBtn.disabled = !(canTrade && direction === 'SELL');
  document.querySelector('.execution-panel')?.classList.toggle('signal-ready', canTrade);
  document.querySelector('.execution-panel')?.classList.toggle('sell-ready', canTrade && direction === 'SELL');
  if ($('entryPreviewTitle')) $('entryPreviewTitle').textContent = canTrade ? `${direction === 'SELL' ? 'VENDA' : 'COMPRA'} liberada em ${s.asset || 'ativo'}` : 'Nenhuma entrada liberada';
  if ($('entryPreviewText')) $('entryPreviewText').textContent = canTrade ? `${s.timeframe || '—'} • expiração ${s.expiration || '—'} • score ${Math.round(score)}. Confirmação final manual na plataforma.` : 'Continue acompanhando. Os botões só são liberados quando os dados e o sinal estão confirmados.';
  if ($('entryPreviewIcon')) $('entryPreviewIcon').textContent = canTrade ? (direction === 'SELL' ? '▼' : '▲') : '◎';
  if ($('manualStatus') && s.tradeIntent?.status !== 'prepared') $('manualStatus').textContent = canTrade ? 'Clique apenas na direção liberada. O ATS vai localizar e destacar o controle correspondente na CasaTrade.' : 'A extensão não executa ordem financeira automaticamente; a confirmação final continua manual.';
}

function renderHistory(s = {}) {
  const rows = Array.isArray(s.signalHistory) ? s.signalHistory : [];
  if (!$('signalHistory')) return;
  $('signalHistory').innerHTML = rows.length ? rows.slice(0, 8).map(x => `<div class="history-row"><span class="history-dir ${x.direction === 'SELL' ? 'sell' : 'buy'}">${x.direction === 'SELL' ? 'VENDA' : 'COMPRA'}</span><div><b>${esc(x.asset || '—')} • score ${Math.round(Number(x.score || 0))}</b><small>${esc(x.timeframe || '—')} • exp. ${esc(x.expiration || '—')} • ${esc(x.regime || '—')}</small></div><time>${new Date(x.at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</time></div>`).join('') : '<div class="empty-state">Nenhum sinal confirmado nesta instalação ainda.</div>';
}

function render(s = {}) {
  lastState = s;
  const online = fresh(s);
  const platform = s.platformName || 'CasaTrade';
  const age = s.lastSeen ? Date.now() - s.lastSeen : null;
  const net = s.diagnostics?.network || {};
  const dom = s.diagnostics?.domCatalog || {};
  const ws = Number(net.connections?.ws || 0);
  const assetCount = s.marketCatalog?.assets?.length || Number(net.candidateCount || 0) || Number(dom.assetCount || 0);
  const structured = !!s.capabilities?.structuredQuotes;
  const quality = Math.max(Number(net.feedQuality || 0), Number(s.diagnostics?.networkQuality || 0), Number(s.telemetry?.feedQuality || 0));
  const licensed = activeLicense(s);
  const lastSyncSuccess = Number(s.telemetry?.lastSyncSuccess || 0);
  const telemetryRecent = lastSyncSuccess > 0 && Date.now() - lastSyncSuccess < 20000;
  const telemetryError = s.telemetry?.lastSyncError;

  if ($('liveBadge')) { $('liveBadge').className = `live-badge ${online ? 'online' : 'offline'}`; $('liveBadge').querySelector('span').textContent = online ? 'AO VIVO' : s.connection === 'connecting' ? 'CONECTANDO' : 'OFFLINE'; }
  if ($('platformPill')) { $('platformPill').className = `pill ${online ? 'online' : ''}`; $('platformPill').textContent = online ? platform.toUpperCase() : s.connection === 'connecting' ? 'CONECTANDO' : 'AGUARDANDO'; }
  if ($('asset')) $('asset').textContent = s.asset || '—';
  if ($('price')) $('price').textContent = s.price == null ? '—' : String(s.price);
  const instrument = s.instrumentType && s.instrumentType !== 'unknown' ? String(s.instrumentType).toUpperCase() : null;
  const market = s.marketType === 'otc' ? 'OTC' : s.marketType && s.marketType !== 'unknown' ? String(s.marketType).toUpperCase() : null;
  if ($('marketType')) $('marketType').textContent = [instrument, market].filter(Boolean).join(' • ') || 'NÃO IDENTIFICADO';
  if ($('timeframe')) $('timeframe').textContent = s.timeframe || s.analysisTimeframe || 'NÃO IDENTIFICADO';
  if ($('expiration')) $('expiration').textContent = s.expiration || s.targetExpiration || 'NÃO IDENTIFICADO';
  if ($('latency')) $('latency').textContent = online ? (s.telemetry?.latency != null ? `${Math.round(s.telemetry.latency)} ms` : age != null ? `${Math.round(age)} ms` : '—') : '—';
  if ($('quality')) $('quality').textContent = online ? `${Math.round(quality || (ws ? 35 : 20))}/100` : '—';
  if ($('feedMode')) $('feedMode').textContent = online ? (structured ? 'WEBSOCKET' : ws ? 'WS • VALIDANDO' : assetCount ? 'DOM • PROVISÓRIO' : 'MAPEANDO') : 'OFFLINE';
  if ($('feedHealth')) $('feedHealth').textContent = online ? (structured ? `WS ESTRUTURADO • ${assetCount} ativos` : ws ? `WS ${ws} • ${assetCount} ativos` : assetCount ? `${assetCount} ativos • DOM` : 'MAPEANDO') : 'OFFLINE';
  if ($('platformRail')) $('platformRail').textContent = online ? platform.toUpperCase() : 'OFFLINE';
  if ($('feedRail')) $('feedRail').textContent = online ? (structured ? 'ESTRUTURADO' : ws ? 'VALIDANDO WS' : assetCount ? 'DOM ATIVO' : 'AGUARDANDO') : 'SEM DADOS';
  if ($('scannerRail')) $('scannerRail').textContent = s.scanner === 'scanning' ? 'ATIVA' : 'PARADA';
  if ($('telemetryHealth')) $('telemetryHealth').textContent = licensed ? (telemetryRecent ? 'OK' : telemetryError ? 'ERRO' : 'CONECTANDO') : 'AGUARDANDO';
  setDot('platformDot', online); setDot('feedDot', online && (ws > 0 || assetCount > 0 || structured)); setDot('scannerDot', s.scanner === 'scanning'); setDot('telemetryDot', telemetryRecent);

  if (connectBtn) { connectBtn.classList.toggle('connecting', s.connection === 'connecting' || requested); $('connectLabel').textContent = online ? 'RECONECTAR CASATRADE' : s.connection === 'connecting' || requested ? 'CONECTANDO...' : 'CONECTAR CASATRADE'; }
  if (toggleBtn) { toggleBtn.disabled = !online || !licensed || !configuredPrefs(prefs) || !aligned(s); toggleBtn.classList.toggle('active', s.scanner === 'scanning'); $('toggleLabel').textContent = s.scanner === 'scanning' ? 'PAUSAR ANÁLISE' : 'INICIAR ANÁLISE'; }

  renderLicense(s);
  renderPlatformSync(s);
  renderSignal(s);
  renderIntelligence(s);
  renderCatalog(s);
  renderHistory(s);
  if (s.tradeIntent?.status === 'prepared' && $('manualStatus')) {
    const h = s.tradeIntent.handoff;
    $('manualStatus').textContent = h?.found ? `${s.tradeIntent.direction === 'SELL' ? 'VENDA' : 'COMPRA'} preparada • controle localizado e destacado na plataforma.` : 'Entrada preparada • confirme manualmente na CasaTrade.';
  }
  if (!online && lastError && $('scannerHint')) $('scannerHint').textContent = lastError;
}

function tfMs(raw) {
  const s = String(raw || 'M1').toUpperCase();
  let m = s.match(/^S(\d+)$/); if (m) return Number(m[1]) * 1000;
  m = s.match(/^M(\d+)$/); if (m) return Number(m[1]) * 60000;
  m = s.match(/^H(\d+)$/); if (m) return Number(m[1]) * 3600000;
  return 60000;
}
function updateCountdown() {
  const tf = lastState.timeframe || lastState.analysisTimeframe || lastState.signal?.timeframe || 'M1';
  const ms = tfMs(tf);
  const left = Math.max(0, Math.ceil(Date.now() / ms) * ms - Date.now());
  const sec = Math.ceil(left / 1000), min = Math.floor(sec / 60), rem = sec % 60;
  if ($('entryCountdown')) $('entryCountdown').textContent = `${min}:${String(rem).padStart(2, '0')}`;
}

async function getState() {
  const [state, stored] = await Promise.all([
    chrome.runtime.sendMessage({ type: 'ATS_GET_STATE' }).catch(() => ({})),
    chrome.storage.local.get(['atsTelemetryStatus', LAST_VALID_LICENSE_KEY]).catch(() => ({}))
  ]);
  const status = stored.atsTelemetryStatus || {};
  const license = effectiveLicense(state?.license || {}, stored[LAST_VALID_LICENSE_KEY] || null);
  render({ ...state, license, telemetry: { ...(state?.telemetry || {}), ...status } });
  return { ...state, license };
}

async function loadPrefs() {
  const { settings = {} } = await chrome.storage.local.get('settings');
  prefs = settings.scanPreferences || {};
  ensureOption(tfSelect, prefs.timeframe); ensureOption(expSelect, prefs.expiration);
  if (tfSelect) tfSelect.value = prefs.timeframe || 'AUTO';
  if (expSelect) expSelect.value = prefs.expiration || 'AUTO';
  if (amountInput && document.activeElement !== amountInput) amountInput.value = num(prefs.tradeAmount ?? prefs.stake) > 0 ? String(prefs.tradeAmount ?? prefs.stake).replace('.', ',') : '';
}

async function savePrefs() {
  const amount = num(String(amountInput?.value || '').replace(',', '.'));
  const { settings = {} } = await chrome.storage.local.get('settings');
  const next = {
    ...(settings.scanPreferences || {}),
    tradeAmount: amount,
    stake: amount,
    timeframe: tfSelect?.value || 'AUTO',
    expiration: expSelect?.value || 'AUTO',
    scanScope: settings.scanPreferences?.scanScope || 'all',
    preflightConfigured: amount != null && amount > 0 && tfSelect?.value !== 'AUTO' && expSelect?.value !== 'AUTO'
  };
  prefs = next;
  await chrome.storage.local.set({ settings: { ...settings, scanPreferences: next } });
  return next;
}

async function syncPlatform() {
  if (syncBusy) return null;
  syncBusy = true;
  try {
    await savePrefs();
    if ($('platformSyncTitle')) $('platformSyncTitle').textContent = 'Sincronizando com a CasaTrade...';
    if ($('platformSyncText')) $('platformSyncText').textContent = 'Aplicando valor, vela e expiração e conferindo o resultado na plataforma.';
    const r = await chrome.runtime.sendMessage({ type: 'ATS_SYNC_PLATFORM_PREFERENCES' }).catch(() => ({ ok: false, error: 'sync_failed' }));
    setTimeout(getState, 120);
    return r;
  } finally { syncBusy = false; }
}

async function ensureBackendPermission() {
  try {
    const origin = `${new URL(PUBLIC_API).origin}/*`;
    const has = await chrome.permissions.contains({ origins: [origin] });
    if (has) return { ok: true };
    const granted = await chrome.permissions.request({ origins: [origin] });
    return { ok: granted, error: granted ? null : 'permission_denied' };
  } catch { return { ok: false, error: 'invalid_backend_url' }; }
}

function connectionError(r = {}) {
  if (r.error === 'platform_not_registered') return `A página aberta (${r.host || 'desconhecida'}) ainda não está cadastrada.`;
  if (r.error === 'active_tab_unavailable') return 'Não consegui acessar a aba atual.';
  return `Não consegui conectar à CasaTrade: ${r.error || 'erro desconhecido'}`;
}

async function connect() {
  requested = true; lastError = '';
  const r = await chrome.runtime.sendMessage({ type: 'ATS_CONNECT_ACTIVE_TAB' }).catch(e => ({ ok: false, error: e?.message || String(e) }));
  requested = false;
  if (!r?.ok) lastError = connectionError(r);
  else setTimeout(() => syncPlatform().catch(() => {}), 550);
  setTimeout(getState, 180); setTimeout(getState, 900);
  return r;
}

async function maybeAutoConnect(state) {
  if (!activeLicense(state) || fresh(state) || requested || Date.now() - autoConnectAt < 7000) return;
  autoConnectAt = Date.now();
  const r = await chrome.runtime.sendMessage({ type: 'ATS_CONNECT_ACTIVE_TAB' }).catch(() => null);
  if (r?.ok) setTimeout(() => syncPlatform().catch(() => {}), 650);
}

async function prepare(direction) {
  const s = await chrome.runtime.sendMessage({ type: 'ATS_GET_STATE' }).catch(() => ({}));
  if (s.signal?.state !== 'CONFIRM' || s.signal?.direction !== direction || s.signal?.provisional || !aligned(s)) return;
  const r = await chrome.runtime.sendMessage({ type: 'ATS_PREPARE_TRADE', direction }).catch(e => ({ ok: false, error: e?.message || String(e) }));
  if ($('manualStatus')) $('manualStatus').textContent = !r?.ok ? 'Não foi possível preparar a ação. Verifique conexão e licença.' : r.intent?.handoff?.found ? `${direction === 'SELL' ? 'VENDA' : 'COMPRA'} preparada e controle destacado na plataforma.` : 'Entrada preparada. Confirme manualmente na plataforma.';
  getState();
}

connectBtn?.addEventListener('click', connect);
$('syncPlatformBtn')?.addEventListener('click', syncPlatform);
toggleBtn?.addEventListener('click', async () => {
  const s = await chrome.runtime.sendMessage({ type: 'ATS_GET_STATE' }).catch(() => ({}));
  if (s.scanner !== 'scanning' && (!configuredPrefs(prefs) || !aligned(s))) {
    renderPlatformSync(s); $('platformSyncRow')?.scrollIntoView({ behavior: 'smooth', block: 'center' }); return;
  }
  const r = await chrome.runtime.sendMessage({ type: 'ATS_SET_SCANNER', enabled: s.scanner !== 'scanning' }).catch(() => ({ ok: false }));
  if (!r?.ok && r?.error === 'license_required' && $('licenseText')) $('licenseText').textContent = 'Ative uma licença válida para iniciar a análise.';
  getState();
});
buyBtn?.addEventListener('click', () => prepare('BUY'));
sellBtn?.addEventListener('click', () => prepare('SELL'));
$('activateLicense')?.addEventListener('click', async () => {
  const key = $('licenseKey')?.value.trim() || '';
  if ($('licenseText')) $('licenseText').textContent = 'Validando licença e vinculando este aparelho...';
  const permission = await ensureBackendPermission();
  if (!permission.ok) { if ($('licenseText')) $('licenseText').textContent = 'Permissão para acessar o servidor ATS não concedida.'; return; }
  const r = await chrome.runtime.sendMessage({ type: 'ATS_ACTIVATE_LICENSE', key }).catch(e => ({ ok: false, error: String(e) }));
  if ($('licenseText')) $('licenseText').textContent = r.ok ? 'Licença ativada e aparelho vinculado com sucesso.' : r.error === 'license_not_found' ? 'Licença não encontrada.' : r.error === 'license_expired' ? 'Licença expirada.' : r.error === 'device_locked' || r.error === 'device_limit_reached' ? 'Esta licença já está vinculada a outro aparelho.' : r.error === 'trial_limit_reached' ? 'O teste já utilizou todos os sinais disponíveis.' : r.error === 'backend_unreachable' ? 'Servidor ATS indisponível no momento.' : `Não foi possível ativar: ${r.error || 'erro desconhecido'}`;
  const state = await getState();
  if (r.ok) maybeAutoConnect(state);
});

const onPreferenceChanged = async () => { await savePrefs(); const s = await getState(); if (s.targetTabId) await syncPlatform(); };
tfSelect?.addEventListener('change', onPreferenceChanged);
expSelect?.addEventListener('change', onPreferenceChanged);
amountInput?.addEventListener('change', onPreferenceChanged);
amountInput?.addEventListener('blur', onPreferenceChanged);
$('settingsBtn')?.addEventListener('click', () => chrome.runtime.openOptionsPage());
chrome.storage.onChanged.addListener(changes => {
  if (changes.settings) loadPrefs().then(getState);
  if (changes.scannerState || changes.atsTelemetryStatus || changes[LAST_VALID_LICENSE_KEY]) getState().then(maybeAutoConnect);
});

async function boot() {
  await loadPrefs();
  const state = await getState();
  maybeAutoConnect(state);
  chrome.runtime.sendMessage({ type: 'ATS_VALIDATE_LICENSE' }).catch(() => null).then(async () => {
    const refreshed = await getState();
    maybeAutoConnect(refreshed);
  });
}

boot();
setInterval(async () => { const s = await getState(); maybeAutoConnect(s); }, 1100);
setInterval(updateCountdown, 250);
