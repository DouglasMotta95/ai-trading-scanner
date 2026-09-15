(() => {
  if (globalThis.__ATS_DEVICE_ANCHOR__) return;
  globalThis.__ATS_DEVICE_ANCHOR__ = true;

  const host = String(location.hostname || '').toLowerCase().replace(/\.$/, '');
  const casaHost = value => value === 'casatrade.com' || value.endsWith('.casatrade.com') || value === 'casatrade.io' || value.endsWith('.casatrade.io');
  if (!casaHost(host) || window !== window.top) return;

  const KEY = 'ats-device-anchor-v1';
  let existing = '';
  try { existing = String(localStorage.getItem(KEY) || '').trim(); } catch {}

  chrome.runtime.sendMessage({ type: 'ATS_DEVICE_ANCHOR', anchor: existing || null }).then(response => {
    const anchor = String(response?.anchor || '').trim();
    if (!anchor || anchor.length > 160) return;
    try { localStorage.setItem(KEY, anchor); } catch {}
  }).catch(() => {});
})();
