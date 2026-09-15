(() => {
  const PREF_KEY = 'atsScannerExecutionPreferences';
  const DEFAULT_EXPIRATION = '60s';
  const select = document.getElementById('desiredExpiration');
  const status = document.getElementById('expirationGuardStatus');
  if (!select || !status) return;

  const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
  function normExp(value = '') {
    const s = clean(value).toLowerCase().replace(/\s+/g, '');
    let m = s.match(/^(\d{1,4})(?:s|seg|segundo|segundos)$/); if (m) return `${Number(m[1])}s`;
    m = s.match(/^(\d{1,3})(?:m|min|minuto|minutos)$/); if (m) return `${Number(m[1]) * 60}s`;
    return null;
  }
  function label(value) {
    const n = Number(String(value || '').replace(/\D/g, ''));
    if (!n) return '—';
    if (n % 60 === 0) return `${n / 60} min`;
    return `${n} s`;
  }
  const send = payload => new Promise(resolve => {
    let done = false;
    const finish = value => { if (!done) { done = true; resolve(value || null); } };
    try {
      const returned = chrome.runtime.sendMessage(payload, finish);
      if (returned && typeof returned.then === 'function') returned.then(finish).catch(() => finish(null));
    } catch { finish(null); }
  });
  const storageGet = key => new Promise(resolve => {
    try { chrome.storage.local.get(key, value => { try { void chrome.runtime.lastError; } catch {} resolve(value || {}); }); } catch { resolve({}); }
  });
  const storageSet = value => new Promise(resolve => {
    try { chrome.storage.local.set(value, () => { try { void chrome.runtime.lastError; } catch {} resolve(); }); } catch { resolve(); }
  });

  let desired = DEFAULT_EXPIRATION;
  let latestState = null;
  function applyGuard() {
    const state = latestState || {};
    const actual = normExp(state.platformControls?.observed?.expiration || '');
    const aligned = !!actual && actual === desired;
    const expirationEl = document.getElementById('expiration');
    if (expirationEl && actual) expirationEl.textContent = label(actual);

    status.className = `expiration-guard-status ${aligned ? 'ok' : actual ? 'danger' : 'warn'}`;
    status.textContent = aligned
      ? `EXPIRAÇÃO OK — CasaTrade ${label(actual)}.`
      : actual
        ? `ENTRADA BLOQUEADA — CasaTrade ${label(actual)}; ajuste para ${label(desired)}.`
        : `CONFIRMANDO EXPIRAÇÃO — alvo ${label(desired)}.`;

    const ui = String(state.signal?.uiState || '').toUpperCase();
    const actionable = ui === 'ENTER_BUY' || ui === 'ENTER_SELL' || state.signal?.state === 'CONFIRM';
    if (!actionable || aligned) return;
    const title = document.getElementById('signalTitle');
    const badge = document.getElementById('signalBadge');
    const text = document.getElementById('decisionText');
    const sub = document.getElementById('decisionSubtext');
    const reason = document.getElementById('signalReason');
    const action = document.getElementById('tradeActionStatus');
    const buy = document.getElementById('prepareBuy');
    const sell = document.getElementById('prepareSell');
    if (title) title.textContent = 'AJUSTE A EXPIRAÇÃO';
    if (badge) { badge.textContent = 'BLOQUEADO'; badge.className = 'badge warn'; }
    if (text) text.textContent = 'NÃO ENTRE AINDA';
    if (sub) sub.textContent = actual ? `A CasaTrade está em ${label(actual)} e o scanner está configurado para ${label(desired)}.` : 'A expiração real da CasaTrade ainda não foi confirmada.';
    if (reason) reason.textContent = 'A direção técnica continua registrada, mas a entrada fica bloqueada até a expiração estar alinhada.';
    if (action) action.textContent = 'Ajuste a Expiração na CasaTrade antes de executar a entrada.';
    if (buy) buy.disabled = true;
    if (sell) sell.disabled = true;
  }

  async function syncPreference(value) {
    desired = normExp(value) || DEFAULT_EXPIRATION;
    select.value = desired;
    await storageSet({ [PREF_KEY]: { expiration: desired } });
    await send({ type: 'ATS_SET_EXECUTION_PREFERENCES', expiration: desired });
    applyGuard();
  }
  select.addEventListener('change', () => syncPreference(select.value).catch(() => {}));
  chrome.storage.onChanged.addListener(changes => {
    if (changes.scannerState) {
      latestState = changes.scannerState.newValue || {};
      setTimeout(applyGuard, 0);
    }
  });

  (async () => {
    const stored = await storageGet(PREF_KEY);
    await syncPreference(stored?.[PREF_KEY]?.expiration || DEFAULT_EXPIRATION);
    const reply = await send({ type: 'ATS_READ_SCANNER_STATE' });
    latestState = reply?.state || {};
    applyGuard();
  })().catch(() => {});
})();
