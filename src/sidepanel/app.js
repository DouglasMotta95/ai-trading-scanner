const LAST_VALID_LICENSE_KEY = 'atsLastValidLicense';
const $ = id => document.getElementById(id);
let lastState = {};
let reconnectBusy = false;
let reconnectAttempt = 0;
let nextReconnectAt = 0;
const RECONNECT_DELAYS_MS = [2000, 4000, 8000, 15000, 30000];
const UI_PREF_KEY = 'atsScannerUiPreferences';
const DEFAULT_UI_PREFS = Object.freeze({ overlayEnabled: false, possibleSoundEnabled: false, confirmSoundEnabled: false });
let uiPrefs = { ...DEFAULT_UI_PREFS };
let audioContext = null;
let audibleStateReady = false;
let lastAudiblePrincipalKey = null;

if ($('extensionVersion')) $('extensionVersion').textContent = `v${chrome.runtime.getManifest().version}`;

const num = v => v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null;
const fresh = s => licenseStillValid(s?.license) && s.connection === 'online' && !!s.asset && num(s.price) != null && s.lastSeen && Date.now() - Number(s.lastSeen) < 8000;
const priceText = v => num(v) == null ? '—' : String(v);

function expiryMs(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number' || /^\d+(?:\.\d+)?$/.test(String(value).trim())) {
    let n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return null;
    if (n < 1e12) n *= 1000;
    return n;
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

const licenseStillValid = l => {
  const status = String(l?.status || '').toLowerCase();
  if (status !== 'active' && status !== 'valid') return false;
  if (!l.expiresAt) return true;
  const t = expiryMs(l.expiresAt);
  return t != null && t > Date.now();
};

const effectiveLicense = (stateLicense = {}, cachedEntry = null) => {
  if (licenseStillValid(stateLicense)) return { ...stateLicense, status: 'active' };
  if (['expired', 'limit', 'device_locked'].includes(String(stateLicense?.status || ''))) return stateLicense;
  const cached = cachedEntry?.license;
  if (licenseStillValid(cached)) return { ...cached, status: 'active', error: null, syncPending: false };
  return stateLicense;
};

const licenseErrorText = error => ({
  license_required: 'Digite sua chave ATS para ativar.',
  license_not_found: 'Chave não encontrada. Confira e tente novamente.',
  license_inactive: 'Essa chave está inativa.',
  license_expired: 'Essa chave está expirada.',
  device_limit_reached: 'Essa chave atingiu o limite de dispositivos.',
  backend_unreachable: 'Não foi possível falar com o servidor de licenças. A chave não foi ativada.'
}[String(error || '')] || 'Não foi possível ativar a chave. Ela foi mantida no campo para você conferir.');

function marketStep(s = {}) {
  const acquisition = s.diagnostics?.acquisition || {};
  const signal = s.signal || {};
  const candleCount = Math.max(0, Number(signal.candleCount ?? acquisition.candleCount ?? s.candles?.length ?? 0));
  const required = Math.max(2, Number(signal.warmup?.required || 2));
  if (!licenseStillValid(s.license)) return { stage: 'blocked', reason: 'Ative a licença para conectar à CasaTrade.', candleCount, required };
  if (!s.platformId) return { stage: 'connecting', reason: acquisition.reason || 'Conectando à aba da CasaTrade.', candleCount, required };
  if (!s.asset) return { stage: 'confirming_asset', reason: acquisition.reason || 'Confirmando o ativo aberto na CasaTrade.', candleCount, required };
  if (num(s.price) == null) return { stage: 'reading_price', reason: acquisition.reason || 'Ativo encontrado. Lendo a cotação real do mesmo ativo.', candleCount, required };
  if (s.connection !== 'online') return { stage: acquisition.stage || 'connecting', reason: acquisition.reason || 'Sincronizando ativo e cotação.', candleCount, required };
  if (!s.lastSeen || Date.now() - Number(s.lastSeen) >= 8000) return { stage: 'reading_price', reason: 'Atualizando a cotação real do ativo aberto.', candleCount, required };
  if (candleCount < required || signal.state === 'SEARCHING' || signal.phase === 'HISTORY') {
    return { stage: 'reading_history', reason: `Analisando mercado atual • ${candleCount}/${required} velas fechadas.`, candleCount, required };
  }
  if (!signal.currentCandle && !s.currentCandle) return { stage: 'analyzing_current', reason: 'Analisando a vela atual.', candleCount, required };
  return { stage: 'diagnosing_next_candle', reason: signal.reason || acquisition.reason || 'Montando o padrão da próxima vela.', candleCount, required };
}

const stepTitle = step => ({
  blocked: 'Analisando mercado atual',
  connecting: 'Analisando mercado atual',
  confirming_asset: 'Analisando mercado atual',
  reading_price: 'Analisando mercado atual',
  reading_history: 'Analisando mercado atual',
  analyzing_current: 'Analisando mercado atual',
  diagnosing_next_candle: 'Montando padrão da próxima vela'
}[step.stage] || 'Analisando mercado atual');

function principalState(s = {}) {
  const step = marketStep(s);
  const sig = s.signal || {};
  const active = licenseStillValid(s.license);
  const online = active && fresh(s) && s.platformId === 'casatrade';
  if (!active) return { key: 'BLOCKED', text: 'ATIVAÇÃO NECESSÁRIA', detail: 'Ative a licença para iniciar a análise.' };
  if (!online || step.stage !== 'diagnosing_next_candle') {
    return { key: 'ANALYZING_MARKET', text: 'ANALISANDO MERCADO ATUAL', detail: step.reason };
  }

  const states = {
    ANALYZING_MARKET: ['ANALYZING_MARKET', 'ANALISANDO MERCADO ATUAL'],
    BUILDING_PATTERN: ['BUILDING_PATTERN', 'MONTANDO PADRÃO DA PRÓXIMA VELA'],
    POSSIBLE_BUY: ['POSSIBLE_BUY', 'POSSÍVEL COMPRA'],
    POSSIBLE_SELL: ['POSSIBLE_SELL', 'POSSÍVEL VENDA'],
    ENTER_BUY: ['ENTER_BUY', 'ENTRAR NA PRÓXIMA VELA: COMPRA'],
    ENTER_SELL: ['ENTER_SELL', 'ENTRAR NA PRÓXIMA VELA: VENDA'],
    WAIT: ['WAIT', 'AGUARDAR']
  };
  const selected = states[sig.uiState] || states.WAIT;
  return { key: selected[0], text: selected[1], detail: sig.reason || 'Sem direção firme para a próxima vela.' };
}

function syncPreferenceControls() {
  if ($('overlayToggle')) $('overlayToggle').checked = !!uiPrefs.overlayEnabled;
  if ($('possibleSoundToggle')) $('possibleSoundToggle').checked = !!uiPrefs.possibleSoundEnabled;
  if ($('confirmSoundToggle')) $('confirmSoundToggle').checked = !!uiPrefs.confirmSoundEnabled;
}

async function loadUiPreferences() {
  const stored = await chrome.storage.local.get(UI_PREF_KEY).catch(() => ({}));
  uiPrefs = { ...DEFAULT_UI_PREFS, ...(stored[UI_PREF_KEY] || {}) };
  syncPreferenceControls();
}

async function saveUiPreference(key, value) {
  uiPrefs = { ...uiPrefs, [key]: !!value };
  await chrome.storage.local.set({ [UI_PREF_KEY]: uiPrefs });
  syncPreferenceControls();
  if ((key === 'possibleSoundEnabled' || key === 'confirmSoundEnabled') && value) ensureAudioContext();
}

function ensureAudioContext() {
  const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!AudioContextClass) return null;
  if (!audioContext) audioContext = new AudioContextClass();
  if (audioContext.state === 'suspended') audioContext.resume().catch(() => {});
  return audioContext;
}

