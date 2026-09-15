const $ = id => document.getElementById(id);
const UI_PREF_KEY = 'atsScannerUiPreferences';
const DEFAULT_PREFS = Object.freeze({ overlayEnabled: false, possibleSoundEnabled: false, confirmSoundEnabled: false });
let prefs = { ...DEFAULT_PREFS };
let lastState = {};
let lastSignalKey = '';
let audioContext = null;
let renderQueued = false;

if ($('extensionVersion')) $('extensionVersion').textContent = `v${chrome.runtime.getManifest().version}`;

const num = value => value == null || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null;
const activeLicense = state => ['active','valid'].includes(String(state?.license?.status || '').toLowerCase());
const fresh = state => Number(state?.lastSeen) > 0 && Date.now() - Number(state.lastSeen) < 8000;
const priceText = value => num(value) == null ? '—' : String(value);

function exactClockReady(state = {}) {
  const focus = state.diagnostics?.focusedAsset || null;
  const clock = state.diagnostics?.marketClock || null;
  if (!focus || !clock || !state.asset) return false;
  const normalize = value => String(value || '').toUpperCase().replace(/\s*\(\s*OTC\s*\)\s*$/i, '').replace(/\s+/g, '');
  return focus.reliable === true && focus.chartScoped === true && focus.embeddedTrader === true
    && normalize(focus.asset) === normalize(state.asset)
    && clock.verified === true && clock.available !== false && clock.role === 'candle-close'
    && ['trader-dom-countdown','network-server-cycle'].includes(String(clock.source || ''))
    && normalize(clock.asset) === normalize(state.asset)
    && Number(clock.frameId) === Number(focus.frameId)
    && String(clock.frameHost || '').toLowerCase() === String(focus.frameHost || '').toLowerCase()
    && Date.now() - Number(clock.at || 0) < 2200
    && num(clock.secondsRemaining) != null;
}

function sessionReady(state = {}) {
  const session = state.diagnostics?.marketSession || null;
  return activeLicense(state) && state.platformId === 'casatrade' && state.connection === 'online'
    && !!state.asset && num(state.price) != null && fresh(state) && exactClockReady(state)
    && !!session?.asset;
}

function decisionModel(state = {}) {
  const signal = state.signal || {};
  if (!activeLicense(state)) return { key: 'BLOCKED', title: 'ATIVAÇÃO NECESSÁRIA', badge: 'BLOQUEADO', detail: 'Ative a licença para iniciar.', className: 'waiting' };
  if (!state.diagnostics?.focusedAsset?.asset) return { key: 'SYNC', title: 'IDENTIFICANDO ATIVO', badge: 'SINCRONIZANDO', detail: 'Aguardando o ativo realmente aberto no gráfico.', className: 'waiting' };
  if (!state.asset || num(state.price) == null) return { key: 'SYNC', title: 'LENDO MERCADO', badge: 'SINCRONIZANDO', detail: 'Ativo confirmado. Aguardando cotação real.', className: 'waiting' };
  if (!exactClockReady(state)) return { key: 'SYNC', title: 'SINCRONIZANDO VELA', badge: 'RELÓGIO', detail: 'Aguardando o fechamento exato da vela da CasaTrade.', className: 'waiting' };
  const map = {
    BUILDING_PATTERN: ['ANALISANDO PRÓXIMA VELA','ANALISANDO','waiting'],
    POSSIBLE_BUY: ['POSSÍVEL COMPRA','POSSÍVEL','possible'],
    POSSIBLE_SELL: ['POSSÍVEL VENDA','POSSÍVEL','possible'],
    DECIDING: ['DECIDINDO AGORA','DECIDINDO','possible'],
    ENTER_BUY: ['ENTRAR COMPRA','ENTRAR','buy'],
    ENTER_SELL: ['ENTRAR VENDA','ENTRAR','sell'],
    SKIP: ['PULAR PRÓXIMA VELA','PULAR','no-trade']
  };
  const row = map[signal.uiState] || ['ANALISANDO PRÓXIMA VELA','ANALISANDO','waiting'];
  return { key: signal.uiState || 'ANALYZING', title: row[0], badge: row[1], className: row[2], detail: signal.reason || 'Analisando as velas e o contexto atual.' };
}

