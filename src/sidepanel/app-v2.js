const $ = id => document.getElementById(id);
const PREF_KEY = 'atsScannerUiPreferences';
const DEFAULT_PREFS = Object.freeze({
  overlayEnabled: false,
  possibleSoundEnabled: false,
  confirmSoundEnabled: false,
  alertLevel: 'discrete',
  notificationsEnabled: true,
  analystMode: 'NORMAL',
  geminiEnabled: true,
  holdSeconds: 3
});

let prefs = { ...DEFAULT_PREFS };
let liveOhlc = null;
let audioContext = null;

const clean = value => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
const num = value => value == null || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null;
const activeLicense = state => {
  const status = String(state?.license?.status || '').toLowerCase();
  return ['active', 'valid'].includes(status)
    || state?.license?.devMode === true
    || String(state?.license?.plan || '').toUpperCase() === 'OWNER_DEV'
    || state?.diagnostics?.access?.ownerDev === true
    || state?.diagnostics?.access?.state === 'owner_dev';
};
const marketId = value => {
  const raw = clean(value).toUpperCase();
  if (!raw) return '';
  const otc = /(?:\(|\b|[_-])OTC(?:\)|\b)?/.test(raw);
  const match = raw.match(/\b([A-Z0-9]{2,20})\s*[\/_-]\s*([A-Z0-9]{2,12})/);
  return match ? `${match[1]}/${match[2]}${otc ? ' (OTC)' : ''}` : raw;
};
const sameMarket = (a, b) => !!marketId(a) && marketId(a) === marketId(b);

function normTf(value = '') {
  const raw = clean(value).toUpperCase().replace(/\s+/g, '');
  let match = raw.match(/^([SMH])(\d{1,5})$/);
  if (match && Number(match[2]) > 0) return `${match[1]}${Number(match[2])}`;
  match = raw.match(/^(\d{1,4})(?:M|MIN)$/);
  return match && Number(match[1]) > 0 ? `M${Number(match[1])}` : null;
}
function timeframeSeconds(value = '') {
  const tf = normTf(value);
  if (!tf) return null;
  if (tf[0] === 'S') return Number(tf.slice(1));
  if (tf[0] === 'M') return Number(tf.slice(1)) * 60;
  if (tf[0] === 'H') return Number(tf.slice(1)) * 3600;
  return null;
}
function normExp(value = '') {
  const raw = clean(value).toLowerCase().replace(/\s+/g, '');
  let match = raw.match(/^(\d{1,5})(?:s|seg|segundo|segundos)$/); if (match) return `${Number(match[1])}s`;
  match = raw.match(/^(\d{1,4})(?:m|min|minuto|minutos)$/); if (match) return `${Number(match[1]) * 60}s`;
  match = raw.match(/^(\d{1,3}):(\d{2})$/); if (match) return `${Number(match[1]) * 60 + Number(match[2])}s`;
  return null;
}
function expLabel(value = '') {
  const exp = normExp(value);
  if (!exp) return '—';
  const seconds = Number(exp.replace(/\D/g, ''));
  if (seconds % 3600 === 0) return `${seconds / 3600} h`;
  if (seconds % 60 === 0) return `${seconds / 60} min`;
  return `${seconds} s`;
}
function fmtPrice(value) {
  const n = num(value);
  if (n == null) return '—';
  const a = Math.abs(n);
  const digits = a >= 1000 ? 2 : a >= 100 ? 3 : a >= 1 ? 5 : 8;
  return n.toFixed(digits).replace(/0+$/, '').replace(/\.$/, '');
}

function focusReady(state = {}) {
  const focus = state.diagnostics?.focusedAsset || {};
  return focus.reliable === true
    && focus.chartScoped === true
    && focus.trustedChartFrame === true
    && (focus.embeddedTrader === true || focus.casaTradeFrame === true)
    && sameMarket(focus.asset, state.asset)
    && Number(focus.at || 0) > 0
    && Date.now() - Number(focus.at) < 5500;
}

function clockBaseReady(state = {}) {
  const clock = state.diagnostics?.marketClock || {};
  const focus = state.diagnostics?.focusedAsset || {};
  return focusReady(state)
    && clock.available !== false
    && clock.role === 'candle-close'
    && sameMarket(clock.asset, state.asset)
    && Number(clock.frameId) === Number(focus.frameId)
    && clean(clock.frameHost).toLowerCase() === clean(focus.frameHost).toLowerCase()
    && Number(clock.at || 0) > 0
    && Date.now() - Number(clock.at) < 3000
    && num(clock.secondsRemaining) != null;
}

