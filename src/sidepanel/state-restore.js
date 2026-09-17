(() => {
  if (globalThis.__ATS_SIDEPANEL_STATE_RESTORE__) return;
  globalThis.__ATS_SIDEPANEL_STATE_RESTORE__ = true;

  const $ = id => document.getElementById(id);
  const clean = value => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  const num = value => value == null || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null;
  const normTf = value => {
    const raw = clean(value).toUpperCase().replace(/\s+/g, '');
    const match = raw.match(/^([SMH])(\d{1,5})$/) || raw.match(/^(\d{1,4})(M|MIN)$/);
    if (!match) return null;
    if (match[1] === 'S' || match[1] === 'M' || match[1] === 'H') return `${match[1]}${Number(match[2])}`;
    return `M${Number(match[1])}`;
  };
  const normExp = value => {
    const raw = clean(value).toLowerCase().replace(/\s+/g, '');
    let match = raw.match(/^(\d{1,5})(?:s|seg|segundo|segundos)$/); if (match) return `${Number(match[1])}s`;
    match = raw.match(/^(\d{1,4})(?:m|min|minuto|minutos)$/); if (match) return `${Number(match[1]) * 60}s`;
    match = raw.match(/^(\d{1,3}):(\d{2})$/); return match ? `${Number(match[1]) * 60 + Number(match[2])}s` : null;
  };
  const expLabel = value => {
    const exp = normExp(value);
    if (!exp) return '—';
    const seconds = Number(exp.replace(/\D/g, ''));
    if (seconds % 3600 === 0) return `${seconds / 3600} h`;
    if (seconds % 60 === 0) return `${seconds / 60} min`;
    return `${seconds} s`;
  };
  const fmtPrice = value => {
    const n = num(value);
    if (n == null) return '—';
    const a = Math.abs(n);
    const digits = a >= 1000 ? 2 : a >= 100 ? 3 : a >= 1 ? 5 : 8;
    return n.toFixed(digits).replace(/0+$/, '').replace(/\.$/, '');
  };
  const setText = (id, value) => { const el = $(id); if (el) el.textContent = value; };

  function renderCached(state = {}) {
    if (!state || typeof state !== 'object') return;
    const clock = state.diagnostics?.marketClock || {};
    const timeframe = normTf(clock.timeframe || state.platformControls?.observed?.timeframe || state.analysisTimeframe || state.timeframe);
    const expiration = state.platformControls?.observed?.expiration || state.targetExpiration || state.expiration || null;
    const remaining = num(clock.secondsRemaining);
    const exactClock = clock.verified === true && clock.available !== false && ['trader-dom-countdown','network-server-cycle','structured-candle-boundary'].includes(String(clock.source || ''));

    setText('asset', state.asset || '—');
    setText('timeframe', timeframe || '—');
    setText('price', fmtPrice(state.price));
    setText('heroExpiration', expLabel(expiration));
    setText('expiration', expLabel(expiration));
    setText('heroCountdown', remaining == null ? '—' : `${exactClock ? '' : '~'}${Math.max(0, Math.ceil(remaining))}s`);
    setText('secondsRemaining', remaining == null ? '—' : `${exactClock ? '' : '~'}${Math.max(0, Math.ceil(remaining))}`);

    const license = state.license || {};
    const active = ['active','valid'].includes(String(license.status || '').toLowerCase());
    setText('licenseTitle', active ? `Licença ${license.planLabel || license.plan || 'ATIVA'}` : 'Verificando licença…');
    const health = $('licenseHealth');
    if (health && active) { health.textContent = 'ATIVA'; health.className = 'badge ok'; }
  }

  try {
    chrome.storage.local.get('scannerState', data => {
      try { void chrome.runtime.lastError; } catch {}
      renderCached(data?.scannerState || {});
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.scannerState?.newValue) renderCached(changes.scannerState.newValue);
    });
  } catch {}
})();
