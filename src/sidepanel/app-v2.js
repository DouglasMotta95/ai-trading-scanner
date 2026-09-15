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
const freshFocus = state => {
  const focus = state?.diagnostics?.focusedAsset || null;
  return !!focus?.asset && focus.reliable === true && focus.chartScoped === true && focus.trustedChartFrame === true
    && (focus.embeddedTrader === true || focus.casaTradeFrame === true)
    && Number(focus.at) > 0 && Date.now() - Number(focus.at) < 5000;
};
const priceText = value => num(value) == null ? '—' : String(value);
const observedPriceText = (value, reliable = true) => num(value) == null ? '—' : `${reliable ? '' : '≈'}${String(value)}`;
const marketId = value => {
  const raw = String(value || '').normalize('NFKC').toUpperCase().replace(/\s+/g, ' ').trim();
  if (!raw) return '';
  const otc = /(?:\(|\b|[_-])OTC(?:\)|\b)?/i.test(raw);
  const pair = raw.match(/\b([A-Z0-9]{2,20})\s*[\/_-]\s*([A-Z0-9]{2,12})/i);
  return pair ? `${pair[1]}/${pair[2]}${otc ? ' (OTC)' : ''}` : raw;
};
const sameMarket = (a, b) => !!marketId(a) && marketId(a) === marketId(b);

function clockBaseReady(state = {}) {
  const focus = state.diagnostics?.focusedAsset || null;
  const clock = state.diagnostics?.marketClock || null;
  if (!focus || !clock || !state.asset) return false;
  return freshFocus(state)
    && sameMarket(focus.asset, state.asset)
    && clock.available !== false && clock.role === 'candle-close'
    && sameMarket(clock.asset, state.asset)
    && Number(clock.frameId) === Number(focus.frameId)
    && String(clock.frameHost || '').toLowerCase() === String(focus.frameHost || '').toLowerCase()
    && Date.now() - Number(clock.at || 0) < 2600
    && num(clock.secondsRemaining) != null;
}

function exactClockReady(state = {}) {
  const clock = state.diagnostics?.marketClock || null;
  return clockBaseReady(state)
    && clock?.verified === true
    && ['trader-dom-countdown','network-server-cycle'].includes(String(clock.source || ''));
}

function operationalClockReady(state = {}) {
  const clock = state.diagnostics?.marketClock || null;
  if (!clockBaseReady(state)) return false;
  if (exactClockReady(state)) return true;
  return clock?.verified !== true
    && clock?.operational === true
    && String(clock?.source || '') === 'platform-cycle-derived'
    && Number(clock?.confidence || 0) >= 50;
}

function sessionReady(state = {}) {
  const session = state.diagnostics?.marketSession || null;
  const sessionTf = String(session?.timeframe || '').toUpperCase();
  const stateTf = String(state.analysisTimeframe || state.timeframe || '').toUpperCase();
  return activeLicense(state) && state.platformId === 'casatrade' && state.connection === 'online'
    && !!state.asset && num(state.price) != null && fresh(state) && operationalClockReady(state)
    && sameMarket(session?.asset, state.asset)
    && (!sessionTf || !stateTf || sessionTf === stateTf);
}