function ensureAudio() {
  const Ctx = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!Ctx) return null;
  if (!audioContext) audioContext = new Ctx();
  if (audioContext.state === 'suspended') audioContext.resume().catch(() => {});
  return audioContext;
}
function tone(freq, offset, duration, gainValue) {
  const ctx = ensureAudio(); if (!ctx) return;
  const oscillator = ctx.createOscillator(); const gain = ctx.createGain();
  const start = ctx.currentTime + offset;
  oscillator.frequency.setValueAtTime(freq, start); oscillator.type = 'sine';
  gain.gain.setValueAtTime(.0001, start); gain.gain.exponentialRampToValueAtTime(gainValue, start + .02); gain.gain.exponentialRampToValueAtTime(.0001, start + duration);
  oscillator.connect(gain); gain.connect(ctx.destination); oscillator.start(start); oscillator.stop(start + duration + .03);
}
function play(kind) {
  if (kind === 'possible') { tone(620,0,.09,.03); tone(760,.11,.09,.025); return; }
  tone(760,0,.11,.05); tone(980,.12,.12,.06); tone(1240,.25,.14,.07);
}

function maybeSound(model, state) {
  const cycle = state.decisionCycle?.key || state.signal?.targetStart || '';
  const key = `${model.key}|${cycle}`;
  if (!lastSignalKey) { lastSignalKey = key; return; }
  if (key === lastSignalKey) return;
  lastSignalKey = key;
  if ((model.key === 'POSSIBLE_BUY' || model.key === 'POSSIBLE_SELL') && prefs.possibleSoundEnabled) play('possible');
  if ((model.key === 'ENTER_BUY' || model.key === 'ENTER_SELL') && prefs.confirmSoundEnabled) play('confirm');
}

function renderCandles(state = {}) {
  const box = $('recentCandles'); if (!box) return;
  const rows = (Array.isArray(state.candles) ? state.candles : []).filter(row => [row?.open,row?.high,row?.low,row?.close].every(value => num(value) != null)).slice(-10);
  if ($('recentCandleCount')) $('recentCandleCount').textContent = `${rows.length}/10`;
  box.replaceChildren();
  for (let i = 0; i < 10; i++) {
    const candle = rows[i - (10 - rows.length)];
    const slot = document.createElement('div'); slot.className = 'mini-candle-slot';
    if (!candle) { slot.classList.add('empty'); box.appendChild(slot); continue; }
    const open = Number(candle.open), high = Number(candle.high), low = Number(candle.low), close = Number(candle.close);
    const range = Math.max(1e-12, high - low);
    const top = ((high - Math.max(open, close)) / range) * 100;
    const height = Math.max(10, (Math.abs(close - open) / range) * 100);
    slot.classList.add(close > open ? 'buy' : close < open ? 'sell' : 'doji');
    const wick = document.createElement('i'); wick.className = 'mini-wick';
    const body = document.createElement('b'); body.className = 'mini-body'; body.style.top = `${Math.max(0,Math.min(88,top))}%`; body.style.height = `${Math.max(10,Math.min(90,height))}%`;
    slot.append(wick, body); box.appendChild(slot);
  }
}

function renderLicense(state = {}) {
  const license = state.license || {};
  const active = activeLicense(state);
  if ($('licenseCard')) $('licenseCard').classList.toggle('active', active);
  if ($('licenseHealth')) { $('licenseHealth').textContent = active ? 'ATIVA' : String(license.status || 'INATIVA').toUpperCase(); $('licenseHealth').className = `badge ${active ? 'ok' : 'warn'}`; }
  if ($('licenseTitle')) $('licenseTitle').textContent = active ? `${license.planLabel || license.plan || 'Plano'} ativo` : 'Ativação necessária';
  if ($('licenseText')) $('licenseText').textContent = active ? 'Este dispositivo está autorizado.' : (license.error === 'device_locked' || license.error === 'device_limit_reached') ? 'Dispositivo não reconhecido. Tentando recuperar o vínculo desta instalação.' : 'Ative sua licença para iniciar o scanner.';
  if ($('activationBox')) $('activationBox').hidden = active;
}