function exactClockReady(state = {}) {
  const clock = state.diagnostics?.marketClock || {};
  if (!clockBaseReady(state)) return false;
  return clock.verified === true && ['trader-dom-countdown', 'network-server-cycle'].includes(String(clock.source || ''));
}

function operationalClockReady(state = {}) {
  const clock = state.diagnostics?.marketClock || {};
  if (!clockBaseReady(state)) return false;
  if (exactClockReady(state)) return true;
  return clock.verified !== true
    && clock.operational === true
    && clock.source === 'platform-cycle-derived'
    && Number(clock.confidence || 0) >= 50;
}

function sessionReady(state = {}) {
  return activeLicense(state)
    && state.connection === 'online'
    && !!state.asset
    && num(state.price) != null
    && focusReady(state)
    && operationalClockReady(state);
}

function entryTimeReady(state = {}) {
  if (!exactClockReady(state)) return false;
  const clock = state.diagnostics?.marketClock || {};
  const actualExpiration = normExp(state.platformControls?.observed?.expiration);
  const controlsFresh = Number(state.platformControls?.checkedAt || 0) > 0 && Date.now() - Number(state.platformControls.checkedAt) < 7000;
  if (!actualExpiration || !controlsFresh) return false;
  const clockTf = normTf(clock.timeframe);
  const stateTf = normTf(state.analysisTimeframe || state.timeframe);
  const controlTf = normTf(state.platformControls?.observed?.timeframe);
  if (!clockTf) return false;
  if (stateTf && stateTf !== clockTf) return false;
  if (controlTf && controlTf !== clockTf) return false;
  return state.professionalDecision?.timeReady !== false && state.professionalDecision?.expirationReady !== false;
}

function completeCandle(row = {}) {
  return [row.open, row.high, row.low, row.close].every(value => num(value) != null);
}

function liveCycleKey(state = {}) {
  const tf = normTf(state.analysisTimeframe || state.timeframe);
  const seconds = timeframeSeconds(tf);
  if (!state.asset || !tf || !seconds) return '';
  const targetStart = num(state.signal?.targetStart) ?? num(state.diagnostics?.marketClock?.closeAt);
  if (targetStart != null) return `${marketId(state.asset)}|${tf}|${Math.round(targetStart / 1000) * 1000}`;
  const remaining = num(state.diagnostics?.marketClock?.secondsRemaining);
  if (remaining == null) return `${marketId(state.asset)}|${tf}|unknown`;
  const estimatedClose = Date.now() + remaining * 1000;
  return `${marketId(state.asset)}|${tf}|${Math.round(estimatedClose / Math.max(1000, seconds * 1000))}`;
}

function currentOhlc(state = {}) {
  const direct = state.signal?.currentCandle || state.currentCandle || null;
  if (direct && completeCandle(direct)) {
    return {
      open: num(direct.open), high: num(direct.high), low: num(direct.low), close: num(direct.close),
      approximate: direct.partial === true || direct.openReliable === false || direct.rangeReliable === false,
      source: direct.source || 'casatrade'
    };
  }

  const tf = normTf(state.analysisTimeframe || state.timeframe);
  const durationMs = (timeframeSeconds(tf) || 0) * 1000;
  const now = Date.now();
  const rows = (Array.isArray(state.candles) ? state.candles : []).filter(completeCandle);
  const matching = rows.map(row => {
    let time = num(row.time ?? row.timestamp);
    if (time != null && time > 0 && time < 1e11) time *= 1000;
    return { row, time };
  }).filter(item => item.time && durationMs && now >= item.time - 1500 && now < item.time + durationMs + 1500).sort((a, b) => b.time - a.time)[0];
  if (matching) {
    return { open: num(matching.row.open), high: num(matching.row.high), low: num(matching.row.low), close: num(matching.row.close), approximate: false, source: 'structured-casatrade' };
  }

  const price = num(state.price);
  const key = liveCycleKey(state);
  if (price == null || !key) return { open: null, high: null, low: null, close: price, approximate: true, source: 'unavailable' };
  if (!liveOhlc || liveOhlc.key !== key) liveOhlc = { key, open: price, high: price, low: price, close: price };
  liveOhlc.high = Math.max(liveOhlc.high, price);
  liveOhlc.low = Math.min(liveOhlc.low, price);
  liveOhlc.close = price;
  return { ...liveOhlc, approximate: true, source: 'live-price-observed' };
}