function decisionModel(state = {}) {
  const signal = state.signal || {};
  if (!activeLicense(state)) return { key: 'BLOCKED', title: 'ANALISANDO MERCADO ATUAL', badge: 'BLOQUEADO', detail: 'Ative a licença para iniciar.', className: 'waiting' };
  if (!freshFocus(state)) return { key: 'ANALYZING_MARKET', title: 'ANALISANDO MERCADO ATUAL', badge: 'ANALISANDO', detail: 'Identificando o ativo realmente aberto no gráfico.', className: 'waiting' };
  if (!state.asset || num(state.price) == null) return { key: 'ANALYZING_MARKET', title: 'ANALISANDO MERCADO ATUAL', badge: 'ANALISANDO', detail: 'Ativo confirmado. Lendo a cotação real.', className: 'waiting' };
  if (!operationalClockReady(state)) return { key: 'ANALYZING_MARKET', title: 'ANALISANDO MERCADO ATUAL', badge: 'ANALISANDO', detail: 'Sincronizando o ciclo da vela com a CasaTrade.', className: 'waiting' };
  const map = {
    ANALYZING_MARKET: ['ANALISANDO MERCADO ATUAL','ANALISANDO','waiting'],
    BUILDING_PATTERN: ['MONTANDO PADRÃO DA PRÓXIMA VELA','PADRÃO','waiting'],
    POSSIBLE_BUY: ['POSSÍVEL COMPRA','POSSÍVEL','possible'],
    POSSIBLE_SELL: ['POSSÍVEL VENDA','POSSÍVEL','possible'],
    DECIDING: ['AGUARDAR','AGUARDAR','no-trade'],
    WAIT: ['AGUARDAR','AGUARDAR','no-trade'],
    ENTER_BUY: ['ENTRAR NA PRÓXIMA VELA: COMPRA','ENTRAR','buy'],
    ENTER_SELL: ['ENTRAR NA PRÓXIMA VELA: VENDA','ENTRAR','sell'],
    SKIP: ['AGUARDAR','AGUARDAR','no-trade']
  };
  const row = map[signal.uiState] || ['ANALISANDO MERCADO ATUAL','ANALISANDO','waiting'];
  return { key: signal.uiState || 'ANALYZING_MARKET', title: row[0], badge: row[1], className: row[2], detail: signal.reason || 'Analisando as velas e o contexto atual.' };
}