function render(state = {}) {
  lastState = state;
  const model = decisionModel(state);
  const clock = state.diagnostics?.marketClock || {};
  const session = state.diagnostics?.marketSession || {};
  const signal = state.signal || {};
  const current = signal.currentCandle || state.currentCandle || {};
  const ready = sessionReady(state);

  renderLicense(state);
  renderCandles(state);
  maybeSound(model, state);

  if ($('connectionBadge')) { $('connectionBadge').textContent = ready ? 'AO VIVO' : 'SINCRONIZANDO'; $('connectionBadge').className = `badge ${ready ? 'ok' : 'warn'}`; }
  if ($('asset')) $('asset').textContent = state.asset || state.diagnostics?.focusedAsset?.asset || '—';
  if ($('price')) $('price').textContent = priceText(state.price);
  if ($('timeframe')) $('timeframe').textContent = state.analysisTimeframe || state.timeframe || clock.timeframe || '—';
  if ($('expiration')) $('expiration').textContent = state.targetExpiration || state.expiration || '—';
  if ($('secondsRemaining')) $('secondsRemaining').textContent = exactClockReady(state) ? Math.max(0, Math.ceil(Number(clock.secondsRemaining))) : '—';
  if ($('sessionMode')) $('sessionMode').textContent = session.dataMode === 'backfill' ? 'HISTÓRICO SINCRONIZADO' : ready ? 'LIVE' : 'SYNC';

  const duration = (() => { const tf = String(state.analysisTimeframe || state.timeframe || '').toUpperCase(); let m=tf.match(/^S(\d+)$/); if(m)return Number(m[1]); m=tf.match(/^M(\d+)$/); if(m)return Number(m[1])*60; m=tf.match(/^H(\d+)$/); if(m)return Number(m[1])*3600; return null; })();
  if ($('candleProgress')) {
    const remaining = num(clock.secondsRemaining); const pct = duration && remaining != null ? Math.max(0,Math.min(100, ((duration-remaining)/duration)*100)) : 0;
    $('candleProgress').style.width = `${pct}%`;
  }

  if ($('analysisTitle')) $('analysisTitle').textContent = ready ? `${state.asset || 'Mercado'} • ${state.analysisTimeframe || state.timeframe || '—'}` : model.title;
  if ($('analysisReason')) $('analysisReason').textContent = ready ? `Sessão #${session.epoch || 1} • ${session.dataMode === 'backfill' ? 'histórico recebido em lote; somente a vela atual é live.' : 'dados ao vivo do gráfico atual.'}` : model.detail;
  if ($('currentOpen')) $('currentOpen').textContent = priceText(current.open);
  if ($('currentHigh')) $('currentHigh').textContent = priceText(current.high);
  if ($('currentLow')) $('currentLow').textContent = priceText(current.low);
  if ($('currentClose')) $('currentClose').textContent = priceText(current.close ?? state.price);

  if ($('signalTitle')) $('signalTitle').textContent = model.title;
  if ($('signalBadge')) { $('signalBadge').textContent = model.badge; $('signalBadge').className = `badge ${model.className === 'buy' ? 'ok' : model.className === 'sell' ? 'bad' : model.className === 'no-trade' ? 'warn' : ''}`; }
  if ($('decisionCard')) $('decisionCard').className = `card decision-card ${model.className}`;
  if ($('decisionBanner')) $('decisionBanner').className = `decision-banner ${model.className}`;
  if ($('decisionText')) $('decisionText').textContent = model.title;
  if ($('decisionSubtext')) $('decisionSubtext').textContent = model.detail;
  if ($('signalReason')) $('signalReason').textContent = model.detail;
  if ($('signalScore')) $('signalScore').textContent = num(signal.analysisScore ?? signal.score) == null ? '—' : `${Math.round(Number(signal.analysisScore ?? signal.score))}/100`;
  if ($('setupType')) $('setupType').textContent = signal.setup || state.decisionCycle?.setup || '—';
  if ($('lastConfirmed')) $('lastConfirmed').textContent = state.lastConfirmed?.direction ? `${state.lastConfirmed.direction === 'BUY' ? 'COMPRA' : 'VENDA'} • ${state.lastConfirmed.timeframe || state.analysisTimeframe || ''}` : 'Nenhuma entrada confirmada nesta sessão.';
  if ($('analyzingNow')) $('analyzingNow').textContent = model.detail;

  const confirmed = model.key === 'ENTER_BUY' || model.key === 'ENTER_SELL';
  if ($('prepareBuy')) { $('prepareBuy').disabled = model.key !== 'ENTER_BUY'; $('prepareBuy').classList.toggle('selected', model.key === 'ENTER_BUY'); }
  if ($('prepareSell')) { $('prepareSell').disabled = model.key !== 'ENTER_SELL'; $('prepareSell').classList.toggle('selected', model.key === 'ENTER_SELL'); }
  if ($('tradeActionStatus')) $('tradeActionStatus').textContent = confirmed ? `ENTRADA MANUAL • ${model.key === 'ENTER_BUY' ? 'COMPRA' : 'VENDA'} na próxima abertura` : model.key === 'SKIP' ? 'Não entrar nesta próxima vela.' : 'Aguardando decisão final desta vela.';
}

