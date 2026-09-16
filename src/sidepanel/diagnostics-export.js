(() => {
  const BUTTON_ID = 'copyScannerDiagnostics';
  const STATUS_ID = 'copyScannerDiagnosticsStatus';

  const num = value => value == null || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null;
  const clean = (value, max = 180) => String(value ?? '').normalize('NFKC').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  const safeList = (rows, max = 20, len = 180) => (Array.isArray(rows) ? rows : []).map(value => clean(value, len)).filter(Boolean).slice(0, max);
  const age = value => Number(value) > 0 ? Math.max(0, Date.now() - Number(value)) : null;
  const safeFrameHints = (rows, max = 16) => (Array.isArray(rows) ? rows : []).slice(0, max).map(row => ({
    protocol: clean(row?.protocol, 16),
    host: clean(row?.host, 120),
    opaque: row?.opaque === true,
    srcdoc: row?.srcdoc === true
  }));
  const safeProbeFrames = (rows, max = 20) => (Array.isArray(rows) ? rows : []).slice(0, max).map(row => ({
    frameId: num(row?.frameId),
    protocol: clean(row?.protocol, 16),
    host: clean(row?.host, 120),
    referrerHost: clean(row?.referrerHost, 120),
    isTop: row?.isTop === true,
    readyState: clean(row?.readyState, 24),
    iframeHints: safeFrameHints(row?.iframeHints)
  }));
  const safeBootRows = (rows, max = 24) => (Array.isArray(rows) ? rows : []).slice(-max).map(row => ({
    ageMs: age(row?.at),
    frameId: num(row?.frameId),
    isTop: row?.isTop === true,
    module: clean(row?.module, 64),
    phase: clean(row?.phase, 80),
    protocol: clean(row?.protocol, 16),
    host: clean(row?.host, 120),
    referrerHost: clean(row?.referrerHost, 120),
    readyState: clean(row?.readyState, 24),
    frameHints: safeFrameHints(row?.frameHints)
  }));

  function ensureUi() {
    if (document.getElementById(BUTTON_ID)) return;
    const card = document.querySelector('.preferences-card');
    if (!card) return;
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:12px;padding-top:12px;border-top:1px solid rgba(255,255,255,.06)';
    const button = document.createElement('button');
    button.id = BUTTON_ID;
    button.type = 'button';
    button.textContent = 'COPIAR DIAGNÓSTICO';
    button.style.cssText = 'border:1px solid rgba(126,222,196,.28);background:rgba(126,222,196,.08);color:#bff4e5;border-radius:10px;padding:10px 12px;font:800 11px system-ui;letter-spacing:.5px;cursor:pointer';
    const status = document.createElement('small');
    status.id = STATUS_ID;
    status.textContent = 'Sem chaves, tokens ou dados de login.';
    status.style.cssText = 'color:#718599;font:600 10px system-ui';
    row.append(button, status);
    card.appendChild(row);
    button.addEventListener('click', copyDiagnostics);
  }

  async function message(payload) {
    try { return await chrome.runtime.sendMessage(payload); } catch { return null; }
  }

  function sanitizeState(state = {}, manual = null) {
    const focus = state.diagnostics?.focusedAsset || {};
    const clock = state.diagnostics?.marketClock || {};
    const session = state.diagnostics?.marketSession || {};
    const acquisition = state.diagnostics?.acquisition || {};
    const inspector = state.diagnostics?.dataInspector || {};
    const tradeEvidence = inspector.tradeEvidence || {};
    const signal = state.signal || {};
    const account = state.accountMetrics || {};
    const quality = state.assetQuality || {};
    const runtimeInjection = state.diagnostics?.runtimeInjection || {};
    const runtimeBoot = state.diagnostics?.runtimeBoot || {};
    const probe = runtimeInjection.probe || {};
    const lastManual = manual?.metrics?.last || (Array.isArray(manual?.rows) ? manual.rows.at(-1) : null);
    return {
      generatedAt: new Date().toISOString(),
      extensionVersion: chrome.runtime.getManifest().version,
      platform: clean(state.platformId || state.platformName || ''),
      connection: clean(state.connection || ''),
      scanner: clean(state.scanner || ''),
      asset: clean(state.asset || focus.asset || ''),
      timeframe: clean(state.analysisTimeframe || state.timeframe || clock.timeframe || ''),
      price: num(state.price),
      lastSeenAgeMs: age(state.lastSeen),
      focus: {
        asset: clean(focus.asset || ''), reliable: focus.reliable === true, chartScoped: focus.chartScoped === true,
        frameId: num(focus.frameId), source: clean(focus.source || '')
      },
      clock: {
        verified: clock.verified === true, available: clock.available !== false, role: clean(clock.role || ''),
        source: clean(clock.source || ''), secondsRemaining: num(clock.secondsRemaining), timeframe: clean(clock.timeframe || ''),
        ageMs: age(clock.at)
      },
      session: {
        epoch: num(session.epoch), asset: clean(session.asset || ''), timeframe: clean(session.timeframe || ''),
        dataMode: clean(session.dataMode || ''), frameId: num(session.frameId)
      },
      acquisition: { stage: clean(acquisition.stage || ''), reason: clean(acquisition.reason || '', 240) },
      runtime: {
        injection: {
          ageMs: age(runtimeInjection.endedAt),
          durationMs: num(runtimeInjection.durationMs),
          tabId: num(runtimeInjection.tabId),
          probe: {
            ok: probe.ok === true,
            mode: clean(probe.mode, 48),
            frameCount: num(probe.frameCount),
            firstError: clean(probe.firstError, 220),
            error: clean(probe.error, 220),
            frames: safeProbeFrames(probe.frames)
          },
          isolated: {
            total: num(runtimeInjection.isolated?.total),
            ok: num(runtimeInjection.isolated?.ok),
            fallback: num(runtimeInjection.isolated?.fallback)
          },
          main: {
            total: num(runtimeInjection.main?.total),
            ok: num(runtimeInjection.main?.ok)
          },
          failures: (Array.isArray(runtimeInjection.failures) ? runtimeInjection.failures : []).slice(0, 20).map(row => ({
            file: clean(row?.file, 120),
            world: clean(row?.world, 16),
            error: clean(row?.error, 220)
          }))
        },
        boots: {
          ageMs: age(runtimeBoot.lastBootAt),
          count: num(runtimeBoot.count),
          rows: safeBootRows(runtimeBoot.boots)
        }
      },
      signal: {
        uiState: clean(signal.uiState || signal.state || ''), direction: clean(signal.direction || ''),
        score: num(signal.analysisScore ?? signal.score), setup: clean(signal.setup || ''),
        reason: clean(signal.reason || '', 260), waitingFor: signal.waitingFor && typeof signal.waitingFor === 'object' ? {
          type: clean(signal.waitingFor.type || ''), direction: clean(signal.waitingFor.direction || ''),
          level: num(signal.waitingFor.level), current: num(signal.waitingFor.current), required: num(signal.waitingFor.required)
        } : null
      },
      assetQuality: {
        label: clean(quality.label || quality.title || ''), score: num(quality.score), context: clean(quality.context || ''), bias: clean(quality.bias || '')
      },
      bankroll: {
        balance: num(account.balance), stake: num(account.stake), payoutPct: num(account.payoutPct), currency: clean(account.currency || '', 8),
        riskPct: num(account.riskPct), sessionDelta: num(account.sessionDelta), confidence: account.confidence || null
      },
      dataInspector: {
        ageMs: age(inspector.at),
        transport: clean(inspector.transports?.primary || ''),
        candidateCount: num(inspector.rawCandidateCount), candleCount: num(inspector.candleCount),
        tradeEvidence: {
          detected: tradeEvidence.detected === true,
          keys: safeList(tradeEvidence.keys, 30, 64),
          endpoints: safeList(tradeEvidence.endpoints, 12, 240)
        }
      },
      candlesAvailable: Array.isArray(state.candles) ? state.candles.length : 0,
      lastManualTrade: lastManual ? {
        asset: clean(lastManual.asset || ''), timeframe: clean(lastManual.timeframe || ''), direction: clean(lastManual.direction || ''),
        entryPrice: num(lastManual.entryPrice), exitPrice: num(lastManual.exitPrice), result: clean(lastManual.result || lastManual.status || ''),
        matchedSignal: lastManual.matchedSignal === true, resultSource: clean(lastManual.resultSource || '')
      } : null
    };
  }

  async function writeText(text) {
    if (navigator.clipboard?.writeText) {
      try { await navigator.clipboard.writeText(text); return true; } catch {}
    }
    try {
      const area = document.createElement('textarea');
      area.value = text;
      area.style.cssText = 'position:fixed;opacity:0;pointer-events:none;left:-9999px;top:-9999px';
      document.body.appendChild(area);
      area.focus(); area.select();
      const ok = document.execCommand('copy');
      area.remove();
      return !!ok;
    } catch { return false; }
  }

  async function copyDiagnostics() {
    const button = document.getElementById(BUTTON_ID);
    const status = document.getElementById(STATUS_ID);
    if (button) { button.disabled = true; button.textContent = 'GERANDO…'; }
    try {
      const [stateReply, manualReply] = await Promise.all([
        message({ type: 'ATS_READ_SCANNER_STATE' }),
        message({ type: 'ATS_GET_MANUAL_TRADE_LEDGER' })
      ]);
      const report = sanitizeState(stateReply?.state || {}, manualReply?.ok ? manualReply : null);
      const text = `AI Trading Scanner — diagnóstico seguro\n${JSON.stringify(report, null, 2)}`;
      const ok = await writeText(text);
      if (status) status.textContent = ok ? 'DIAGNÓSTICO COPIADO — pode colar no chat.' : 'Não consegui copiar automaticamente.';
      if (button) button.textContent = ok ? 'COPIADO ✓' : 'TENTAR NOVAMENTE';
      setTimeout(() => { if (button) button.textContent = 'COPIAR DIAGNÓSTICO'; }, 2200);
    } finally {
      if (button) button.disabled = false;
    }
  }

  ensureUi();
})();
