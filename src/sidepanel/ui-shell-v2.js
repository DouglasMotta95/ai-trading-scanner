(() => {
const $ = id => document.getElementById(id);
const PREF_KEY = 'atsScannerUiPreferences';
const EXACT_CLOCK_SOURCES = new Set(['trader-dom-countdown','network-server-cycle']);
const CLOCK_FRESH_MS = 3200;
const CONTROLS_FRESH_MS = 7000;
const PANEL_OPENED_AT = Date.now();

const clean = value => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
const marketId = value => {
  const raw = clean(value).toUpperCase();
  if (!raw) return '';
  const otc = /(?:\(|\b|[_-])OTC(?:\)|\b)?/i.test(raw);
  const pair = raw.match(/\b([A-Z0-9]{2,20})\s*[\/_-]\s*([A-Z0-9]{2,12})/i);
  return pair ? `${pair[1]}/${pair[2]}${otc ? ' (OTC)' : ''}` : raw;
};
const sameMarket = (a,b) => !!marketId(a) && marketId(a) === marketId(b);

function activeLicense(state = {}) {
  const status = clean(state?.license?.status).toLowerCase();
  return ['active','valid'].includes(status)
    || state?.license?.devMode === true
    || clean(state?.license?.plan).toUpperCase() === 'OWNER_DEV'
    || state?.diagnostics?.access?.ownerDev === true
    || state?.diagnostics?.access?.state === 'owner_dev';
}

function baseHandshake(state = {}) {
  const focus = state.diagnostics?.focusedAsset || null;
  return activeLicense(state)
    && state.connection === 'online'
    && !!state.asset
    && Number.isFinite(Number(state.price))
    && focus?.reliable === true
    && focus?.chartScoped === true
    && focus?.trustedChartFrame === true
    && sameMarket(focus?.asset, state.asset)
    && Number(state.lastSeen || 0) > 0
    && Date.now() - Number(state.lastSeen) < 7000;
}

function clockBoundToFocus(clock = {}, focus = {}) {
  const sameFrame = Number(clock?.frameId) === Number(focus?.frameId)
    && clean(clock?.frameHost).toLowerCase() === clean(focus?.frameHost).toLowerCase();
  const boundControlFrame = clock?.crossFrameControl === true
    && Number(clock?.boundFocusFrameId) === Number(focus?.frameId)
    && clean(clock?.boundFocusFrameHost).toLowerCase() === clean(focus?.frameHost).toLowerCase();
  return sameFrame || boundControlFrame;
}

function exactClockReady(state = {}) {
  if (!baseHandshake(state)) return false;
  const focus = state.diagnostics?.focusedAsset || null;
  const clock = state.diagnostics?.marketClock || null;
  return clock?.verified === true
    && clock?.available !== false
    && clock?.role === 'candle-close'
    && EXACT_CLOCK_SOURCES.has(clean(clock?.source))
    && sameMarket(clock?.asset, state.asset)
    && clockBoundToFocus(clock, focus)
    && Number(clock?.at || 0) > 0
    && Date.now() - Number(clock.at) < CLOCK_FRESH_MS
    && Number.isFinite(Number(clock?.secondsRemaining));
}

function exactLiveTime(state = {}) {
  if (!exactClockReady(state)) return false;
  const clock = state.diagnostics?.marketClock || {};
  const expirationAt = Number(state.platformControls?.expirationCheckedAt || state.platformControls?.observed?.observedAt?.expiration || 0);
  const expirationFresh = expirationAt > 0 && Date.now() - expirationAt < CONTROLS_FRESH_MS;
  const actualExpiration = expirationFresh ? clean(state.platformControls?.observed?.expiration) : '';
  return clean(clock.timeframe || state.analysisTimeframe || state.timeframe).toUpperCase() === 'M1'
    && actualExpiration === '60s';
}

function connectionFailure(state = {}) {
  if (baseHandshake(state)) return '';
  const stage = clean(state.diagnostics?.acquisition?.stage);
  const error = state.diagnostics?.connectionError || {};
  if (stage === 'connect_timeout' || clean(error.code) === 'handshake_timeout') {
    return clean(error.message || state.diagnostics?.acquisition?.reason || 'Falha ao conectar — tentar novamente.');
  }
  if (stage === 'runtime_injection_failed') return clean(state.diagnostics?.acquisition?.reason || 'Falha ao carregar os leitores da CasaTrade.');
  return '';
}

function setBadge(id, label, tone) {
  const el = $(id);
  if (!el) return;
  el.textContent = label;
  el.className = `badge ${tone}`;
}

function renderShell(state = {}) {
  const session = state.diagnostics?.marketSession || {};
  const pendingAsset = clean(session.pendingAsset || session.asset || '');
  const switching = session.transitioning === true && !!pendingAsset;
  const dataConnected = baseHandshake(state);
  const connected = dataConnected || switching;
  const platformLinked = connected;
  const tradeReady = exactLiveTime(state);
  const failure = connectionFailure(state);
  const connecting = !platformLinked && !failure && activeLicense(state)
    && (state.connection === 'connecting' || state.scanner === 'scanning');

  const expirationAt = Number(state.platformControls?.expirationCheckedAt || state.platformControls?.observed?.observedAt?.expiration || 0);
  const expirationFresh = expirationAt > 0 && Date.now() - expirationAt < CONTROLS_FRESH_MS;
  const expiration = expirationFresh ? clean(state.platformControls?.observed?.expiration) : '';
  const expirationWrong = dataConnected && !!expiration && expiration !== '60s';
  const sessionStartedAt = Number(session.startedAt || state.diagnostics?.target?.connectedAt || 0);
  const sessionAge = sessionStartedAt > 0 ? Date.now() - sessionStartedAt : 0;
  const panelAge = Math.max(0, Date.now() - PANEL_OPENED_AT);
  const expirationWaitAge = sessionAge > 0 ? Math.min(sessionAge, panelAge) : panelAge;
  const expirationPending = dataConnected && !expiration && expirationWaitAge >= 1500;
  const marketPending = !dataConnected
    && !switching
    && activeLicense(state)
    && !!state.targetTabId
    && state.scanner === 'scanning'
    && expirationWaitAge >= 4000;

  const strip = $('syncStrip');
  if (strip) strip.className = `sync-strip ${platformLinked ? 'live' : 'syncing'}`;

  if ($('syncTitle')) {
    $('syncTitle').textContent = switching
      ? `ATUALIZANDO PARA ${pendingAsset}`
      : failure
        ? 'FALHA AO CONECTAR'
        : marketPending
          ? 'CASATRADE VINCULADA — LEITURA PENDENTE'
          : expirationPending
            ? 'CONECTADO — EXPIRAÇÃO PENDENTE'
            : connected && expirationWrong
            ? 'CONECTADO — AJUSTE A EXPIRAÇÃO'
            : tradeReady
              ? 'CONECTADO — PRONTO PARA ANALISAR'
              : connected
                ? 'CONECTADO — VALIDANDO ENTRADA'
                : connecting
                  ? 'CONECTANDO À CASATRADE'
                  : activeLicense(state)
                    ? 'DESCONECTADO'
                    : 'AGUARDANDO ATIVAÇÃO';
  }

  if ($('syncText')) {
    const acquisition = state.diagnostics?.acquisition || {};
    $('syncText').textContent = switching
      ? 'Dados do ativo anterior foram limpos. Confirmando preço e velas reais do novo instrumento.'
      : failure
        || (marketPending
          ? 'Os leitores ainda não confirmaram ativo, preço e velas. Toque em TENTAR NOVAMENTE para reinjetar sem recarregar a CasaTrade.'
          : expirationPending
            ? 'EXPIRAÇÃO PENDENTE — não foi possível confirmar o valor real; toque em TENTAR NOVAMENTE.'
            : connected && expirationWrong
            ? 'Ajuste a expiração da CasaTrade para 1 minuto.'
            : tradeReady
              ? `${state.asset} • M1 • countdown e expiração confirmados pela CasaTrade.`
              : connected
                ? `${state.asset} conectado. Dados reais recebidos; validando condições finais da entrada.`
                : connecting
                  ? clean(acquisition.reason || 'Identificando ativo, preço, velas, countdown e expiração.')
                  : activeLicense(state)
                    ? 'Abra a CasaTrade e toque em CONECTAR.'
                    : 'Ative o acesso para iniciar o scanner.');
  }

  const button = $('connectScanner');
  if (button) {
    button.classList.toggle('live', platformLinked);
    button.disabled = !activeLicense(state) || connecting || switching;
    if (!button.classList.contains('loading')) {
      $('connectScannerText').textContent = connected ? 'CONECTADO' : 'DESCONECTADO';
    }
  }

  const retry = $('retryLiveRead');
  // Expiration recovery is automatic now. Keep the manual retry only for a
  // genuine market-acquisition or connection failure.
  if (retry) retry.hidden = !(marketPending || failure);

  const expirationDiagnostic = $('copyExpirationDiagnostic');
  if (expirationDiagnostic) expirationDiagnostic.hidden = !expirationPending;
}
async function connectNow() {
  const button = $('connectScanner');
  if (!button || button.classList.contains('loading')) return;
  button.classList.add('loading');
  button.classList.remove('live');
  button.disabled = true;
  $('connectScannerText').textContent = 'CONECTANDO…';
  try {
    const response = await chrome.runtime.sendMessage({ type: 'ATS_CONNECT_ACTIVE_TAB' }).catch(() => null);
    renderShell(response?.state || {});
    if (!response?.ok) {
      const error = String(response?.error || 'background_no_response');
      const messages = {
        platform_not_registered: 'Abra a CasaTrade na aba ativa e tente novamente.',
        runtime_injection_failed: 'CasaTrade reconhecida, mas os leitores ao vivo não responderam. Toque em TENTAR NOVAMENTE; se persistir, recarregue a aba.',
        license_required: 'A licença precisa estar ativa antes de conectar.',
        background_no_response: 'O serviço da extensão não respondeu. Recarregue a extensão e a aba da CasaTrade.'
      };
      if ($('syncTitle')) $('syncTitle').textContent = 'FALHA AO CONECTAR';
      if ($('syncText')) $('syncText').textContent = messages[error] || `Falha ao conectar: ${error}`;
      setBadge('connectionBadge','DESCONECTADO','warn');
      $('connectScannerText').textContent = 'TENTAR NOVAMENTE';
    }
  } finally {
    button.classList.remove('loading');
    const state = await chrome.runtime.sendMessage({ type: 'ATS_READ_SCANNER_STATE' }).catch(() => null);
    renderShell(state?.state || {});
  }
}

async function refreshLiveReaders() {
  const response = await chrome.runtime.sendMessage({ type: 'ATS_REFRESH_TARGET_TAB' }).catch(() => null);
  if (response?.ok && response?.state) {
    lastState = response.state;
    renderShell(lastState);
  }
}

function expirationDiagnosticText(response = {}) {
  const row = response.best || response.frames?.[0] || {};
  const attempts = Array.isArray(row.selectorAttempts) ? row.selectorAttempts : [];
  const selectorLines = attempts.length
    ? attempts.map(item => {
        const found = Number(item.found || 0);
        const visible = Number(item.visible || 0);
        const matches = item.expirationTextMatches == null ? '' : ` | texto-expiração=${Number(item.expirationTextMatches || 0)}`;
        return `- ${item.selector || '—'} | encontrados=${found} | visíveis=${visible}${matches} | motivo=${item.reason || '—'}`;
      }).join('\n')
    : '- Nenhum seletor pôde ser registrado.';

  const targetTab = response.targetTab || {};
  const casaTradeTabs = Array.isArray(response.casaTradeTabs) ? response.casaTradeTabs : [];
  const allFrames = Array.isArray(response.frames) ? response.frames : [];
  const executeErrors = Array.isArray(response.executeScriptErrors) ? response.executeScriptErrors : [];

  const tabLine = response.targetTab
    ? `id=${targetTab.id ?? '—'} | url=${targetTab.url || '—'} | active=${targetTab.active === true} | discarded=${targetTab.discarded === true} | status=${targetTab.status || '—'} | windowId=${targetTab.windowId ?? '—'}`
    : `[aba alvo indisponível]${response.targetTabError ? ` erro=${response.targetTabError}` : ''}`;

  const casaTabLines = casaTradeTabs.length
    ? casaTradeTabs.map(tab =>
        `- id=${tab.id ?? '—'} | url=${tab.url || '—'} | active=${tab.active === true} | discarded=${tab.discarded === true} | windowId=${tab.windowId ?? '—'}`
      ).join('\n')
    : '- Nenhuma aba com host contendo "casatrade" foi retornada.';

  const frameLines = allFrames.length
    ? allFrames.map(frame => {
        const words = frame.wordPresence || {};
        const ctx = frame.documentContext || {};
        const iframes = Array.isArray(ctx.iframes) ? ctx.iframes : [];
        const iframeLines = iframes.length
          ? iframes.map((item, index) =>
              `    iframe[${index}] src=${item.src || '[vazio]'} | sandbox=${item.sandbox || '[vazio]'} | id=${item.id || '[vazio]'} | class=${item.className || '[vazio]'} | size=${Number(item.width || 0)}x${Number(item.height || 0)} | contentDocumentAcessível=${item.contentDocumentAccessible === true}`
            ).join('\n')
          : '    [nenhum iframe neste documento]';

        return [
          `- frameId=${frame.frameId ?? '—'} | href=${frame.href || '—'} | isTop=${frame.isTop === true} | visibilityState=${frame.visibilityState || '—'} | title=${frame.title || '—'} | body.innerText.length=${Number(frame.bodyInnerTextLength || 0)}`,
          `  palavras: expira=${words.expira === true} | valor=${words.valor === true} | comprar=${words.comprar === true} | vender=${words.vender === true} | lucro=${words.lucro === true}`,
          `  documento: iframes=${Number(ctx.iframeCount || 0)} | shadowRoot_aberto=${Number(ctx.openShadowRootCount || 0)} | canvas=${Number(ctx.canvasCount || 0)}`,
          iframeLines
        ].join('\n');
      }).join('\n')
    : '- Nenhum frame retornado pelo executeScript.';

  const errorLines = executeErrors.length
    ? executeErrors.map(error => `- ${error}`).join('\n')
    : '- Nenhum erro literal de executeScript registrado.';

  const canvasLines = allFrames.length
    ? allFrames.map(frame => {
        const canvas = frame.canvasDiagnostic || null;
        const bridge = frame.embeddedFeedDiagnostic || null;
        const canvasFrame = canvas?.frame || {};
        const intercepted = canvas?.intercepted || {};
        const texts = Array.isArray(canvas?.recentCanvasText) ? canvas.recentCanvasText.slice(0, 40) : [];
        const textLines = texts.length
          ? texts.map((item, index) =>
              `    [${index + 1}] idade=${Number(item.ageMs || 0)}ms | ${item.text || '[vazio]'}`
            ).join('\n')
          : '    [nenhum texto em recentCanvasText]';
        const published = canvas?.publishRenderedControls || {};
        const lastPayload = published.lastPayload || null;

        return [
          `FRAME executeScript=${frame.frameId ?? '—'}`,
          'A) HOOK',
          canvas
            ? `  instalado=${canvas.hookInstalled === true ? 'sim' : 'não'} | frameId=${canvasFrame.frameId || '—'} | href=${canvasFrame.href || frame.href || '—'} | top=${canvasFrame.isTop === true ? 'sim' : 'não'} | contextos=${Array.isArray(canvas.hookedContexts) && canvas.hookedContexts.length ? canvas.hookedContexts.join(',') : '—'}`
            : `  snapshot indisponível | erro=${frame.canvasDiagnosticError || '—'}`,
          canvas
            ? `  interceptadas total=${Number(intercepted.total || 0)} | fillText=${Number(intercepted.fillText || 0)} | strokeText=${Number(intercepted.strokeText || 0)} | últimos 6s=${Number(intercepted.last6s || 0)}`
            : '',
          'B) recentCanvasText — até 40 textos distintos',
          textLines,
          'C) PARSERS NO TEXTO CONCATENADO',
          canvas
            ? `  tamanho=${Number(canvas.concatenatedTextLength || 0)} | expirationFrom=${canvas.expirationFrom || 'null'} | timeframeFrom=${canvas.timeframeFrom || 'null'}`
            : '  snapshot indisponível',
          'D) publishRenderedControls()',
          canvas
            ? `  envios com expiração=${Number(published.expirationSendCount || 0)} | último=${lastPayload ? `expiration=${lastPayload.expiration || 'null'} confidence=${Number(lastPayload.confidence || 0)} sourceKey=${lastPayload.sourceKey || '—'} idade=${Number(lastPayload.ageMs || 0)}ms` : '[nenhum]'}`
            : '  snapshot indisponível',
          'E) THROTTLE 80ms — embedded-feed-bridge',
          bridge
            ? `  mensagens ATS_NETWORK_PROBE com controls.expiration descartadas=${Number(bridge.expirationThrottle80msDropCount || 0)}`
            : `  snapshot indisponível | erro=${frame.embeddedFeedDiagnosticError || '—'}`
        ].filter(Boolean).join('\n');
      }).join('\n\n')
    : '- Nenhum frame disponível para diagnóstico de canvas.';

  return [
    'AI Trading Scanner — diagnóstico de leitura de expiração',
    `Frames examinados: ${Number(response.frameCount || response.frames?.length || 0)}`,
    `Frame selecionado: ${row.frameId ?? '—'} | host=${row.host || '—'} | top=${row.isTop === true ? 'sim' : 'não'}`,
    `Seletor selecionado: ${row.selectedSelector || 'nenhum'}`,
    `Falha final: ${row.failureReason || response.error || '—'}`,
    '',
    '1. OUTERHTML DO CONTAINER (~3000 caracteres no máximo)',
    row.containerOuterHTML || '[não localizado]',
    '',
    '2. TEXTO CRU ENCONTRADO NO CAMPO',
    row.rawText || '[nenhum texto cru localizado]',
    '',
    '3. SELETORES TENTADOS E MOTIVO DA FALHA',
    selectorLines,
    '',
    '4. CONTEXTO DA PÁGINA',
    '',
    'A) ABA ALVO',
    tabLine,
    '',
    'TODAS AS ABAS COM HOST CONTENDO "casatrade"',
    casaTabLines,
    '',
    'B) FRAMES RETORNADOS PELO executeScript',
    `Frames retornados=${Number(response.frameCount || allFrames.length)} | esperado no mínimo=${Number(response.expectedFrameCountAtLeast || 0)}`,
    frameLines,
    '',
    'C) IFRAMES / SHADOW DOM / CANVAS',
    'Os detalhes de cada documento estão listados junto de cada frame acima.',
    '',
    'D) ERROS LITERAIS DO executeScript / FRAMES AUSENTES',
    errorLines,
    '',
    '5. CANVAS',
    canvasLines
  ].join('\n');
}

async function copyExpirationDiagnostic() {
  const button = $('copyExpirationDiagnostic');
  if (!button || button.dataset.busy === '1') return;
  button.dataset.busy = '1';
  button.disabled = true;
  const original = button.textContent;
  button.textContent = 'Coletando…';
  try {
    const response = await chrome.runtime.sendMessage({ type: 'ATS_GET_EXPIRATION_DIAGNOSTIC' }).catch(error => ({
      ok: false,
      error: String(error?.message || error || 'background_no_response'),
      frames: []
    }));
    const text = expirationDiagnosticText(response || {});
    let copied = false;
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
    } catch {}
    if (!copied) {
      try {
        const area = document.createElement('textarea');
        area.value = text;
        area.setAttribute('readonly', '');
        area.style.cssText = 'position:fixed;left:-9999px;top:0';
        document.body.append(area);
        area.select();
        copied = document.execCommand('copy');
        area.remove();
      } catch {}
    }
    button.textContent = copied ? 'Diagnóstico copiado' : 'Falha ao copiar';
    setTimeout(() => {
      button.textContent = original;
      button.disabled = false;
      delete button.dataset.busy;
    }, 1800);
  } catch {
    button.textContent = 'Falha ao copiar';
    setTimeout(() => {
      button.textContent = original;
      button.disabled = false;
      delete button.dataset.busy;
    }, 1800);
  }
}

let controlProbeBusy = false;
let lastControlProbeAt = 0;
async function probePlatformControls() {
  if (controlProbeBusy) return;
  const state = lastState || {};
  if (!activeLicense(state) || !state.targetTabId || state.scanner !== 'scanning') return;
  const now = Date.now();
  const expirationAt = Number(state.platformControls?.expirationCheckedAt || state.platformControls?.observed?.observedAt?.expiration || 0);
  const expirationFresh = expirationAt > 0 && now - expirationAt < CONTROLS_FRESH_MS;
  const interval = expirationFresh ? 2400 : 900;
  if (now - lastControlProbeAt < interval) return;
  lastControlProbeAt = now;
  controlProbeBusy = true;
  try {
    const response = await chrome.runtime.sendMessage({ type: 'ATS_PROBE_PLATFORM_CONTROLS' }).catch(() => null);
    if (response?.state) {
      lastState = response.state;
      renderShell(lastState);
    }
  } finally {
    controlProbeBusy = false;
  }
}

function syncToggleClasses(prefs = {}) {
  const mapping = [['geminiToggle','geminiEnabled']];
  for (const [id, key] of mapping) {
    const input = $(id);
    if (!input) continue;
    input.checked = key === 'geminiEnabled' ? prefs[key] !== false : !!prefs[key];
    input.closest('.toggle-row')?.classList.toggle('active', !!input.checked);
  }
}

async function loadPrefs() {
  const stored = await chrome.storage.local.get(PREF_KEY).catch(() => ({}));
  syncToggleClasses(stored?.[PREF_KEY] || {});
}

$('geminiToggle')?.addEventListener('change', event => {
  event.currentTarget.closest('.toggle-row')?.classList.toggle('active', !!event.currentTarget.checked);
});

$('connectScanner')?.addEventListener('click', () => connectNow().catch(() => {}));
$('retryLiveRead')?.addEventListener('click', () => refreshLiveReaders().catch(() => {}));
$('copyExpirationDiagnostic')?.addEventListener('click', () => copyExpirationDiagnostic().catch(() => {}));
$('activateLicense')?.addEventListener('click', () => {
  const button = $('activateLicense');
  button?.classList.add('loading');
  setTimeout(() => button?.classList.remove('loading'), 7000);
});

let lastState = {};
chrome.storage.onChanged.addListener(changes => {
  if (changes.scannerState) {
    lastState = changes.scannerState.newValue || {};
    renderShell(lastState);
    if (activeLicense(lastState)) $('activateLicense')?.classList.remove('loading');
  }
  if (changes[PREF_KEY]) syncToggleClasses(changes[PREF_KEY].newValue || {});
});

// Freshness is time-based; re-render even when Chrome storage is quiet so the
// badge cannot remain CONECTADO with a stale clock.
setInterval(() => {
  renderShell(lastState);
  probePlatformControls().catch(() => {});
}, 500);

import(chrome.runtime.getURL('src/sidepanel/trial-ui.js')).catch(() => {});

(async () => {
  await loadPrefs();
  const response = await chrome.runtime.sendMessage({ type: 'ATS_READ_SCANNER_STATE' }).catch(() => null);
  lastState = response?.state || {};
  renderShell(lastState);
  const targetHost = clean(lastState.diagnostics?.target?.host).toLowerCase();
  const looksLikeCasaTrade = lastState.platformId === 'casatrade'
    || /(^|\.)casatrade\.(?:com|io)$/.test(targetHost)
    || /(^|\.)casatraders\.online$/.test(targetHost)
    || /(^|\.)ivcasatraders\.online$/.test(targetHost);
  if (activeLicense(lastState) && looksLikeCasaTrade) refreshLiveReaders().catch(() => {});
})();

})();
