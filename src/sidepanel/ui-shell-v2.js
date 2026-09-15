const $ = id => document.getElementById(id);
const PREF_KEY = 'atsScannerUiPreferences';

function activeLicense(state = {}) {
  return ['active','valid'].includes(String(state?.license?.status || '').toLowerCase());
}

function isLive(state = {}) {
  const focus = state.diagnostics?.focusedAsset || null;
  const clock = state.diagnostics?.marketClock || null;
  const session = state.diagnostics?.marketSession || null;
  return activeLicense(state)
    && state.connection === 'online'
    && !!state.asset
    && state.price != null
    && focus?.reliable === true
    && clock?.verified === true
    && session?.asset === state.asset;
}

function renderShell(state = {}) {
  const live = isLive(state);
  const strip = $('syncStrip');
  if (strip) strip.className = `sync-strip ${live ? 'live' : 'syncing'}`;
  if ($('syncTitle')) $('syncTitle').textContent = live ? 'LEITURA AO VIVO SINCRONIZADA' : activeLicense(state) ? 'PREPARANDO LEITURA AO VIVO' : 'AGUARDANDO ATIVAÇÃO';
  if ($('syncText')) {
    const acquisition = state.diagnostics?.acquisition || {};
    $('syncText').textContent = live
      ? `${state.asset || 'Ativo'} • ${state.analysisTimeframe || state.timeframe || '—'} • acompanhando a vela atual.`
      : acquisition.reason || (activeLicense(state) ? 'Identificando ativo, preço, histórico e relógio da vela.' : 'Ative sua licença para iniciar o scanner.');
  }
  const button = $('connectScanner');
  if (button) {
    button.classList.toggle('live', live);
    if (!button.classList.contains('loading')) $('connectScannerText').textContent = live ? 'CONECTADO' : 'CONECTAR';
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
  } finally {
    button.classList.remove('loading');
  }
}

function syncToggleClasses(prefs = {}) {
  const mapping = [
    ['overlayToggle','overlayEnabled'],
    ['possibleSoundToggle','possibleSoundEnabled'],
    ['confirmSoundToggle','confirmSoundEnabled']
  ];
  for (const [id, key] of mapping) {
    const input = $(id);
    if (!input) continue;
    input.checked = !!prefs[key];
    input.closest('.toggle-row')?.classList.toggle('active', !!prefs[key]);
  }
}

async function loadPrefs() {
  const stored = await chrome.storage.local.get(PREF_KEY).catch(() => ({}));
  syncToggleClasses(stored?.[PREF_KEY] || {});
}

for (const id of ['overlayToggle','possibleSoundToggle','confirmSoundToggle']) {
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

// Secondary UI modules are loaded from this single shell so the sidepanel keeps
// one explicit HTML surface while optional cards can evolve independently.
import(chrome.runtime.getURL('src/sidepanel/manual-trade-ui.js')).catch(() => {});
import(chrome.runtime.getURL('src/sidepanel/trial-ui.js')).catch(() => {});

(async () => {
  await loadPrefs();
  const response = await chrome.runtime.sendMessage({ type: 'ATS_READ_SCANNER_STATE' }).catch(() => null);
  renderShell(response?.state || {});
})();