function pulseTone(frequency, startOffset, duration, volume) {
  const context = ensureAudioContext();
  if (!context) return;
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  const startsAt = context.currentTime + startOffset;
  oscillator.type = 'sine';
  oscillator.frequency.setValueAtTime(frequency, startsAt);
  gain.gain.setValueAtTime(0.0001, startsAt);
  gain.gain.exponentialRampToValueAtTime(Math.max(0.001, volume), startsAt + .018);
  gain.gain.exponentialRampToValueAtTime(0.0001, startsAt + duration);
  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.start(startsAt);
  oscillator.stop(startsAt + duration + .02);
}

function playSignalTone(kind) {
  if (kind === 'possible') {
    pulseTone(620, 0, .09, .035);
    pulseTone(760, .11, .09, .03);
    return;
  }
  pulseTone(760, 0, .11, .06);
  pulseTone(980, .12, .12, .07);
  pulseTone(1240, .25, .14, .08);
}

function maybePlaySignalAlert(s = {}) {
  const key = principalState(s).key;
  if (!audibleStateReady) {
    audibleStateReady = true;
    lastAudiblePrincipalKey = key;
    return;
  }
  if (key === lastAudiblePrincipalKey) return;
  lastAudiblePrincipalKey = key;
  if ((key === 'POSSIBLE_BUY' || key === 'POSSIBLE_SELL') && uiPrefs.possibleSoundEnabled) playSignalTone('possible');
  if ((key === 'ENTER_BUY' || key === 'ENTER_SELL') && uiPrefs.confirmSoundEnabled) playSignalTone('confirm');
}