function decisionModel(state = {}) {
  if (!activeLicense(state)) return { uiState: 'ANALYZING_MARKET', title: 'ANALISANDO MERCADO ATUAL', text: 'ANALISANDO MERCADO ATUAL', sub: 'Ative o acesso para iniciar a leitura.', tone: 'waiting', reason: 'Aguardando licença ativa.', score: 0, actionable: false };
  if (!state.asset || num(state.price) == null || !focusReady(state)) return { uiState: 'ANALYZING_MARKET', title: 'ANALISANDO MERCADO ATUAL', text: 'ANALISANDO MERCADO ATUAL', sub: 'Confirmando o ativo aberto e a cotação real.', tone: 'waiting', reason: 'Identificando o gráfico atual da CasaTrade.', score: 0, actionable: false };
  if (!entryTimeReady(state)) return { uiState: 'WAIT', title: 'AGUARDAR', text: 'AGUARDAR', sub: 'Tempo/expiração da CasaTrade ainda não estão sincronizados.', tone: 'no-trade', reason: 'AGUARDAR — tempo real da CasaTrade não confirmado.', score: Number(state.professionalDecision?.score || state.signal?.analysisScore || state.signal?.score || 0), actionable: false };

  const p = state.professionalDecision || {};
  const ui = String(p.uiState || '').toUpperCase();
  const score = Number(p.score ?? state.signal?.analysisScore ?? state.signal?.score ?? 0) || 0;
  const reason = clean(p.reason || state.signal?.reason || 'Aguardando confluência técnica.');
  if (ui === 'ANALYZING_MARKET') return { uiState: ui, title: 'ANALISANDO MERCADO ATUAL', text: 'ANALISANDO MERCADO ATUAL', sub: reason, tone: 'waiting', reason, score, actionable: false };
  if (ui === 'BUILDING_PATTERN') return { uiState: ui, title: 'MONTANDO PADRÃO', text: 'MONTANDO PADRÃO DA PRÓXIMA VELA', sub: reason, tone: 'waiting', reason, score, actionable: false };
  if (ui === 'POSSIBLE_BUY') return { uiState: ui, title: 'POSSÍVEL COMPRA', text: 'POSSÍVEL COMPRA', sub: 'Possível COMPRA na próxima vela', tone: 'possible', reason, score, actionable: false };
  if (ui === 'POSSIBLE_SELL') return { uiState: ui, title: 'POSSÍVEL VENDA', text: 'POSSÍVEL VENDA', sub: 'Possível VENDA na próxima vela', tone: 'possible', reason, score, actionable: false };
  if (ui === 'ENTER_BUY' && p.actionable === true) return { uiState: ui, title: 'ENTRAR NA PRÓXIMA VELA', text: 'ENTRAR: COMPRA', sub: 'ENTRAR na próxima vela: COMPRA', tone: 'buy', reason, score, actionable: true, direction: 'BUY' };
  if (ui === 'ENTER_SELL' && p.actionable === true) return { uiState: ui, title: 'ENTRAR NA PRÓXIMA VELA', text: 'ENTRAR: VENDA', sub: 'ENTRAR na próxima vela: VENDA', tone: 'sell', reason, score, actionable: true, direction: 'SELL' };
  return { uiState: 'WAIT', title: 'AGUARDAR', text: 'AGUARDAR', sub: 'Padrão sem qualidade suficiente.', tone: 'no-trade', reason: reason.startsWith('AGUARDAR') ? reason : `AGUARDAR — ${reason}`, score, actionable: false };
}

function setText(id, value) { const el = $(id); if (el) el.textContent = value; }
function setBadge(id, value, tone = '') { const el = $(id); if (!el) return; el.textContent = value; el.className = `badge ${tone}`.trim(); }

