(() => {
const $ = id => document.getElementById(id);
const PREF_KEY = 'atsScannerUiPreferences';
const EXACT_CLOCK_SOURCES = new Set(['trader-dom-countdown','network-server-cycle']);

function activeLicense(state = {}) {
  return ['active','valid'].includes(String(state?.license?.status || '').toLowerCase());
}

function exactLiveTime(state = {}) {
  const focus = state.diagnostics?.focusedAsset || null;
  const clock = state.diagnostics?.marketClock || null;
  const controls = state.platformControls || {};
  const actualExpiration = String(controls.observed?.expiration || '').trim();
  const controlsFresh = Number(controls.checkedAt || 0) > 0 && Date.now() - Number(controls.checkedAt) < 7000;
  return !!clock
    && focus?.reliable === true
    && focus?.trustedChartFrame === true
    && clock?.verified === true
    && clock?.available !== false
    && clock?.role === 'candle-close'
    && EXACT_CLOCK_SOURCES.has(String(clock?.source || ''))
    && Number(clock?.frameId) === Number(focus?.frameId)
    && String(clock?.frameHost || '').toLowerCase() === String(focus?.frameHost || '').toLowerCase()
    && Number(clock?.at || 0) > 0
    && Date.now() - Number(clock.at) < 3000
    && !!actualExpiration
    && controlsFresh;
}

function isLive(state = {}) {
  const focus = state.diagnostics?.focusedAsset || null;
  const session = state.diagnostics?.marketSession || null;
  return activeLicense(state)
    && state.connection === 'online'
    && !!state.asset
    && state.price != null
    && focus?.reliable === true
    && session?.asset === state.asset
    && exactLiveTime(state);
}

function renderShell(state = {}) {
  const live = isLive(state);
  const hasMarket = activeLicense(state) && state.connection === 'online' && !!state.asset && state.price != null;
  const strip = $('syncStrip');
  if (strip) strip.className = `sync-strip ${live ? 'live' : 'syncing'}`;
  if ($('syncTitle')) $('syncTitle').textContent = live
    ? 'TEMPO CASATRADE SINCRONIZADO'
    : hasMarket ? 'AGUARDAR — CONFIRMANDO TEMPO CASATRADE' : activeLicense(state) ? 'PREPARANDO LEITURA AO VIVO' : 'AGUARDANDO ATIVAÇÃO';
  if ($('syncText')) {
    const acquisition = state.diagnostics?.acquisition || {};
    const clock = state.diagnostics?.marketClock || {};
    $('syncText').textContent = live
      ? `${state.asset || 'Ativo'} • ${state.analysisTimeframe || state.timeframe || '—'} • countdown e expiração confirmados pela CasaTrade.`
      : hasMarket && clock?.operational === true && clock?.verified !== true
        ? 'Preço e velas continuam sendo lidos, mas a entrada fica bloqueada até o countdown exato da CasaTrade.'
        : acquisition.reason || (activeLicense(state) ? 'Identificando ativo, preço, histórico e relógio da vela.' : 'Ative sua licença para iniciar o scanner.');
  }
  const button = $('connectScanner');
  if (button) {
    button.classList.toggle('live', live);
    if (!button.classList.contains('loading')) $('connectScannerText').textContent = live ? 'CONECTADO' : hasMarket ? 'SINCRONIZANDO' : 'CONECTAR';
    button.disabled = !activeLicense(state) && !live;
  }
}

async function connectNow() {
  const button = $('connectScanner');
  if (!button || button.classList.contains('loading')) return;
  button.classList.add('loading');
  button.classList.remove('live');
  $('connectScannerText').textContent = 'CONECTANDO…';
  try {
    const response = await chrome.runtime.sendMessage({ type: 'ATS_CONNECT_ACTIVE_TAB' }).catch(() => null);
    renderShell(response?.state || {});
    if (!response?.ok) {
      const error = String(response?.error || 'background_no_response');
      const messages = {
        platform_not_registered: 'Abra a CasaTrade na aba ativa e clique em CONECTAR novamente.',
        runtime_injection_failed: 'CasaTrade reconhecida, mas os leitores ao vivo não entraram na página. Recarregue a aba e conecte novamente.',
        license_required: 'A licença precisa estar ativa antes de conectar.',
        background_no_response: 'O serviço da extensão não respondeu. Recarregue a extensão e a aba da CasaTrade.'
      };
      if ($('syncTitle')) $('syncTitle').textContent = 'CONEXÃO NÃO INICIADA';
      if ($('syncText')) $('syncText').textContent = messages[error] || `Falha ao conectar: ${error}`;
      $('connectScannerText').textContent = 'CONECTAR';
    }
  } finally {
    button.classList.remove('loading');
  }
}

function syncToggleClasses(prefs = {}) {
  const mapping = [
    ['overlayToggle','overlayEnabled'],
    ['possibleSoundToggle','possibleSoundEnabled'],
    ['confirmSoundToggle','confirmSoundEnabled'],
    ['geminiToggle','geminiEnabled']
  ];
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

for (const id of ['overlayToggle','possibleSoundToggle','confirmSoundToggle','geminiToggle']) {
  $(id)?.addEventListener('change', event => {
    event.currentTarget.closest('.toggle-row')?.classList.toggle('active', !!event.currentTarget.checked);
  });
}

$('connectScanner')?.addEventListener('click', () => connectNow().catch(() => {}));
$('activateLicense')?.addEventListener('click', () => {
  const button = $('activateLicense');
  button?.classList.add('loading');
  setTimeout(() => button?.classList.remove('loading'), 7000);
});

chrome.storage.onChanged.addListener(changes => {
  if (changes.scannerState) {
    renderShell(changes.scannerState.newValue || {});
    if (activeLicense(changes.scannerState.newValue || {})) $('activateLicense')?.classList.remove('loading');
  }
  if (changes[PREF_KEY]) syncToggleClasses(changes[PREF_KEY].newValue || {});
});

import(chrome.runtime.getURL('src/sidepanel/trial-ui.js')).catch(() => {});

(async () => {
  await loadPrefs();
  const response = await chrome.runtime.sendMessage({ type: 'ATS_READ_SCANNER_STATE' }).catch(() => null);
  renderShell(response?.state || {});
})();

})();
