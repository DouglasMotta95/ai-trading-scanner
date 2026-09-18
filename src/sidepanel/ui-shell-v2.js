(() => {
const $ = id => document.getElementById(id);
const PREF_KEY = 'atsScannerUiPreferences';
const EXACT_CLOCK_SOURCES = new Set(['trader-dom-countdown','network-server-cycle']);
const CLOCK_FRESH_MS = 3200;
const CONTROLS_FRESH_MS = 7000;

const clean = value => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
const marketId = value => {
  const raw = clean(value).toUpperCase();
  if (!raw) return '';
  const otc = /(?:\(|\b|[_-])OTC(?:\)|\b)?/i.test(raw);
  const pair = raw.match(/\b([A-Z0-9]{2,20})\s*[\/_-]\s*([A-Z0-9]{2,12})/i);
  return pair ? `${pair[1]}/${pair[2]}${otc ? ' (OTC)' : ''}` : raw;
};
const sameMarket = (a,b) => !!marketId(a) && marketId(a) === marketId(b);

function activeLicense(state = {}) {
  const status = clean(state?.license?.status).toLowerCase();
  return ['active','valid'].includes(status)
    || state?.license?.devMode === true
    || clean(state?.license?.plan).toUpperCase() === 'OWNER_DEV'
    || state?.diagnostics?.access?.ownerDev === true
    || state?.diagnostics?.access?.state === 'owner_dev';
}

function baseHandshake(state = {}) {
  const focus = state.diagnostics?.focusedAsset || null;
  const clock = state.diagnostics?.marketClock || null;
  const controls = state.platformControls || {};
  const rows = Array.isArray(state.candles) ? state.candles : [];
  const controlsFresh = Number(controls.checkedAt || 0) > 0 && Date.now() - Number(controls.checkedAt) < CONTROLS_FRESH_MS;
  return activeLicense(state)
    && state.connection === 'online'
    && !!state.asset
    && Number.isFinite(Number(state.price))
    && focus?.reliable === true
    && focus?.chartScoped === true
    && focus?.trustedChartFrame === true
    && sameMarket(focus?.asset, state.asset)
    && clock?.verified === true
    && clock?.available !== false
    && clock?.role === 'candle-close'
    && EXACT_CLOCK_SOURCES.has(clean(clock?.source))
    && sameMarket(clock?.asset, state.asset)
    && Number(clock?.frameId) === Number(focus?.frameId)
    && clean(clock?.frameHost).toLowerCase() === clean(focus?.frameHost).toLowerCase()
    && Number(clock?.at || 0) > 0
    && Date.now() - Number(clock.at) < CLOCK_FRESH_MS
    && Number.isFinite(Number(clock?.secondsRemaining))
    && controlsFresh
    && !!clean(controls.observed?.expiration)
    && rows.length >= 2;
}

function exactLiveTime(state = {}) {
  if (!baseHandshake(state)) return false;
  const clock = state.diagnostics?.marketClock || {};
  const actualExpiration = clean(state.platformControls?.observed?.expiration);
  return clean(clock.timeframe || state.analysisTimeframe || state.timeframe).toUpperCase() === 'M1'
    && actualExpiration === '60s';
}

function connectionFailure(state = {}) {
  const stage = clean(state.diagnostics?.acquisition?.stage);
  const error = state.diagnostics?.connectionError || {};
  if (stage === 'connect_timeout' || clean(error.code) === 'handshake_timeout') {
    return clean(error.message || state.diagnostics?.acquisition?.reason || 'Falha ao conectar — tentar novamente.');
  }
  if (stage === 'runtime_injection_failed') return clean(state.diagnostics?.acquisition?.reason || 'Falha ao carregar os leitores da CasaTrade.');
  return '';
}

function setBadge(id, label, tone) {
  const el = $(id);
  if (!el) return;
  el.textContent = label;
  el.className = `badge ${tone}`;
}

function renderShell(state = {}) {
  const connected = baseHandshake(state);
  const tradeReady = exactLiveTime(state);
  const failure = connectionFailure(state);
  const connecting = !connected && !failure && activeLicense(state)
    && (state.connection === 'connecting' || state.scanner === 'scanning');
  const expiration = clean(state.platformControls?.observed?.expiration);
  const expirationWrong = connected && expiration !== '60s';

  setBadge('connectionBadge', connected ? 'CONECTADO' : 'DESCONECTADO', connected ? 'ok' : 'warn');

  const strip = $('syncStrip');
  if (strip) strip.className = `sync-strip ${connected ? 'live' : 'syncing'}`;

  if ($('syncTitle')) {
    $('syncTitle').textContent = failure
      ? 'FALHA AO CONECTAR'
      : connected && expirationWrong
        ? 'CONECTADO — AJUSTE A EXPIRAÇÃO'
        : tradeReady
          ? 'CONECTADO — PRONTO PARA ANALISAR'
          : connected
            ? 'CONECTADO — VALIDANDO ENTRADA'
            : connecting
              ? 'CONECTANDO À CASATRADE'
              : activeLicense(state)
                ? 'DESCONECTADO'
                : 'AGUARDANDO ATIVAÇÃO';
  }

  if ($('syncText')) {
    const acquisition = state.diagnostics?.acquisition || {};
    $('syncText').textContent = failure
      || (connected && expirationWrong
        ? `${state.asset} • expiração ${expiration}. ALTERE PARA 1 MIN para liberar ENTRAR.`
        : tradeReady
          ? `${state.asset} • M1 • countdown e expiração confirmados pela CasaTrade.`
          : connected
            ? `${state.asset} conectado. Dados reais recebidos; validando condições finais da entrada.`
            : connecting
              ? clean(acquisition.reason || 'Identificando ativo, preço, velas, countdown e expiração.')
              : activeLicense(state)
                ? 'Abra a CasaTrade e toque em CONECTAR.'
                : 'Ative o acesso para iniciar o scanner.');
  }

  const button = $('connectScanner');
  if (button) {
    button.classList.toggle('live', connected);
    button.disabled = !activeLicense(state) || connecting;
    if (!button.classList.contains('loading')) {
      $('connectScannerText').textContent = connected
        ? 'CONECTADO'
        : failure
          ? 'TENTAR NOVAMENTE'
          : connecting
            ? 'CONECTANDO…'
            : 'CONECTAR';
    }
  }
}

async function connectNow() {
  const button = $('connectScanner');
  if (!button || button.classList.contains('loading')) return;
  button.classList.add('loading');
  button.classList.remove('live');
  button.disabled = true;
  $('connectScannerText').textContent = 'CONECTANDO…';
  try {
    const response = await chrome.runtime.sendMessage({ type: 'ATS_CONNECT_ACTIVE_TAB' }).catch(() => null);
    renderShell(response?.state || {});
    if (!response?.ok) {
      const error = String(response?.error || 'background_no_response');
      const messages = {
        platform_not_registered: 'Abra a CasaTrade na aba ativa e tente novamente.',
        runtime_injection_failed: 'CasaTrade reconhecida, mas os leitores ao vivo não entraram na página. Recarregue a aba e tente novamente.',
        license_required: 'A licença precisa estar ativa antes de conectar.',
        background_no_response: 'O serviço da extensão não respondeu. Recarregue a extensão e a aba da CasaTrade.'
      };
      if ($('syncTitle')) $('syncTitle').textContent = 'FALHA AO CONECTAR';
      if ($('syncText')) $('syncText').textContent = messages[error] || `Falha ao conectar: ${error}`;
      setBadge('connectionBadge','DESCONECTADO','warn');
      $('connectScannerText').textContent = 'TENTAR NOVAMENTE';
    }
  } finally {
    button.classList.remove('loading');
    const state = await chrome.runtime.sendMessage({ type: 'ATS_READ_SCANNER_STATE' }).catch(() => null);
    renderShell(state?.state || {});
  }
}

function syncToggleClasses(prefs = {}) {
  const mapping = [['geminiToggle','geminiEnabled']];
  for (const [id, key] of mapping) {
    const input = $(id);
    if (!input) continue;
    input.checked = key === 'geminiEnabled' ? prefs[key] !== false : !!prefs[key];
    input.closest('.toggle-row')?.classList.toggle('active', !!input.checked);
  }
}

async function loadPrefs() {
  const stored = await chrome.storage.local.get(PREF_KEY).catch(() => ({}));
  syncToggleClasses(stored?.[PREF_KEY] || {});
}

$('geminiToggle')?.addEventListener('change', event => {
  event.currentTarget.closest('.toggle-row')?.classList.toggle('active', !!event.currentTarget.checked);
});

$('connectScanner')?.addEventListener('click', () => connectNow().catch(() => {}));
$('activateLicense')?.addEventListener('click', () => {
  const button = $('activateLicense');
  button?.classList.add('loading');
  setTimeout(() => button?.classList.remove('loading'), 7000);
});

let lastState = {};
chrome.storage.onChanged.addListener(changes => {
  if (changes.scannerState) {
    lastState = changes.scannerState.newValue || {};
    renderShell(lastState);
    if (activeLicense(lastState)) $('activateLicense')?.classList.remove('loading');
  }
  if (changes[PREF_KEY]) syncToggleClasses(changes[PREF_KEY].newValue || {});
});

// Freshness is time-based; re-render even when Chrome storage is quiet so the
// badge cannot remain CONECTADO with a stale clock.
setInterval(() => renderShell(lastState), 500);

import(chrome.runtime.getURL('src/sidepanel/trial-ui.js')).catch(() => {});

(async () => {
  await loadPrefs();
  const response = await chrome.runtime.sendMessage({ type: 'ATS_READ_SCANNER_STATE' }).catch(() => null);
  lastState = response?.state || {};
  renderShell(lastState);
})();

})();