function renderLicense(s = {}) {
  const l = s.license || {};
  const active = licenseStillValid(l);
  $('licenseCard')?.classList.toggle('active', active);
  if ($('activationBox')) { const box = $('activationBox'); const accountManaged = box.dataset.accountManaged === '1'; const manualOpen = box.dataset.manualOpen === '1'; box.hidden = active || (accountManaged && !manualOpen); }
  if ($('licenseHealth')) {
    $('licenseHealth').textContent = active ? 'ATIVA' : String(l.status || 'INATIVA').toUpperCase();
    $('licenseHealth').className = `badge ${active ? 'ok' : l.status === 'expired' || l.status === 'device_locked' ? 'bad' : ''}`;
  }
  if ($('licenseTitle')) $('licenseTitle').textContent = active ? 'Licença ativa' : l.status === 'expired' ? 'Licença expirada' : 'Ativação necessária';
  if ($('licenseText')) {
    const expiry = expiryMs(l.expiresAt);
    $('licenseText').textContent = active
      ? `${l.planLabel || l.plan || 'Plano'} ativo${expiry ? ` • vence ${new Date(expiry).toLocaleDateString('pt-BR')}` : ''}.`
      : l.error
        ? licenseErrorText(l.error)
        : 'Ative sua licença para usar o scanner. O mercado só conecta depois da ativação.';
  }
}

function renderRecentCandles(s = {}) {
  const box = $('recentCandles');
  if (!box) return;
  const rows = (Array.isArray(s.candles) ? s.candles : []).filter(c => [c?.open, c?.high, c?.low, c?.close].every(v => num(v) != null)).slice(-10);
  if ($('recentCandleCount')) $('recentCandleCount').textContent = `${rows.length}/10`;
  box.replaceChildren();

  for (let i = 0; i < 10; i++) {
    const candle = rows[i - (10 - rows.length)];
    const slot = document.createElement('div');
    slot.className = 'mini-candle-slot';
    if (!candle) {
      slot.classList.add('empty');
      box.appendChild(slot);
      continue;
    }

    const open = Number(candle.open), high = Number(candle.high), low = Number(candle.low), close = Number(candle.close);
    const range = Math.max(1e-12, high - low);
    const top = ((high - Math.max(open, close)) / range) * 100;
    const body = Math.max(10, (Math.abs(close - open) / range) * 100);
    const dir = close > open ? 'buy' : close < open ? 'sell' : 'doji';
    slot.classList.add(dir);
    slot.title = `${dir === 'buy' ? 'Alta' : dir === 'sell' ? 'Baixa' : 'Neutra'} • ${open} → ${close}`;

    const wick = document.createElement('i');
    wick.className = 'mini-wick';
    const bodyEl = document.createElement('b');
    bodyEl.className = 'mini-body';
    bodyEl.style.top = `${Math.max(0, Math.min(88, top))}%`;
    bodyEl.style.height = `${Math.max(10, Math.min(90, body))}%`;
    slot.append(wick, bodyEl);
    box.appendChild(slot);
  }
}

