(() => {
const $ = id => document.getElementById(id);
const PREF_KEY = 'atsScannerUiPreferences';
const EXACT_CLOCK_SOURCES = new Set(['trader-dom-countdown','network-server-cycle']);
const CLOCK_FRESH_MS = 3200;
const CONTROLS_FRESH_MS = 7000;
const PANEL_OPENED_AT = Date.now();

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
  return activeLicense(state)
    && state.connection === 'online'
    && !!state.asset
    && Number.isFinite(Number(state.price))
    && focus?.reliable === true
    && focus?.chartScoped === true
    && focus?.trustedChartFrame === true
    && sameMarket(focus?.asset, state.asset)
    && Number(state.lastSeen || 0) > 0
    && Date.now() - Number(state.lastSeen) < 7000;
}

function exactClockReady(state = {}) {
  if (!baseHandshake(state)) return false;
  const focus = state.diagnostics?.focusedAsset || null;
  const clock = state.diagnostics?.marketClock || null;
  return clock?.verified === true
    && clock?.available !== false
    && clock?.role === 'candle-close'
    && EXACT_CLOCK_SOURCES.has(clean(clock?.source))
    && sameMarket(clock?.asset, state.asset)
    && Number(clock?.frameId) === Number(focus?.frameId)
    && clean(clock?.frameHost).toLowerCase() === clean(focus?.frameHost).toLowerCase()
    && Number(clock?.at || 0) > 0
    && Date.now() - Number(clock.at) < CLOCK_FRESH_MS
    && Number.isFinite(Number(clock?.secondsRemaining));
}

function confirmedExpiration(state = {}) {
  const value = clean(
    state.platformControls?.observed?.expiration
    || state.diagnostics?.expirationGuard?.actual
    || state.targetExpiration
    || state.expiration
    || ''
  );
  const at = Number(
    state.platformControls?.observed?.observedAt?.expiration
    || state.platformControls?.expirationCheckedAt
    || (state.diagnostics?.expirationGuard?.source === 'background-direct-expiration-probe' ? state.diagnostics.expirationGuard.at : 0)
    || 0
  );
  return { value, at, confirmed: !!value && at > 0 };
}

function exactLiveTime(state = {}) {
  if (!exactClockReady(state)) return false;
  const clock = state.diagnostics?.marketClock || {};
  const expiration = confirmedExpiration(state);
  const tf = clean(state.analystPreferences?.operatingTimeframe || clock.timeframe || state.analysisTimeframe || state.timeframe).toUpperCase();
  const required = tf === 'M5' ? '300s' : '60s';
  return ['M1','M5'].includes(tf)
    && clean(clock.timeframe || state.analysisTimeframe || state.timeframe).toUpperCase() === tf
    && expiration.confirmed
    && expiration.value === required;
}

function finalWindowSeconds(state = {}) {
  return clean(state.analystPreferences?.operatingTimeframe || state.analysisTimeframe || state.timeframe).toUpperCase() === 'M5' ? 20 : 10;
}

function connectionFailure(state = {}) {
  if (baseHandshake(state)) return '';
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
  const session = state.diagnostics?.marketSession || {};
  const pendingAsset = clean(session.pendingAsset || session.asset || '');
  const switching = session.transitioning === true && !!pendingAsset;
  const dataConnected = baseHandshake(state);
  const connected = dataConnected || switching;
  const platformLinked = connected;
  const failure = connectionFailure(state);
  const connecting = !platformLinked && !failure && activeLicense(state)
    && (state.connection === 'connecting' || state.scanner === 'scanning');

  const strip = $('syncStrip');
  if (strip) strip.className = `sync-strip ${platformLinked ? 'live' : 'syncing'}`;

  if ($('syncTitle')) {
    $('syncTitle').textContent = switching
      ? `ATUALIZANDO PARA ${pendingAsset}`
      : failure
        ? 'FALHA AO CONECTAR'
        : connected
          ? 'CONECTADO — ANALISANDO SINAL'
          : connecting
            ? 'CONECTANDO À CASATRADE'
            : activeLicense(state)
              ? 'DESCONECTADO'
              : 'AGUARDANDO ATIVAÇÃO';
  }

  if ($('syncText')) {
    const acquisition = state.diagnostics?.acquisition || {};
    $('syncText').textContent = switching
      ? 'Limpando o ativo anterior e confirmando o gráfico que está aberto agora.'
      : failure
        || (connected
          ? `${state.asset || pendingAsset || 'CasaTrade'} conectado. Procurando POSSÍVEL COMPRA/VENDA; entrada final perto dos ${finalWindowSeconds(state)}s.`
          : connecting
            ? clean(acquisition.reason || 'Identificando ativo, preço e velas do gráfico atual.')
            : activeLicense(state)
              ? 'Abra a CasaTrade e toque em CONECTAR.'
              : 'Ative o acesso para iniciar o scanner.');
  }

  const button = $('connectScanner');
  if (button) {
    button.classList.toggle('live', platformLinked);
    button.disabled = !activeLicense(state) || connecting || switching;
    if (!button.classList.contains('loading')) {
      $('connectScannerText').textContent = connected ? 'CONECTADO' : 'DESCONECTADO';
    }
  }

  const retry = $('retryLiveRead');
  if (retry) retry.hidden = !failure;
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

async function refreshLiveReaders() {
  const retry = $('retryLiveRead');
  if (retry) {
    retry.disabled = true;
    retry.textContent = 'RELENDO…';
  }
  try {
    const response = await chrome.runtime.sendMessage({ type: 'ATS_REFRESH_TARGET_TAB' }).catch(() => null);
    if (response?.ok && response?.state) {
      lastState = response.state;
      renderShell(lastState);
    }
  } finally {
    if (retry) {
      retry.disabled = false;
      retry.textContent = 'TENTAR NOVAMENTE';
    }
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
$('retryLiveRead')?.addEventListener('click', () => refreshLiveReaders().catch(() => {}));
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
  const targetHost = clean(lastState.diagnostics?.target?.host).toLowerCase();
  const looksLikeCasaTrade = lastState.platformId === 'casatrade'
    || /(^|\.)casatrade\.(?:com|io)$/.test(targetHost)
    || /(^|\.)casatraders\.online$/.test(targetHost)
    || /(^|\.)ivcasatraders\.online$/.test(targetHost);
  if (activeLicense(lastState) && looksLikeCasaTrade) refreshLiveReaders().catch(() => {});
})();

})();
