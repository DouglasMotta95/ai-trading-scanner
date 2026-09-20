(() => {
  const BUTTON_ID = 'copyScannerDiagnostics';
  const STATUS_ID = 'copyScannerDiagnosticsStatus';
  const PERFORMANCE_BUTTON_ID = 'copySignalPerformance';
  const CLEAR_PERFORMANCE_BUTTON_ID = 'clearSignalPerformance';
  const PERFORMANCE_KEY = 'atsSignalPerformanceLedgerV1';

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
    let button = document.getElementById(BUTTON_ID);
    if (!button) {
      const card = document.querySelector('.preferences-card');
      if (!card) return;
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:12px;padding-top:12px;border-top:1px solid rgba(255,255,255,.06)';
      button = document.createElement('button');
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
    }
    if (button.dataset.atsDiagnosticsOwner !== 'export') {
      button.dataset.atsDiagnosticsOwner = 'export';
      button.addEventListener('click', copyDiagnostics);
    }

    const performanceButton = document.getElementById(PERFORMANCE_BUTTON_ID);
    if (performanceButton && performanceButton.dataset.atsPerformanceOwner !== 'export') {
      performanceButton.dataset.atsPerformanceOwner = 'export';
      performanceButton.addEventListener('click', copyPerformanceReport);
    }
    const clearPerformanceButton = document.getElementById(CLEAR_PERFORMANCE_BUTTON_ID);
    if (clearPerformanceButton && clearPerformanceButton.dataset.atsPerformanceOwner !== 'export') {
      clearPerformanceButton.dataset.atsPerformanceOwner = 'export';
      clearPerformanceButton.addEventListener('click', clearPerformanceReport);
    }
  }

  function message(payload) {
    return new Promise(resolve => {
      let settled = false;
      const finish = response => {
        if (settled) return;
        settled = true;
        try { void chrome.runtime.lastError; } catch {}
        resolve(response ?? null);
      };
      try {
        const returned = chrome.runtime.sendMessage(payload, finish);
        if (returned && typeof returned.then === 'function') {
          returned.then(finish).catch(() => finish(null));
        }
      } catch {
        finish(null);
      }
    });
  }

  const FORBIDDEN_DIAGNOSTIC_KEY = /(?:license[_-]?key|key[_-]?license|atsclienttoken|cookies?|tokens?|headers?|authorization|bearer|secret|password)/i;

  function stripSensitive(value) {
    if (Array.isArray(value)) return value.map(stripSensitive).filter(item => item !== undefined);
    if (!value || typeof value !== 'object') {
      if (typeof value !== 'string') return value;
      const text = String(value);
      if (/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+\/-]+=*/i.test(text)) return '[redacted]';
      return text;
    }
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      if (FORBIDDEN_DIAGNOSTIC_KEY.test(key)) continue;
      out[key] = stripSensitive(child);
    }
    return out;
  }

  function sanitizeState(state = {}, manual = null) {
    const focus = state.diagnostics?.focusedAsset || {};
    const clock = state.diagnostics?.marketClock || {};
    const session = state.diagnostics?.marketSession || {};
    const acquisition = state.diagnostics?.acquisition || {};
    const access = state.diagnostics?.access || {};
    const inspector = state.diagnostics?.dataInspector || {};
    const tradeEvidence = inspector.tradeEvidence || {};
    const signal = state.signal || {};
    const account = state.accountMetrics || {};
    const quality = state.assetQuality || {};
    const runtimeInjection = state.diagnostics?.runtimeInjection || {};
    const runtimeBoot = state.diagnostics?.runtimeBoot || {};
    const probe = runtimeInjection.probe || {};
    const lastManual = manual?.metrics?.last || (Array.isArray(manual?.rows) ? manual.rows.at(-1) : null);
    const licenseStatus = clean(state.license?.status || '', 32).toLowerCase();
    const licensed = licenseStatus === 'active' || licenseStatus === 'valid';
    const marketAgeMs = age(state.lastSeen);
    const clockAgeMs = age(clock.at);
    return {
      generatedAt: new Date().toISOString(),
      extensionVersion: chrome.runtime.getManifest().version,
      access: {
        licensed,
        licenseStatus,
        licenseError: clean(state.license?.error || '', 80),
        syncPending: state.license?.syncPending === true,
        state: clean(access.state || '', 48)
      },
      platform: clean(state.platformId || state.platformName || ''),
      connection: clean(state.connection || ''),
      scanner: clean(state.scanner || ''),
      sensitivityProfile: clean(state.analystPreferences?.sensitivityLabel || state.analystPreferences?.sensitivityProfile || 'MÉDIO', 24),
      asset: clean(state.asset || focus.asset || ''),
      timeframe: clean(state.analysisTimeframe || state.timeframe || clock.timeframe || ''),
      price: num(state.price),
      lastSeenAgeMs: marketAgeMs,
      freshness: {
        marketAgeMs,
        clockAgeMs,
        marketFresh: marketAgeMs != null && marketAgeMs < 3000,
        clockFresh: clockAgeMs != null && clockAgeMs < 3000
      },
      focus: {
        asset: clean(focus.asset || ''), reliable: focus.reliable === true, chartScoped: focus.chartScoped === true,
        frameId: num(focus.frameId), source: clean(focus.source || '')
      },
      clock: {
        verified: clock.verified === true, available: clock.available !== false, role: clean(clock.role || ''),
        source: clean(clock.source || ''), secondsRemaining: num(clock.secondsRemaining), timeframe: clean(clock.timeframe || ''),
        ageMs: clockAgeMs
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

  function resultSummary(rows = []) {
    const list = Array.isArray(rows) ? rows : [];
    const wins = list.filter(row => row?.result === 'WIN').length;
    const losses = list.filter(row => row?.result === 'LOSS').length;
    const draws = list.filter(row => row?.result === 'EMPATE' || row?.result === 'DRAW').length;
    const indeterminate = list.filter(row => row?.result === 'INDETERMINADO').length;
    const decided = wins + losses;
    const winRate = decided ? wins / decided : null;
    return { total: list.length, wins, losses, draws, indeterminate, decided, winRate };
  }

  function wilson95(wins = 0, losses = 0) {
    const n = Number(wins || 0) + Number(losses || 0);
    if (!n) return null;
    const z = 1.96;
    const p = Number(wins || 0) / n;
    const z2 = z * z;
    const denominator = 1 + z2 / n;
    const center = (p + z2 / (2 * n)) / denominator;
    const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n) / denominator;
    return { low: Math.max(0, center - margin), high: Math.min(1, center + margin) };
  }

  const pct = value => value == null || !Number.isFinite(Number(value))
    ? '—'
    : `${(Number(value) * 100).toFixed(1)}%`;

  function summaryLine(label, rows = [], breakEven = null) {
    const s = resultSummary(rows);
    const ci = wilson95(s.wins, s.losses);
    const delta = s.winRate == null || breakEven == null ? null : s.winRate - breakEven;
    return `${label}: total=${s.total} | WIN=${s.wins} | LOSS=${s.losses} | EMPATE=${s.draws} | INDETERMINADO=${s.indeterminate} | taxa=${pct(s.winRate)} | IC95=${ci ? pct(ci.low) + '–' + pct(ci.high) : '—'}${delta == null ? '' : ' | diferença_vs_equilíbrio=' + (delta >= 0 ? '+' : '') + pct(delta)}`;
  }

  function groupLines(rows = [], keyFn, breakEven = null) {
    const groups = new Map();
    for (const row of rows) {
      const key = clean(keyFn(row) ?? '—', 120) || '—';
      const list = groups.get(key) || [];
      list.push(row);
      groups.set(key, list);
    }
    return [...groups.entries()]
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]), 'pt-BR', { numeric: true }))
      .map(([key, list]) => summaryLine(key, list, breakEven))
      .join('\n') || '[sem dados]';
  }

  function scoreBand(row = {}) {
    const score = num(row.score);
    if (score == null) return 'sem score';
    if (score < 58) return '<58';
    if (score <= 64) return '58-64';
    if (score <= 69) return '65-69';
    if (score <= 79) return '70-79';
    return '80+';
  }

  function secondsBand(row = {}) {
    const seconds = num(row.secondsRemaining);
    if (seconds == null) return 'sem segundos';
    if (seconds > 10) return 'acima de 10';
    if (seconds >= 8) return '10-8';
    if (seconds >= 5) return '7-5';
    if (seconds >= 0) return '4-0';
    return 'fora da janela';
  }

  function hourBand(row = {}) {
    const at = Number(row.emittedAt || 0);
    if (!(at > 0)) return 'hora desconhecida';
    return `${String(new Date(at).getHours()).padStart(2, '0')}:00`;
  }

  function performanceReport(rows = [], state = {}) {
    const safeRows = (Array.isArray(rows) ? rows : []).slice(-2000).map(row => ({
      type: row?.type === 'ENTER' ? 'ENTER' : 'POSSIBLE',
      result: ['WIN','LOSS','EMPATE','DRAW','INDETERMINADO'].includes(row?.result) ? row.result : null,
      profile: clean(row?.profile || '—', 24),
      score: num(row?.score),
      secondsRemaining: num(row?.secondsRemaining),
      direction: ['BUY','SELL'].includes(String(row?.direction || '').toUpperCase()) ? String(row.direction).toUpperCase() : '—',
      asset: clean(row?.asset || '—', 64),
      emittedAt: num(row?.emittedAt)
    }));

    const payoutRaw = num(state?.accountMetrics?.payoutPct);
    const payout = payoutRaw == null
      ? 0.88
      : Math.max(0, Math.min(2, payoutRaw > 2 ? payoutRaw / 100 : payoutRaw));
    const breakEven = 1 / (1 + payout);
    const emitted = safeRows.map(row => Number(row.emittedAt || 0)).filter(value => value > 0).sort((a,b) => a-b);
    const first = emitted[0] || null;
    const last = emitted.at(-1) || null;

    const enter = safeRows.filter(row => row.type === 'ENTER');
    const possible = safeRows.filter(row => row.type === 'POSSIBLE');

    return [
      'AI Trading Scanner — RELATÓRIO DE DESEMPENHO DOS SINAIS',
      `Gerado em: ${new Date().toISOString()}`,
      `Perfil ativo: ${clean(state.analystPreferences?.sensitivityLabel || state.analystPreferences?.sensitivityProfile || 'MÉDIO', 24)}`,
      `Payout usado: ${pct(payout)} | taxa de equilíbrio 1/(1+payout): ${pct(breakEven)}`,
      `Período coberto: ${first ? new Date(first).toISOString() : '—'} até ${last ? new Date(last).toISOString() : '—'}`,
      '',
      'TOTAIS POR TIPO',
      summaryLine('ENTER', enter, breakEven),
      summaryLine('POSSIBLE', possible, breakEven),
      '',
      'POR PERFIL',
      groupLines(safeRows, row => row.profile, breakEven),
      '',
      'POR FAIXA DE SCORE',
      groupLines(safeRows, scoreBand, breakEven),
      '',
      'POR SEGUNDOS RESTANTES NA EMISSÃO',
      groupLines(safeRows, secondsBand, breakEven),
      '',
      'POR DIREÇÃO',
      groupLines(safeRows, row => row.direction, breakEven),
      '',
      'POR ATIVO',
      groupLines(safeRows, row => row.asset, breakEven),
      '',
      'POR HORA DO DIA',
      groupLines(safeRows, hourBand, breakEven),
      '',
      'Observação: EMPATE e INDETERMINADO ficam fora do denominador da taxa de acerto.'
    ].join('\n');
  }

  async function copyPerformanceReport() {
    const button = document.getElementById(PERFORMANCE_BUTTON_ID);
    if (!button || button.dataset.busy === '1') return;
    const original = button.textContent;
    button.dataset.busy = '1';
    button.disabled = true;
    button.textContent = 'GERANDO…';
    try {
      const [stored, stateReply] = await Promise.all([
        chrome.storage.local.get(PERFORMANCE_KEY).catch(() => ({})),
        message({ type: 'ATS_READ_SCANNER_STATE' })
      ]);
      const rows = Array.isArray(stored?.[PERFORMANCE_KEY]?.rows) ? stored[PERFORMANCE_KEY].rows : [];
      const report = performanceReport(rows, stateReply?.state || {});
      const ok = await writeText(report);
      button.textContent = ok ? 'COPIADO ✓' : 'FALHA AO COPIAR';
    } catch {
      button.textContent = 'FALHA AO COPIAR';
    } finally {
      setTimeout(() => {
        button.textContent = original;
        button.disabled = false;
        delete button.dataset.busy;
      }, 2200);
    }
  }

  async function clearPerformanceReport() {
    const button = document.getElementById(CLEAR_PERFORMANCE_BUTTON_ID);
    if (!button || button.dataset.busy === '1') return;
    const confirmed = window.confirm('Limpar todo o registro de desempenho dos sinais? Esta ação não pode ser desfeita.');
    if (!confirmed) return;
    const original = button.textContent;
    button.dataset.busy = '1';
    button.disabled = true;
    try {
      await chrome.storage.local.set({ [PERFORMANCE_KEY]: { rows: [], updatedAt: Date.now() } });
      button.textContent = 'LIMPO ✓';
    } catch {
      button.textContent = 'FALHA';
    } finally {
      setTimeout(() => {
        button.textContent = original;
        button.disabled = false;
        delete button.dataset.busy;
      }, 1800);
    }
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
      const report = stripSensitive(sanitizeState(stateReply?.state || {}, manualReply?.ok ? manualReply : null));
      const text = `AI Trading Scanner — diagnóstico seguro\n${JSON.stringify(report, null, 2)}`;
      const ok = await writeText(text);
      if (status) status.textContent = ok ? 'DIAGNÓSTICO COPIADO — pode colar no chat.' : 'Não consegui copiar automaticamente.';
      if (button) button.textContent = ok ? 'COPIADO ✓' : 'FALHA AO COPIAR';
      setTimeout(() => { if (button) button.textContent = 'COPIAR DIAGNÓSTICO'; }, 2200);
    } finally {
      if (button) button.disabled = false;
    }
  }

  ensureUi();
})();