function renderCandles(state = {}) {
  const rows = (Array.isArray(state.candles) ? state.candles : []).filter(completeCandle).slice(-10);
  setText('recentCandleCount', `${rows.length}/10`);
  const box = $('recentCandles');
  if (!box) return;
  box.replaceChildren();
  const padded = Array(Math.max(0, 10 - rows.length)).fill(null).concat(rows);
  for (const row of padded) {
    const slot = document.createElement('span');
    slot.className = 'mini-candle-slot empty';
    if (row) {
      const open = Number(row.open), close = Number(row.close), high = Number(row.high), low = Number(row.low);
      const range = Math.max(1e-12, high - low);
      const top = 7 + ((high - Math.max(open, close)) / range) * 76;
      const bottom = 7 + ((Math.min(open, close) - low) / range) * 76;
      slot.className = `mini-candle-slot ${close > open ? 'buy' : close < open ? 'sell' : 'doji'}`;
      const wick = document.createElement('i'); wick.className = 'mini-wick';
      const body = document.createElement('i'); body.className = 'mini-body';
      body.style.top = `${Math.max(7, Math.min(85, top))}%`;
      body.style.bottom = `${Math.max(7, Math.min(85, bottom))}%`;
      slot.append(wick, body);
    }
    box.append(slot);
  }
}

function renderOhlc(state = {}) {
  const row = currentOhlc(state);
  const mark = row.approximate ? '≈' : '';
  setText('currentOpen', row.open == null ? '—' : `${mark}${fmtPrice(row.open)}`);
  setText('currentHigh', row.high == null ? '—' : `${mark}${fmtPrice(row.high)}`);
  setText('currentLow', row.low == null ? '—' : `${mark}${fmtPrice(row.low)}`);
  setText('currentClose', row.close == null ? '—' : fmtPrice(row.close));
  setText('ohlcQuality', row.source === 'structured-casatrade'
    ? 'OHLC estruturado recebido da CasaTrade.'
    : row.open != null
      ? '≈ OHLC parcial montado apenas com preços reais observados nesta vela.'
      : 'Aguardando abertura/range confiáveis da vela atual.');
}

function renderLicense(state = {}) {
  const license = state.license || {};
  const active = activeLicense(state);
  const card = $('licenseCard');
  if (card) card.classList.toggle('active', active);
  setText('licenseTitle', active ? `Licença ${license.planLabel || license.plan || 'ATIVA'}` : 'Licença necessária');
  setBadge('licenseHealth', active ? 'ATIVA' : 'INATIVA', active ? 'ok' : 'warn');
  setText('licenseText', active ? 'Acesso validado. O scanner pode ler o mercado aberto.' : (license.error ? `Acesso: ${license.error}` : 'Insira sua chave para ativar.'));
  const box = $('activationBox'); if (box) box.hidden = active;
}

