(() => {
  if (globalThis.__ATS_DEVICE_ANCHOR__) return;
  globalThis.__ATS_DEVICE_ANCHOR__ = true;

  const host = String(location.hostname || '').toLowerCase().replace(/\.$/, '');
  const casaHost = value => value === 'casatrade.com' || value.endsWith('.casatrade.com') || value === 'casatrade.io' || value.endsWith('.casatrade.io') || value === 'casatraders.online' || value.endsWith('.casatraders.online') || value === 'ivcasatraders.online' || value.endsWith('.ivcasatraders.online');
  if (!casaHost(host) || window !== window.top) return;

  const KEY = 'ats-device-anchor-v1';
  let existing = '';
  try { existing = String(localStorage.getItem(KEY) || '').trim(); } catch {}

  const sendRuntimeMessage = message => {
    if (typeof globalThis.__ATS_SEND_MESSAGE__ === 'function') {
      return globalThis.__ATS_SEND_MESSAGE__(message);
    }

    return new Promise(resolve => {
      let settled = false;
      const finish = response => {
        if (settled) return;
        settled = true;
        try { void chrome.runtime.lastError; } catch {}
        resolve(response ?? null);
      };

      try {
        const returned = chrome.runtime.sendMessage(message, finish);
        if (returned && typeof returned.then === 'function') {
          returned.then(finish).catch(() => finish(null));
        }
      } catch {
        finish(null);
      }
    });
  };

  sendRuntimeMessage({ type: 'ATS_DEVICE_ANCHOR', anchor: existing || null }).then(response => {
    const anchor = String(response?.anchor || '').trim();
    if (!anchor || anchor.length > 160) return;
    try { localStorage.setItem(KEY, anchor); } catch {}
  }).catch(() => {});
})();