function ensureAudio() {
  const Ctx = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!Ctx) return null;
  if (!audioContext) audioContext = new Ctx();
  if (audioContext.state === 'suspended') audioContext.resume().catch(() => {});
  return audioContext;
}
function tone(freq, offset, duration, gainValue, type = 'triangle') {
  const ctx = ensureAudio(); if (!ctx) return;
  const oscillator = ctx.createOscillator(); const gain = ctx.createGain();
  const start = ctx.currentTime + offset;
  oscillator.frequency.setValueAtTime(freq, start); oscillator.type = type;
  gain.gain.setValueAtTime(.0001, start);
  gain.gain.exponentialRampToValueAtTime(Math.max(.001, Math.min(.28, gainValue)), start + .018);
  gain.gain.exponentialRampToValueAtTime(.0001, start + duration);
  oscillator.connect(gain); gain.connect(ctx.destination); oscillator.start(start); oscillator.stop(start + duration + .04);
}
function vibrate(pattern) {
  try { if (typeof navigator?.vibrate === 'function') navigator.vibrate(pattern); } catch {}
}
function play(kind) {
  if (kind === 'possible') {
    tone(660,0,.14,.11,'triangle');
    tone(840,.12,.16,.13,'triangle');
    vibrate([55,35,70]);
    return;
  }
  tone(620,0,.18,.16,'square');
  tone(860,.14,.20,.19,'triangle');
  tone(1120,.31,.22,.22,'triangle');
  tone(1360,.50,.18,.18,'square');
  vibrate([110,55,150,55,210]);
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
  const exactClock = exactClockReady(state);

  renderLicense(state);
  renderCandles(state);
  maybeSound(model, state);

  if ($('connectionBadge')) { $('connectionBadge').textContent = ready ? 'AO VIVO' : 'SINCRONIZANDO'; $('connectionBadge').className = `badge ${ready ? 'ok' : 'warn'}`; }
  if ($('asset')) $('asset').textContent = freshFocus(state) ? (state.diagnostics?.focusedAsset?.asset || state.asset || '—') : '—';
  if ($('price')) $('price').textContent = priceText(state.price);
  if ($('timeframe')) $('timeframe').textContent = state.analysisTimeframe || state.timeframe || clock.timeframe || '—';
  if ($('expiration')) $('expiration').textContent = state.targetExpiration || state.expiration || '—';
  if ($('secondsRemaining')) {
    const seconds = operationalClockReady(state) ? Math.max(0, Math.ceil(Number(clock.secondsRemaining))) : null;
    $('secondsRemaining').textContent = seconds == null ? '—' : `${exactClock ? '' : '~'}${seconds}`;
    $('secondsRemaining').title = exactClock ? 'Fechamento sincronizado com a CasaTrade.' : 'Clock temporário estimado; o scanner continua lendo o mercado ao vivo.';
  }
  if ($('sessionMode')) $('sessionMode').textContent = session.dataMode === 'backfill' ? 'HISTÓRICO SINCRONIZADO' : ready ? (exactClock ? 'LIVE' : 'LIVE • CLOCK ESTIMADO') : 'SYNC';

  const duration = (() => { const tf = String(state.analysisTimeframe || state.timeframe || '').toUpperCase(); let m=tf.match(/^S(\d+)$/); if(m)return Number(m[1]); m=tf.match(/^M(\d+)$/); if(m)return Number(m[1])*60; m=tf.match(/^H(\d+)$/); if(m)return Number(m[1])*3600; return null; })();
  if ($('candleProgress')) {
    const remaining = num(clock.secondsRemaining); const pct = duration && remaining != null ? Math.max(0,Math.min(100, ((duration-remaining)/duration)*100)) : 0;
    $('candleProgress').style.width = `${pct}%`;
  }

  if ($('analysisTitle')) $('analysisTitle').textContent = ready ? `${state.asset || 'Mercado'} • ${state.analysisTimeframe || state.timeframe || '—'}` : model.title;
  if ($('analysisReason')) $('analysisReason').textContent = ready
    ? `Sessão #${session.epoch || 1} • ${session.dataMode === 'backfill' ? 'histórico recebido em lote; somente a vela atual é live.' : exactClock ? 'dados ao vivo e fechamento sincronizado.' : 'dados ao vivo; fechamento exato indisponível, clock estimado identificado no painel.'}`
    : model.detail;

  const openReliable = current.openReliable !== false;
  const rangeReliable = current.rangeReliable !== false;
  if ($('currentOpen')) { $('currentOpen').textContent = observedPriceText(current.open, openReliable); $('currentOpen').title = openReliable ? 'Abertura confirmada pela vela da CasaTrade.' : 'Abertura observada após a conexão; pode não ser o primeiro tick real da vela.'; }
  if ($('currentHigh')) { $('currentHigh').textContent = observedPriceText(current.high, rangeReliable); $('currentHigh').title = rangeReliable ? 'Máxima da vela da CasaTrade.' : 'Máxima observada pela extensão desde a conexão nesta vela.'; }
  if ($('currentLow')) { $('currentLow').textContent = observedPriceText(current.low, rangeReliable); $('currentLow').title = rangeReliable ? 'Mínima da vela da CasaTrade.' : 'Mínima observada pela extensão desde a conexão nesta vela.'; }
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
  const possible = model.key === 'POSSIBLE_BUY' || model.key === 'POSSIBLE_SELL';
  if ($('prepareBuy')) { $('prepareBuy').disabled = model.key !== 'ENTER_BUY'; $('prepareBuy').classList.toggle('selected', model.key === 'ENTER_BUY'); }
  if ($('prepareSell')) { $('prepareSell').disabled = model.key !== 'ENTER_SELL'; $('prepareSell').classList.toggle('selected', model.key === 'ENTER_SELL'); }
  if ($('tradeActionStatus')) $('tradeActionStatus').textContent = confirmed
    ? `ENTRADA MANUAL • ${model.key === 'ENTER_BUY' ? 'COMPRA' : 'VENDA'} na próxima abertura`
    : possible
      ? 'Padrão possível detectado; aguardando estabilidade para a decisão final.'
      : 'AGUARDAR • sem confirmação suficiente para entrada.';
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
  if (value && /Sound/.test(key)) {
    ensureAudio();
    // Play an immediate preview so mobile browsers unlock audio and the user can verify the volume now.
    if (key === 'possibleSoundEnabled') play('possible');
    if (key === 'confirmSoundEnabled') play('confirm');
  }
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