function render(state = {}) {
  const model = decisionModel(state);
  const clock = state.diagnostics?.marketClock || {};
  const exact = exactClockReady(state);
  const dataLive = sessionReady(state);
  const timeReady = entryTimeReady(state);
  const remaining = num(clock.secondsRemaining);
  const actualTf = normTf(clock.timeframe || state.platformControls?.observed?.timeframe || state.analysisTimeframe || state.timeframe);
  const actualExp = normExp(state.platformControls?.observed?.expiration || state.targetExpiration || state.expiration);

  setText('asset', state.asset || '—');
  setText('timeframe', actualTf || '—');
  setText('price', fmtPrice(state.price));
  setText('heroCountdown', remaining == null ? '—' : exact ? `${Math.ceil(remaining)}s` : `~${Math.ceil(remaining)}s`);
  setText('heroExpiration', expLabel(actualExp));
  setText('heroTimeStatus', timeReady ? 'OK' : dataLive ? 'AGUARDAR' : 'SYNC');
  setText('sessionMode', timeReady ? 'LIVE' : dataLive ? 'LIVE • CLOCK ESTIMADO' : 'SYNC');

  if (timeReady) setBadge('connectionBadge', 'AO VIVO', 'ok');
  else if (dataLive) setBadge('connectionBadge', 'AGUARDAR', 'warn');
  else setBadge('connectionBadge', 'SINCRONIZANDO', 'warn');

  setText('signalTitle', model.title);
  setText('decisionText', model.text);
  setText('decisionSubtext', model.sub);
  setText('signalReason', model.reason);
  setText('signalScore', `${Math.round(model.score)}/100`);
  setText('technicalConfidence', `${Math.round(model.score)}/100`);
  setText('technicalConfidenceLabel', model.uiState.startsWith('ENTER_') ? 'CONFIRMADO' : model.uiState.startsWith('POSSIBLE_') ? 'EM OBSERVAÇÃO' : 'FORÇA DO PADRÃO');
  setText('setupType', clean(state.signal?.setup || state.signal?.regime?.type || '—') || '—');
  setText('secondsRemaining', remaining == null ? '—' : exact ? String(Math.max(0, Math.ceil(remaining))) : `~${Math.max(0, Math.ceil(remaining))}`);
  setText('expiration', expLabel(actualExp));
  setText('timeSyncStatus', timeReady ? 'OK • CASATRADE' : exact ? 'EXPIRAÇÃO PENDENTE' : operationalClockReady(state) ? 'ESTIMADO • BLOQUEADO' : 'SINCRONIZANDO');

  const decisionCard = $('decisionCard');
  if (decisionCard) decisionCard.className = `card decision-card ${model.tone}`;
  const banner = $('decisionBanner');
  if (banner) banner.className = `decision-banner ${model.tone}`;
  const badgeTone = model.tone === 'buy' ? 'ok' : model.tone === 'sell' ? 'bad' : 'warn';
  setBadge('signalBadge', model.actionable ? 'ENTRAR' : model.uiState.startsWith('POSSIBLE_') ? 'POSSÍVEL' : 'AGUARDAR', badgeTone);

  const duration = timeframeSeconds(actualTf);
  const progress = $('candleProgress');
  if (progress) {
    const pct = duration && remaining != null ? Math.max(0, Math.min(100, ((duration - remaining) / duration) * 100)) : 0;
    progress.style.width = `${pct}%`;
  }

  const buy = $('prepareBuy'), sell = $('prepareSell');
  const canBuy = model.actionable && model.direction === 'BUY' && timeReady;
  const canSell = model.actionable && model.direction === 'SELL' && timeReady;
  if (buy) { buy.disabled = !canBuy; buy.classList.toggle('selected', canBuy); }
  if (sell) { sell.disabled = !canSell; sell.classList.toggle('selected', canSell); }
  setText('tradeActionStatus', model.actionable && timeReady
    ? `Entrada manual liberada para ${model.direction === 'BUY' ? 'COMPRA' : 'VENDA'} na próxima vela.`
    : !timeReady
      ? 'Bloqueado: confirme countdown + timeframe + expiração reais da CasaTrade.'
      : model.uiState.startsWith('POSSIBLE_')
        ? `Possível sinal em hold (${Math.ceil(Number(state.professionalDecision?.holdRemainingMs || 0) / 1000)}s restantes).`
        : 'Aguardando decisão final desta vela.');

  renderOhlc(state);
  renderCandles(state);
  renderLicense(state);
  // Live signal audio is emitted by the background alert worker so it also works with the sidepanel closed.
}

function tone(frequency, delay, duration, gain = .12) {
  try {
    audioContext ||= new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioContext.createOscillator();
    const amp = audioContext.createGain();
    const start = audioContext.currentTime + delay;
    osc.frequency.value = frequency;
    osc.type = 'sine';
    amp.gain.setValueAtTime(.0001, start);
    amp.gain.exponentialRampToValueAtTime(gain, start + .02);
    amp.gain.exponentialRampToValueAtTime(.0001, start + duration);
    osc.connect(amp); amp.connect(audioContext.destination); osc.start(start); osc.stop(start + duration + .03);
  } catch {}
}
function play(kind) {
  if (kind === 'possible') {
    tone(660,0,.14,.11); tone(820,.17,.13,.10);
    try { navigator?.vibrate?.([55,35,70]); } catch {}
    return;
  }
  tone(760,0,.18,.17); tone(940,.17,.19,.19); tone(1120,.31,.22,.22);
  try { navigator?.vibrate?.([110,55,150,55,210]); } catch {}
}
function syncSettingsUi() {
  if ($('overlayToggle')) $('overlayToggle').checked = !!prefs.overlayEnabled;
  if ($('geminiToggle')) $('geminiToggle').checked = prefs.geminiEnabled !== false;
  if ($('analystMode')) $('analystMode').value = prefs.analystMode === 'A_PLUS' ? 'A_PLUS' : 'NORMAL';
  if ($('notificationToggle')) $('notificationToggle').checked = prefs.notificationsEnabled !== false;
  if ($('alertLevel')) $('alertLevel').value = ['off','discrete','strong'].includes(prefs.alertLevel) ? prefs.alertLevel : DEFAULT_PREFS.alertLevel;
  if ($('holdSeconds')) $('holdSeconds').value = String(Math.max(3, Math.min(5, Number(prefs.holdSeconds) || 3)));
  if ($('possibleSoundToggle')) $('possibleSoundToggle').checked = prefs.alertLevel === 'discrete' || prefs.alertLevel === 'strong';
  if ($('confirmSoundToggle')) $('confirmSoundToggle').checked = prefs.alertLevel === 'strong';
  document.querySelectorAll('.toggle-row').forEach(row => row.classList.toggle('active', !!row.querySelector('input[type=checkbox]')?.checked));
}

