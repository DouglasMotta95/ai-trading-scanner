(() => {
  const PREF_KEY = 'atsScannerExecutionPreferences';
  const select = document.getElementById('desiredExpiration');
  const status = document.getElementById('expirationGuardStatus');
  if (!select || !status) return;

  const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
  function normExp(value = '') {
    const s = clean(value).toLowerCase().replace(/\s+/g, '');
    if (!s || s === 'auto') return null;
    let m = s.match(/^(\d{1,5})(?:s|seg|segundo|segundos)$/); if (m) return `${Number(m[1])}s`;
    m = s.match(/^(\d{1,4})(?:m|min|minuto|minutos)$/); if (m) return `${Number(m[1]) * 60}s`;
    m = s.match(/^(\d{1,3}):(\d{2})$/); return m ? `${Number(m[1]) * 60 + Number(m[2])}s` : null;
  }
  function label(value) {
    const exp = normExp(value);
    if (!exp) return 'automático';
    const n = Number(exp.replace(/\D/g, ''));
    if (n % 3600 === 0) return `${n / 3600} h`;
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

  let preferred = null;
  let latestState = null;

  function applyGuard() {
    const state = latestState || {};
    const actual = normExp(state.platformControls?.observed?.expiration || '');
    const fresh = Number(state.platformControls?.checkedAt || 0) > 0 && Date.now() - Number(state.platformControls.checkedAt) < 7000;
    const expirationEl = document.getElementById('expiration');
    if (expirationEl && actual) expirationEl.textContent = label(actual);

    if (!actual || !fresh) {
      status.className = 'expiration-guard-status warn';
      status.textContent = 'AGUARDANDO EXPIRAÇÃO REAL DA CASATRADE — entrada bloqueada.';
      return;
    }

    const differs = !!preferred && actual !== preferred;
    status.className = `expiration-guard-status ${differs ? 'info' : 'ok'}`;
    status.textContent = differs
      ? `CASATRADE AO VIVO: ${label(actual)} • preferência salva: ${label(preferred)}. O tempo ao vivo prevalece.`
      : preferred
        ? `CASATRADE AO VIVO: ${label(actual)} • igual à preferência.`
        : `CASATRADE AO VIVO: ${label(actual)} • seguindo a plataforma automaticamente.`;
  }

  async function syncPreference(value) {
    preferred = String(value || '').toUpperCase() === 'AUTO' ? null : normExp(value);
    select.value = preferred || 'AUTO';
    await storageSet({ [PREF_KEY]: { preferredExpiration: preferred } });
    await send({ type: 'ATS_SET_ANALYST_PREFERENCES', preferredExpiration: preferred });
    applyGuard();
  }

  select.addEventListener('change', () => syncPreference(select.value).catch(() => {}));
  chrome.storage.onChanged.addListener(changes => {
    if (changes.scannerState) {
      latestState = changes.scannerState.newValue || {};
      const livePref = normExp(latestState.analystPreferences?.preferredExpiration || '');
      if (livePref !== preferred && latestState.analystPreferences?.preferredExpiration !== undefined) {
        preferred = livePref;
        select.value = preferred || 'AUTO';
      }
      setTimeout(applyGuard, 0);
    }
  });

  (async () => {
    const stored = await storageGet(PREF_KEY);
    const legacy = stored?.[PREF_KEY] || {};
    const initial = legacy.preferredExpiration ?? legacy.expiration ?? null;
    await syncPreference(initial || 'AUTO');
    const reply = await send({ type: 'ATS_READ_SCANNER_STATE' });
    latestState = reply?.state || {};
    const statePref = normExp(latestState.analystPreferences?.preferredExpiration || '');
    if (latestState.analystPreferences?.preferredExpiration !== undefined) {
      preferred = statePref;
      select.value = preferred || 'AUTO';
    }
    applyGuard();
  })().catch(() => {});
})();
