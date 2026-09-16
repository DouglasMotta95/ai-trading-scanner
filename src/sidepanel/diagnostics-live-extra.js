(() => {
  const id = 'copyScannerDiagnostics';
  const clean = (value, max = 180) => String(value ?? '').normalize('NFKC').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  const num = value => value == null || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null;
  const age = value => Number(value) > 0 ? Math.max(0, Date.now() - Number(value)) : null;
  function send(payload) {
    return new Promise(resolve => {
      let done = false;
      const finish = value => { if (done) return; done = true; try { void chrome.runtime.lastError; } catch {} resolve(value || null); };
      try {
        const returned = chrome.runtime.sendMessage(payload, finish);
        if (returned?.then) returned.then(finish).catch(() => finish(null));
      } catch { finish(null); }
    });
  }
  function storage(keys) {
    return new Promise(resolve => {
      try { chrome.storage.local.get(keys, value => { try { void chrome.runtime.lastError; } catch {} resolve(value || {}); }); }
      catch { resolve({}); }
    });
  }
  async function copyComplete(button) {
    if (button.dataset.atsExtraBusy === '1') return;
    button.dataset.atsExtraBusy = '1';
    const status = document.getElementById('copyScannerDiagnosticsStatus');
    const original = button.textContent;
    button.textContent = 'GERANDO…';
    try {
      const [reply, local] = await Promise.all([
        send({ type: 'ATS_READ_SCANNER_STATE' }),
        storage(['atsScannerUiPreferences','atsClientToken','atsClientTokenExpiresAt'])
      ]);
      const s = reply?.state || {};
      const focus = s.diagnostics?.focusedAsset || {};
      const clock = s.diagnostics?.marketClock || {};
      const pc = s.platformControls || {};
      const ai = s.aiAudit || {};
      const marketAgeMs = age(s.lastSeen), clockAgeMs = age(clock.at);
      const ownerDev = !chrome.runtime.getManifest().update_url;
      const report = {
        generatedAt: new Date().toISOString(),
        extensionVersion: chrome.runtime.getManifest().version,
        access: {
          ownerDev,
          licensed: ownerDev || ['active','valid'].includes(String(s.license?.status || '').toLowerCase()),
          licenseStatus: clean(s.license?.status || ''), plan: clean(s.license?.plan || ''),
          accessState: clean(s.diagnostics?.access?.state || '')
        },
        platform: clean(s.platformId || s.platformName || ''), connection: clean(s.connection || ''), scanner: clean(s.scanner || ''),
        asset: clean(s.asset || ''), timeframe: clean(s.analysisTimeframe || s.timeframe || ''), price: num(s.price),
        freshness: { marketAgeMs, clockAgeMs, marketFresh: marketAgeMs != null && marketAgeMs < 3000, clockFresh: clockAgeMs != null && clockAgeMs < 3000 },
        focus: { asset: clean(focus.asset || ''), source: clean(focus.source || ''), frameId: num(focus.frameId), reliable: focus.reliable === true, trustedChartFrame: focus.trustedChartFrame === true, ageMs: age(focus.at) },
        clock: { source: clean(clock.source || ''), mode: clean(clock.mode || ''), verified: clock.verified === true, secondsRemaining: num(clock.secondsRemaining), timeframe: clean(clock.timeframe || ''), ageMs: clockAgeMs },
        platformControls: { timeframe: clean(pc.observed?.timeframe || ''), expiration: clean(pc.observed?.expiration || ''), amount: num(pc.observed?.amount), source: clean(pc.observed?.source || ''), aligned: pc.aligned === true, ageMs: age(pc.checkedAt) },
        signal: { uiState: clean(s.signal?.uiState || s.signal?.state || ''), direction: clean(s.signal?.direction || ''), score: num(s.signal?.analysisScore ?? s.signal?.score), reason: clean(s.signal?.reason || '', 260) },
        gemini: {
          enabled: s.analystPreferences?.geminiEnabled !== false,
          status: clean(ai.status || ''), stage: clean(ai.stage || ''), error: clean(ai.error || '', 100),
          verdict: clean(ai.verdict || ''), alignment: clean(ai.alignment || ''), direction: clean(ai.direction || ai.scannerDirection || ''), model: clean(ai.model || ''),
          clientTokenPresent: !!local.atsClientToken,
          clientTokenExpired: !!local.atsClientTokenExpiresAt && Number(local.atsClientTokenExpiresAt) <= Date.now(),
          ageMs: age(ai.receivedAt || ai.requestedAt)
        },
        ui: { overlayEnabled: local.atsScannerUiPreferences?.overlayEnabled === true, geminiEnabled: local.atsScannerUiPreferences?.geminiEnabled !== false },
        candlesAvailable: Array.isArray(s.candles) ? s.candles.length : 0,
        acquisition: { stage: clean(s.diagnostics?.acquisition?.stage || ''), reason: clean(s.diagnostics?.acquisition?.reason || '', 240) }
      };
      const text = `AI Trading Scanner — diagnóstico ao vivo\n${JSON.stringify(report, null, 2)}`;
      let ok = false;
      try { await navigator.clipboard.writeText(text); ok = true; } catch {}
      if (!ok) {
        const area = document.createElement('textarea'); area.value = text; area.style.cssText = 'position:fixed;left:-9999px;opacity:0';
        document.body.appendChild(area); area.select(); ok = document.execCommand('copy'); area.remove();
      }
      button.textContent = ok ? 'COPIADO ✓' : 'TENTAR NOVAMENTE';
      if (status) status.textContent = ok ? 'DIAGNÓSTICO AO VIVO COPIADO — cole no chat.' : 'Falha ao copiar.';
    } finally {
      setTimeout(() => { button.textContent = original || 'COPIAR DIAGNÓSTICO'; button.dataset.atsExtraBusy = '0'; }, 1800);
    }
  }
  document.addEventListener('click', event => {
    const button = event.target?.closest?.(`#${id}`);
    if (!button) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    copyComplete(button).catch(() => { button.dataset.atsExtraBusy = '0'; });
  }, true);
})();