function renderAnalysis(s = {}) {
  const active = licenseStillValid(s.license);
  const online = active && fresh(s) && s.platformId === 'casatrade';
  const sig = s.signal || {};
  const current = online ? (sig.currentCandle || s.currentCandle || {}) : {};
  const principal = principalState(s);

  if ($('connectionBadge')) {
    const connected = active && s.connection === 'online' && !!s.asset && num(s.price) != null;
    $('connectionBadge').textContent = !active ? 'BLOQUEADO' : connected ? 'CONECTADO' : 'SINCRONIZANDO';
    $('connectionBadge').className = `badge ${connected ? 'ok' : 'warn'}`;
  }

  if ($('analysisTitle')) $('analysisTitle').textContent = principal.text;
  if ($('asset')) $('asset').textContent = active && s.asset ? s.asset : '—';
  if ($('price')) $('price').textContent = online && s.price != null ? String(s.price) : '—';
  if ($('secondsRemaining')) $('secondsRemaining').textContent = online && num(sig.secondsRemaining) != null ? String(Math.max(0, Math.ceil(Number(sig.secondsRemaining)))) : '—';
  if ($('timeframe')) $('timeframe').textContent = online ? (s.analysisTimeframe || sig.timeframe || s.timeframe || 'M1') : '—';
  if ($('expiration')) $('expiration').textContent = online ? (s.targetExpiration || sig.targetExpiration || s.expiration || '—') : '—';
  if ($('candleProgress')) $('candleProgress').style.width = `${online && num(sig.progress) != null ? Math.max(0, Math.min(100, Number(sig.progress))) : 0}%`;
  if ($('analysisReason')) $('analysisReason').textContent = principal.detail;

  if ($('currentOpen')) $('currentOpen').textContent = priceText(current.open);
  if ($('currentHigh')) $('currentHigh').textContent = priceText(current.high);
  if ($('currentLow')) $('currentLow').textContent = priceText(current.low);
  if ($('currentClose')) $('currentClose').textContent = priceText(current.close);
  renderRecentCandles(active && Array.isArray(s.candles) ? s : { candles: [] });
}

function renderTradeActions(s = {}, online = false) {
  const sig = online ? (s.signal || {}) : {};
  const principal = principalState(s);
  const confirmed = sig.state === 'CONFIRM' && sig.provisional === false && ['BUY', 'SELL'].includes(sig.direction);
  const possible = sig.state === 'WATCH' && ['BUY', 'SELL'].includes(sig.direction);
  const buy = $('prepareBuy');
  const sell = $('prepareSell');

  if (buy) {
    buy.disabled = !(confirmed && sig.direction === 'BUY');
    buy.className = `trade-choice buy-choice${sig.direction === 'BUY' && (confirmed || possible) ? ' selected' : ''}${possible && sig.direction === 'BUY' ? ' possible' : ''}`;
  }
  if (sell) {
    sell.disabled = !(confirmed && sig.direction === 'SELL');
    sell.className = `trade-choice sell-choice${sig.direction === 'SELL' && (confirmed || possible) ? ' selected' : ''}${possible && sig.direction === 'SELL' ? ' possible' : ''}`;
  }
  if ($('tradeActionStatus')) $('tradeActionStatus').textContent = principal.text;
}