async function pushAnalystPreferences() {
  await chrome.runtime.sendMessage({
    type: 'ATS_SET_ANALYST_PREFERENCES',
    mode: 'NORMAL',
    geminiEnabled: prefs.geminiEnabled,
    holdSeconds: 3,
    preferredExpiration: null
  }).catch(() => null);
}

async function savePrefs() {
  await chrome.storage.local.set({ [PREF_KEY]: prefs }).catch(() => {});
  await pushAnalystPreferences();
}

async function setPref(key, value) {
  prefs = { ...prefs, [key]: value };
  if (key === 'possibleSoundEnabled' && value) play('possible');
  if (key === 'confirmSoundEnabled' && value) play('confirm');
  if (key === 'alertLevel' && value === 'discrete') play('possible');
  if (key === 'alertLevel' && value === 'strong') play('confirm');
  syncSettingsUi();
  await savePrefs();
}

async function loadPrefs() {
  const stored = await chrome.storage.local.get(PREF_KEY).catch(() => ({}));
  const raw = stored?.[PREF_KEY] || {};
  const migratedAlert = raw.alertLevel || (raw.confirmSoundEnabled ? 'strong' : raw.possibleSoundEnabled ? 'discrete' : DEFAULT_PREFS.alertLevel);
  prefs = {
    ...DEFAULT_PREFS,
    ...raw,
    overlayEnabled: false,
    notificationsEnabled: raw.notificationsEnabled !== false,
    alertLevel: ['off','discrete','strong'].includes(migratedAlert) ? migratedAlert : DEFAULT_PREFS.alertLevel,
    analystMode: 'NORMAL',
    geminiEnabled: raw.geminiEnabled !== false,
    holdSeconds: 3
  };
  syncSettingsUi();
  await pushAnalystPreferences();
}

$('overlayToggle')?.addEventListener('change', event => setPref('overlayEnabled', !!event.currentTarget.checked));
$('geminiToggle')?.addEventListener('change', event => setPref('geminiEnabled', !!event.currentTarget.checked));
$('notificationToggle')?.addEventListener('change', event => setPref('notificationsEnabled', !!event.currentTarget.checked));
$('analystMode')?.addEventListener('change', event => setPref('analystMode', event.currentTarget.value === 'A_PLUS' ? 'A_PLUS' : 'NORMAL'));
$('alertLevel')?.addEventListener('change', event => setPref('alertLevel', event.currentTarget.value));
$('holdSeconds')?.addEventListener('change', event => setPref('holdSeconds', Math.max(3, Math.min(5, Number(event.currentTarget.value) || 3))));
$('possibleSoundToggle')?.addEventListener('change', event => setPref('possibleSoundEnabled', !!event.currentTarget.checked));
$('confirmSoundToggle')?.addEventListener('change', event => setPref('confirmSoundEnabled', !!event.currentTarget.checked));

$('activateLicense')?.addEventListener('click', async () => {
  const key = clean($('licenseKey')?.value || '');
  if (!key) return;
  const response = await chrome.runtime.sendMessage({ type: 'ATS_ACTIVATE_LICENSE', key }).catch(() => null);
  if (response?.state) render(response.state);
});

chrome.storage.onChanged.addListener(changes => {
  if (changes.scannerState?.newValue) render(changes.scannerState.newValue || {});
  if (changes[PREF_KEY]?.newValue) {
    const raw = changes[PREF_KEY].newValue || {};
    prefs = { ...prefs, ...raw };
    syncSettingsUi();
  }
});

(async () => {
  setText('extensionVersion', `v${chrome.runtime.getManifest().version}`);
  await loadPrefs();
  const response = await chrome.runtime.sendMessage({ type: 'ATS_READ_SCANNER_STATE' });
  if (response?.state) render(response.state);
})().catch(() => render({}));
