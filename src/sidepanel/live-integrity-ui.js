(() => {
  if (globalThis.__ATS_LIVE_INTEGRITY_UI__) return;
  globalThis.__ATS_LIVE_INTEGRITY_UI__ = true;

  const $ = id => document.getElementById(id);
  const clean = value => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  const num = value => value == null || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null;

  function normAsset(value = '') {
    const raw = clean(value).toUpperCase();
    const m = raw.match(/\b([A-Z0-9]{2,20})\s*[\/_-]\s*([A-Z0-9]{2,12})/i);
    return m ? `${m[1]}/${m[2]}` : '';
  }

  const sameAsset = (a, b) => !!normAsset(a) && normAsset(a) === normAsset(b);
  const activeLicense = state => ['active','valid'].includes(String(state?.license?.status || '').toLowerCase());

  function authoritativeClockReady(state = {}) {
    const focus = state.diagnostics?.focusedAsset || null;
    const clock = state.diagnostics?.marketClock || null;
    if (!focus || !clock || !state.asset) return false;
    return focus.reliable === true
      && focus.chartScoped === true
      && focus.embeddedTrader === true
      && sameAsset(focus.asset, state.asset)
      && clock.verified === true
      && clean(clock.role) === 'candle-close'
      && clean(clock.source) === 'trader-dom-countdown'
      && sameAsset(clock.asset, state.asset)
      && Number(clock.frameId) === Number(focus.frameId)
      && clean(clock.frameHost).toLowerCase() === clean(focus.frameHost).toLowerCase()
      && Date.now() - Number(clock.at || 0) < 2200
      && num(clock.secondsRemaining) != null;
  }

  function applyGuard(state = {}) {
    if (!activeLicense(state) || state.platformId !== 'casatrade' || !state.asset || num(state.price) == null) return;
    const ready = authoritativeClockReady(state);
    const signalSeconds = num(state.signal?.secondsRemaining);
    const clockSeconds = num(state.diagnostics?.marketClock?.secondsRemaining);
    const coherentSignal = !state.signal || (ready && signalSeconds != null && signalSeconds === clockSeconds);
    if (ready && coherentSignal) return;

    if ($('connectionBadge')) {
      $('connectionBadge').textContent = 'SINCRONIZANDO VELA';
      $('connectionBadge').className = 'badge warn';
    }
    if ($('analysisTitle')) $('analysisTitle').textContent = 'SINCRONIZANDO FECHAMENTO DA VELA';
    if ($('analysisReason')) $('analysisReason').textContent = 'Cotação encontrada. Aguardando o contador real da vela do gráfico para liberar a análise.';
    if ($('secondsRemaining')) $('secondsRemaining').textContent = '—';
    if ($('signalTitle')) $('signalTitle').textContent = 'AGUARDANDO SINCRONIZAÇÃO';
    if ($('signalBadge')) {
      $('signalBadge').textContent = 'AGUARDANDO';
      $('signalBadge').className = 'badge warn';
    }
    if ($('decisionBanner')) $('decisionBanner').className = 'decision-banner waiting';
    if ($('decisionText')) $('decisionText').textContent = 'AGUARDANDO RELÓGIO DA VELA';
    if ($('decisionSubtext')) $('decisionSubtext').textContent = 'Nenhuma entrada é liberada até o ativo, a cotação e o fechamento da vela estarem sincronizados no mesmo gráfico.';
    if ($('signalReason')) $('signalReason').textContent = 'Sincronizando a decisão com o fechamento real da vela visível.';
    if ($('prepareBuy')) $('prepareBuy').disabled = true;
    if ($('prepareSell')) $('prepareSell').disabled = true;
    if ($('tradeActionStatus')) $('tradeActionStatus').textContent = 'Entrada bloqueada enquanto o relógio da vela não estiver confirmado.';
  }

  let reading = false;
  async function readState() {
    if (reading) return;
    reading = true;
    try {
      const response = await chrome.runtime.sendMessage({ type: 'ATS_READ_SCANNER_STATE' }).catch(() => null);
      applyGuard(response?.state || {});
    } finally {
      reading = false;
    }
  }

  chrome.storage.onChanged.addListener(changes => {
    if (changes.scannerState) setTimeout(readState, 0);
  });
  setInterval(readState, 350);
  readState();
})();