function decisionTime(value) {
  const t = Number(value);
  if (!Number.isFinite(t) || t <= 0) return '';
  return new Date(t).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function renderSeparatedSignalState(s = {}, online = false) {
  const last = online ? (s.lastConfirmed || null) : null;
  const principal = principalState(s);
  if ($('lastConfirmed')) {
    if (!last) {
      $('lastConfirmed').textContent = 'Nenhuma decisão finalizada nesta sessão.';
    } else {
      const result = last.state === 'CONFIRM' ? (last.direction === 'SELL' ? 'VENDA' : 'COMPRA') : 'SEM ENTRADA';
      const at = decisionTime(last.time || last.targetStart);
      $('lastConfirmed').textContent = `${result}${at ? ` • ${at}` : ''}${num(last.score) != null ? ` • ${Math.round(Number(last.score))}/100` : ''}`;
    }
  }
  if ($('analyzingNow')) $('analyzingNow').textContent = principal.text;
}

function renderDecision(s = {}) {
  const active = licenseStillValid(s.license);
  const online = active && fresh(s) && s.platformId === 'casatrade';
  const sig = online ? (s.signal || {}) : {};
  const principal = principalState(s);
  const card = $('decisionCard');
  const banner = $('decisionBanner');

  card?.classList.remove('buy', 'sell', 'no-trade');
  banner?.classList.remove('waiting', 'possible', 'buy', 'sell', 'no-trade');

  let bannerClass = 'waiting';
  let badgeClass = 'badge';
  if (principal.key === 'POSSIBLE_BUY' || principal.key === 'POSSIBLE_SELL') {
    bannerClass = 'possible';
    badgeClass = 'badge warn';
  } else if (principal.key === 'ENTER_BUY') {
    bannerClass = 'buy';
    badgeClass = 'badge ok';
    card?.classList.add('buy');
  } else if (principal.key === 'ENTER_SELL') {
    bannerClass = 'sell';
    badgeClass = 'badge ok';
    card?.classList.add('sell');
  } else if (principal.key === 'WAIT') {
    bannerClass = 'no-trade';
    badgeClass = 'badge warn';
    card?.classList.add('no-trade');
  } else if (principal.key === 'BLOCKED') {
    badgeClass = 'badge warn';
  }

  if ($('signalTitle')) $('signalTitle').textContent = principal.text;
  if ($('signalBadge')) {
    $('signalBadge').textContent = principal.text;
    $('signalBadge').className = badgeClass;
  }
  if (banner) banner.classList.add(bannerClass);
  if ($('decisionText')) $('decisionText').textContent = principal.text;
  if ($('decisionSubtext')) $('decisionSubtext').textContent = principal.detail;
  renderSeparatedSignalState(s, online);
  if ($('signalReason')) $('signalReason').textContent = principal.detail;
  if ($('signalScore')) $('signalScore').textContent = online && num(sig.score) != null ? `${Math.round(Number(sig.score))}/100` : '—';
  if ($('targetTime')) {
    const realEntry = num(s.lastConfirmed?.entryPrice);
    $('targetTime').textContent = !online
      ? '—'
      : sig.state === 'CONFIRM'
        ? 'AGUARDANDO ABERTURA REAL'
        : realEntry != null ? String(realEntry) : '—';
  }
  renderTradeActions(s, online);
}

function render(s = {}) {
  lastState = s;
  renderLicense(s);
  renderAnalysis(s);
  renderDecision(s);
  maybePlaySignalAlert(s);
}

async function getState() {
  const [state, stored] = await Promise.all([
    chrome.runtime.sendMessage({ type: 'ATS_READ_SCANNER_STATE' }).catch(() => ({})),
    chrome.storage.local.get(LAST_VALID_LICENSE_KEY).catch(() => ({}))
  ]);
  const scannerState = state?.state || {};
  const license = effectiveLicense(scannerState?.license || {}, stored[LAST_VALID_LICENSE_KEY] || null);
  const rendered = { ...scannerState, license };
  render(rendered);
  return rendered;
}

async function autoConnect(force = false) {
  if (reconnectBusy || !licenseStillValid(lastState.license)) return;
  if (!force && fresh(lastState) && lastState.platformId === 'casatrade') {
    reconnectAttempt = 0;
    nextReconnectAt = 0;
    return;
  }
  const now = Date.now();
  if (!force && now < nextReconnectAt) return;

  reconnectBusy = true;
  try {
    const alreadyTargetingCasaTrade = lastState.platformId === 'casatrade' && !!lastState.targetTabId;
    const type = force || !alreadyTargetingCasaTrade ? 'ATS_CONNECT_ACTIVE_TAB' : 'ATS_REFRESH_MARKET';
    const result = await chrome.runtime.sendMessage({ type }).catch(() => ({ ok: false }));
    await getState();
    if (fresh(lastState) && lastState.platformId === 'casatrade') {
      reconnectAttempt = 0;
      nextReconnectAt = 0;
    } else {
      reconnectAttempt = Math.min(reconnectAttempt + 1, RECONNECT_DELAYS_MS.length);
      const delay = RECONNECT_DELAYS_MS[Math.max(0, reconnectAttempt - 1)];
      nextReconnectAt = Date.now() + delay;
    }
    return result;
  } finally {
    reconnectBusy = false;
  }
}

$('activateLicense')?.addEventListener('click', async () => {
  const input = $('licenseKey');
  const button = $('activateLicense');
  const key = input?.value?.trim();
  if (!key || button?.disabled) return;

  if (button) {
    button.disabled = true;
    button.textContent = 'ATIVANDO…';
  }
  if ($('licenseText')) $('licenseText').textContent = 'Validando chave no servidor…';

  try {
    const result = await chrome.runtime.sendMessage({ type: 'ATS_ACTIVATE_LICENSE', key })
      .catch(() => ({ ok: false, error: 'backend_unreachable' }));
    const activated = !!result?.ok && licenseStillValid(result?.license);

    if (activated) {
      if (input) input.value = '';
      await getState();
      await autoConnect(true);
    } else {
      await getState();
      if ($('licenseText')) $('licenseText').textContent = licenseErrorText(result?.error);
    }
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = 'ATIVAR';
    }
  }
});