async function readState() {
  const response = await chrome.runtime.sendMessage({ type: 'ATS_READ_SCANNER_STATE' }).catch(() => null);
  if (response?.state) render(response.state);
}

function queueRender(state) {
  lastState = state || lastState;
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; render(lastState); });
}

async function connect() {
  const response = await chrome.runtime.sendMessage({ type: 'ATS_CONNECT_ACTIVE_TAB' }).catch(() => null);
  if (response?.state) queueRender(response.state);
}

async function activate() {
  const key = String($('licenseKey')?.value || '').trim();
  if (!key) return;
  const button = $('activateLicense'); if (button) { button.disabled = true; button.textContent = 'ATIVANDO…'; }
  const response = await chrome.runtime.sendMessage({ type: 'ATS_ACTIVATE_LICENSE', key }).catch(() => null);
  if (button) { button.disabled = false; button.textContent = 'ATIVAR'; }
  if (response?.state) queueRender(response.state);
  if (response?.ok) connect().catch(() => {});
}

async function loadPrefs() {
  const stored = await chrome.storage.local.get(UI_PREF_KEY).catch(() => ({}));
  prefs = { ...DEFAULT_PREFS, ...(stored[UI_PREF_KEY] || {}) };
  if ($('overlayToggle')) $('overlayToggle').checked = !!prefs.overlayEnabled;
  if ($('possibleSoundToggle')) $('possibleSoundToggle').checked = !!prefs.possibleSoundEnabled;
  if ($('confirmSoundToggle')) $('confirmSoundToggle').checked = !!prefs.confirmSoundEnabled;
}
async function setPref(key, value) {
  prefs = { ...prefs, [key]: !!value };
  await chrome.storage.local.set({ [UI_PREF_KEY]: prefs });
  if (value && /Sound/.test(key)) ensureAudio();
}

$('activateLicense')?.addEventListener('click', () => activate().catch(() => {}));
$('licenseKey')?.addEventListener('keydown', event => { if (event.key === 'Enter') activate().catch(() => {}); });
$('overlayToggle')?.addEventListener('change', event => setPref('overlayEnabled', event.target.checked));
$('possibleSoundToggle')?.addEventListener('change', event => setPref('possibleSoundEnabled', event.target.checked));
$('confirmSoundToggle')?.addEventListener('change', event => setPref('confirmSoundEnabled', event.target.checked));

chrome.storage.onChanged.addListener(changes => {
  if (changes.scannerState) queueRender(changes.scannerState.newValue || {});
});

(async () => {
  await loadPrefs();
  await readState();
  if (activeLicense(lastState)) await connect();
  setInterval(() => readState().catch(() => {}), 1200);
})();
