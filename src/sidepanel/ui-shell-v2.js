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
  const session = state.diagnostics?.marketSession || {};
  const rows = Array.isArray(state.candles) ? state.candles : [];
  return activeLicense(state)
    && state.connection === 'online'
    && !!state.asset
    && Number.isFinite(Number(state.price))
    && focus?.reliable === true
    && focus?.chartScoped === true
    && focus?.trustedChartFrame === true
    && sameMarket(focus?.asset, state.asset)
    && session.dataReady === true
    && sameMarket(session.confirmedAsset || session.asset, state.asset)
    && rows.length >= 2
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

function exactLiveTime(state = {}) {
  if (!exactClockReady(state)) return false;
  const clock = state.diagnostics?.marketClock || {};
  const expirationAt = Number(state.platformControls?.expirationCheckedAt || state.platformControls?.observed?.observedAt?.expiration || 0);
  const expirationFresh = expirationAt > 0 && Date.now() - expirationAt < CONTROLS_FRESH_MS;
  const actualExpiration = expirationFresh ? clean(state.platformControls?.observed?.expiration) : '';
  return clean(clock.timeframe || state.analysisTimeframe || state.timeframe).toUpperCase() === 'M1'
    && actualExpiration === '60s';
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
  const connected = baseHandshake(state);
  const session = state.diagnostics?.marketSession || {};
  const pendingAsset = clean(session.pendingAsset || session.asset || '');
  const switching = session.transitioning === true && !!pendingAsset;
  const platformLinked = connected || switching;
  const tradeReady = exactLiveTime(state);
  const failure = connectionFailure(state);
  const connecting = !platformLinked && !failure && activeLicense(state)
    && (state.connection === 'connecting' || state.scanner === 'scanning');

  const expirationAt = Number(state.platformControls?.expirationCheckedAt || state.platformControls?.observed?.observedAt?.expiration || 0);
  const expirationFresh = expirationAt > 0 && Date.now() - expirationAt < CONTROLS_FRESH_MS;
  const expiration = expirationFresh ? clean(state.platformControls?.observed?.expiration) : '';
  const expirationWrong = connected && !!expiration && expiration !== '60s';
  const sessionStartedAt = Number(session.startedAt || state.diagnostics?.target?.connectedAt || 0);
  const sessionAge = sessionStartedAt > 0 ? Date.now() - sessionStartedAt : 0;
  const panelAge = Math.max(0, Date.now() - PANEL_OPENED_AT);
  const expirationWaitAge = sessionAge > 0 ? Math.min(sessionAge, panelAge) : panelAge;
  const expirationReadFailed = connected && !expiration && expirationWaitAge >= 5000;

  const strip = $('syncStrip');
  if (strip) strip.className = `sync-strip ${platformLinked ? 'live' : 'syncing'}`;

  if ($('syncTitle')) {
    $('syncTitle').textContent = switching
      ? `ATUALIZANDO PARA ${pendingAsset}`
      : failure
        ? 'FALHA AO CONECTAR'
        : expirationReadFailed
          ? 'CONECTADO — FALHA NA LEITURA DA EXPIRAÇÃO'
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
    $('syncText').textContent = switching
      ? 'Dados do ativo anterior foram limpos. Confirmando preço e velas reais do novo instrumento.'
      : failure
        || (expirationReadFailed
          ? 'Não foi possível ler a expiração — verifique o seletor na CasaTrade e tente novamente.'
          : connected && expirationWrong
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
    button.classList.toggle('live', platformLinked);
    button.disabled = !activeLicense(state) || connecting || switching;
    if (!button.classList.contains('loading')) {
      $('connectScannerText').textContent = platformLinked
        ? 'CONECTADO'
        : failure
          ? 'TENTAR NOVAMENTE'
          : connecting
            ? 'CONECTANDO…'
            : 'CONECTAR';
    }
  }

  const retry = $('retryLiveRead');
  if (retry) retry.hidden = !(expirationReadFailed || failure);
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
  const response = await chrome.runtime.sendMessage({ type: 'ATS_REFRESH_TARGET_TAB' }).catch(() => null);
  if (response?.ok && response?.state) {
    lastState = response.state;
    renderShell(lastState);
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
$('retryLiveRead')?.addEventListener('click', () => connectNow().catch(() => {}));
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