async function prepare(direction) {
  const status = $('tradeActionStatus');
  if (status) status.textContent = `Preparando ${direction === 'BUY' ? 'COMPRA' : 'VENDA'} na CasaTrade…`;
  const result = await chrome.runtime.sendMessage({ type: 'ATS_PREPARE_TRADE', direction }).catch(() => ({ ok: false }));
  if (status) status.textContent = result?.ok
    ? `${direction === 'BUY' ? 'COMPRA' : 'VENDA'} destacada na CasaTrade. Confirme manualmente.`
    : 'A entrada ainda não está confirmada para esta vela.';
}

$('prepareBuy')?.addEventListener('click', () => prepare('BUY'));
$('prepareSell')?.addEventListener('click', () => prepare('SELL'));
$('overlayToggle')?.addEventListener('change', event => saveUiPreference('overlayEnabled', event.currentTarget.checked).catch(() => {}));
$('possibleSoundToggle')?.addEventListener('change', event => saveUiPreference('possibleSoundEnabled', event.currentTarget.checked).catch(() => {}));
$('confirmSoundToggle')?.addEventListener('change', event => saveUiPreference('confirmSoundEnabled', event.currentTarget.checked).catch(() => {}));

chrome.storage.onChanged.addListener(changes => {
  if (changes[UI_PREF_KEY]) {
    uiPrefs = { ...DEFAULT_UI_PREFS, ...(changes[UI_PREF_KEY].newValue || {}) };
    syncPreferenceControls();
  }
  if (changes.scannerState || changes[LAST_VALID_LICENSE_KEY]) getState().catch(() => {});
});

(async () => {
  await loadUiPreferences();
  await getState();
  if (licenseStillValid(lastState.license)) await autoConnect(true);
  setInterval(() => getState().catch(() => {}), 500);
  setInterval(() => {
    if (licenseStillValid(lastState.license) && (!fresh(lastState) || lastState.platformId !== 'casatrade')) {
      autoConnect().catch(() => {});
    }
  }, 1000);
})();
