import { activateLicense, validateLicense, clearLicense, restoreCachedLicense } from './services/license.js';
import { readScannerState, updateScannerState } from './services/scanner-state-atomic.js';
import { storageLocalGet, storageSessionGet, tabsQuery, sidePanelSetBehavior, scriptingExecuteScript } from './services/chrome-compat.js';
import { detectPlatform } from './platforms/registry.js';
import { clearMarketAuthorityState, clearUserDeclaredExpirationState } from './background-market-session.js';
import { getOperationMode } from './core/analysis.js';

const DEFAULT_LICENSE = Object.freeze({
  status: 'unconfigured', plan: null, planLabel: null, dailyLimit: null, usedToday: 0,
  remainingToday: null, totalLimit: null, usedTotal: 0, remainingTotal: null, error: null
});
const SESSION_HISTORY_KEY = 'atsSessionSignalHistory';
const SHADOW_KEY = 'atsShadowCalibrationV1';
const EXACT_CLOCK_SOURCES = new Set(['trader-dom-countdown', 'network-server-cycle']);
const CONNECT_TIMEOUT_MS = 7000;

const clean = value => String(value ?? '').trim();
const activeLicense = license => {
  const status = clean(license?.status).toLowerCase();
  return ['active', 'valid'].includes(status)
    || license?.devMode === true
    || clean(license?.plan).toUpperCase() === 'OWNER_DEV';
};
const marketId = value => {
  const raw = clean(value).toUpperCase();
  if (!raw) return '';
  const otc = /(?:\(|\b|[_-])OTC(?:\)|\b)?/i.test(raw);
  const pair = raw.match(/\b([A-Z0-9]{2,20})\s*[\/_-]\s*([A-Z0-9]{2,12})/i);
  if (pair) return `${pair[1]}/${pair[2]}${otc ? ' (OTC)' : ''}`;
  return raw.replace(/\s+/g, ' ');
};
const sameAsset = (a, b) => !!marketId(a) && marketId(a) === marketId(b);

function marketDataConnected(state = {}) {
  const focus = state.diagnostics?.focusedAsset || {};
  return state.connection === 'online'
    && !!state.asset
    && Number.isFinite(Number(state.price))
    && focus.reliable === true
    && focus.chartScoped === true
    && focus.trustedChartFrame === true
    && sameAsset(focus.asset, state.asset)
    && Number(state.lastSeen || 0) > 0
    && Date.now() - Number(state.lastSeen) < 7000;
}

function handshakeReady(state = {}) {
  const clock = state.diagnostics?.marketClock || {};
  return marketDataConnected(state)
    && clock.available !== false
    && clock.role === 'candle-close'
    && Number.isFinite(Number(clock.secondsRemaining))
    && Number(clock.at || 0) > 0
    && Date.now() - Number(clock.at) < 5000;
}

function scheduleConnectionTimeout(tabId, connectedAt) {
  setTimeout(() => {
    readScannerState().then(current => {
      const sameTarget = Number(current.targetTabId) === Number(tabId)
        && Number(current.diagnostics?.target?.connectedAt || 0) === Number(connectedAt);
      if (!sameTarget || handshakeReady(current)) return null;
      return updateScannerState(state => {
        const stillSame = Number(state.targetTabId) === Number(tabId)
          && Number(state.diagnostics?.target?.connectedAt || 0) === Number(connectedAt);
        if (!stillSame || handshakeReady(state)) return state;
        if (marketDataConnected(state)) {
          const diagnostics = { ...(state.diagnostics || {}) };
          delete diagnostics.connectionError;
          return {
            ...state,
            scanner: 'scanning',
            connection: 'online',
            diagnostics: {
              ...diagnostics,
              acquisition: {
                ...(state.diagnostics?.acquisition || {}),
                stage: 'syncing_clock',
                reason: 'CasaTrade conectada. Sincronizando o countdown real da vela.',
                at: Date.now()
              }
            }
          };
        }
        return {
          ...state,
          scanner: 'idle',
          connection: 'offline',
          diagnostics: {
            ...(state.diagnostics || {}),
            connectionError: {
              code: 'handshake_timeout',
              message: 'Falha ao conectar — tentar novamente.',
              at: Date.now()
            },
            acquisition: {
              ...(state.diagnostics?.acquisition || {}),
              stage: 'connect_timeout',
              reason: 'Falha ao conectar — tentar novamente.',
              at: Date.now()
            }
          }
        };
      });
    }).catch(() => {});
  }, CONNECT_TIMEOUT_MS);
}

function platformFromUrl(url = '') {
  try { return detectPlatform(new URL(url).hostname); } catch { return null; }
}

function clearMarket(state = {}, extra = {}) {
  return clearMarketAuthorityState(state, {
    ...extra,
    scanner: 'idle',
    connection: 'offline',
    platformId: null,
    platformName: null,
    targetTabId: null,
    diagnostics: { ...(extra.diagnostics || {}) },
    marketSessionSource: 'background-control-clear',
    license: extra.license || state.license || DEFAULT_LICENSE
  });
}

function licenseBlockedDiagnostics(license = {}) {
  return {
    access: {
      state: 'license_required',
      error: clean(license?.error || 'license_required'),
      at: Date.now()
    }
  };
}

async function activePlatformTab() {
  const [tab] = await tabsQuery({ active: true, currentWindow: true }).catch(() => []);
  const platform = tab?.url ? platformFromUrl(tab.url) : null;
  return { tab: tab?.id ? tab : null, platform };
}

function inspectCasaTradeControlsDirect() {
  const clean0 = value => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  const fold0 = value => clean0(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const visible0 = el => {
    try {
      if (!el || !(el instanceof Element)) return false;
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity || 1) > 0;
    } catch { return false; }
  };
  const roots = [document], seen = new Set(), elements = [];
  while (roots.length && elements.length < 12000) {
    const root = roots.shift();
    if (!root || seen.has(root)) continue;
    seen.add(root);
    let rows = [];
    try { rows = [...root.querySelectorAll('*')]; } catch {}
    for (const el of rows) {
      elements.push(el);
      if (elements.length >= 12000) break;
      try { if (el.shadowRoot) roots.push(el.shadowRoot); } catch {}
    }
  }

  const parts = [];
  try { parts.push(document.body?.innerText || document.body?.textContent || ''); } catch {}
  const candidates = [];
  const tfRows = [];

  const normExp0 = value => {
    const s = fold0(value).replace(/\s+/g, '');
    let m = s.match(/^(\d{1,4})(?:s|seg|segundo|segundos)$/); if (m) return `${Number(m[1])}s`;
    m = s.match(/^(\d{1,3})(?:m|min|minuto|minutos)$/); if (m) return `${Number(m[1]) * 60}s`;
    m = s.match(/^(\d{1,2}):(\d{2})$/); if (m) return `${Number(m[1]) * 60 + Number(m[2])}s`;
    return null;
  };
  const normTf0 = value => {
    const s = clean0(value).toUpperCase().replace(/\s+/g, '');
    let m = s.match(/^M(\d{1,3})$/); if (m) return `M${Number(m[1])}`;
    m = s.match(/^(\d{1,3})(?:M|MIN)$/); if (m) return `M${Number(m[1])}`;
    return null;
  };

  for (const el of elements) {
    if (!visible0(el)) continue;
    let own = '';
    try {
      own = clean0(
        el.getAttribute?.('aria-valuetext')
        || el.getAttribute?.('aria-label')
        || el.getAttribute?.('title')
        || el.getAttribute?.('data-value')
        || (el instanceof HTMLInputElement || el instanceof HTMLSelectElement ? (el.value || el.selectedOptions?.[0]?.textContent || '') : '')
        || el.innerText
        || el.textContent
        || ''
      );
    } catch {}
    if (!own || own.length > 180) continue;

    let parent = '';
    try { parent = clean0(el.parentElement?.innerText || el.parentElement?.textContent || ''); } catch {}
    const local = clean0(`${own} ${parent}`).slice(0, 420);
    const folded = fold0(local);

    if (/expira|expiry|expiration|duracao|duration/.test(folded)) {
      const direct = local.match(/(?:expira(?:ção|cao)?|expiry|expiration|duracao|duração|duration)[^0-9]{0,60}(\d{1,4})\s*(s|seg|segundo|segundos|m|min|minuto|minutos)\b/i);
      const token = direct || local.match(/\b(\d{1,4})\s*(s|seg|segundo|segundos|m|min|minuto|minutos)\b/i);
      if (token) {
        const expiration = normExp0(`${token[1]}${token[2]}`);
        if (expiration) {
          let score = direct ? 120 : 85;
          if (/expira|expiry|expiration/.test(fold0(own))) score += 25;
          try {
            const r = el.getBoundingClientRect();
            if (r.right > innerWidth * .65) score += 10;
          } catch {}
          candidates.push({ expiration, score, text: local.slice(0,120) });
        }
      }
    }

    const tf = normTf0(own);
    if (tf && !/expira|expiry|expiration|duracao|duration/.test(folded)) {
      let score = 5;
      let flags = '';
      try { flags = `${el.className || ''} ${el.getAttribute?.('aria-selected') || ''} ${el.getAttribute?.('aria-current') || ''} ${el.getAttribute?.('data-state') || ''}`; } catch {}
      if (/true|active|selected|current|checked/i.test(flags)) score += 80;
      if (/vela|candle|timeframe|periodo|gr[aá]fico/.test(folded)) score += 30;
      tfRows.push({ timeframe: tf, score });
    }

    parts.push(own);
  }

  const page = clean0(parts.join(' ')).slice(0, 300000);
  const pageExp = page.match(/(?:expira(?:ção|cao)?|expiry|expiration|duracao|duração|duration)[^0-9]{0,80}(\d{1,4})\s*(s|seg|segundo|segundos|m|min|minuto|minutos)\b/i);
  if (pageExp) {
    const expiration = normExp0(`${pageExp[1]}${pageExp[2]}`);
    if (expiration) candidates.push({ expiration, score: 100, text: 'page-expiration-label' });
  }

  candidates.sort((a,b) => b.score - a.score);
  tfRows.sort((a,b) => b.score - a.score);
  return {
    expiration: candidates[0]?.expiration || null,
    expirationConfidence: Number(candidates[0]?.score || 0),
    timeframe: tfRows[0]?.timeframe || null,
    timeframeConfidence: Number(tfRows[0]?.score || 0),
    evidence: candidates[0]?.text || null,
    observedAt: Date.now(),
    host: String(location.hostname || '').toLowerCase(),
    isTop: window === window.top
  };
}


async function inspectExpirationDiagnostic() {
  const clean0 = value => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  const fold0 = value => clean0(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const visible0 = el => {
    try {
      if (!el || !(el instanceof Element)) return false;
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0
        && s.display !== 'none'
        && s.visibility !== 'hidden'
        && Number(s.opacity || 1) > 0;
    } catch { return false; }
  };
  const rawOf = el => {
    try {
      return clean0(
        el?.getAttribute?.('aria-valuetext')
        || el?.getAttribute?.('data-value')
        || el?.getAttribute?.('aria-label')
        || el?.getAttribute?.('title')
        || (el instanceof HTMLInputElement || el instanceof HTMLSelectElement
          ? (el.value || el.selectedOptions?.[0]?.textContent || '')
          : '')
        || el?.innerText
        || el?.textContent
        || ''
      );
    } catch { return ''; }
  };
  const hasExpirationWord = value => /expira|expiry|expiration|duracao|duration/.test(fold0(value));
  const hasDuration = value => /\b\d{1,4}\s*(?:s|seg|segundo|segundos|m|min|minuto|minutos)\b/i.test(clean0(value));

  const selectorAttempts = [];
  const selectors = [
    '[aria-label*="expira" i]',
    '[title*="expira" i]',
    '[data-testid*="expir" i]',
    '[data-name*="expir" i]',
    '[class*="expir" i]'
  ];

  let selected = null;
  let selectedSelector = null;

  for (const selector of selectors) {
    let nodes = [];
    try {
      nodes = [...document.querySelectorAll(selector)];
    } catch (error) {
      selectorAttempts.push({
        selector,
        found: 0,
        visible: 0,
        reason: `selector_error: ${String(error?.message || error)}`
      });
      continue;
    }

    const visible = nodes.filter(visible0);
    const withText = visible.filter(el => {
      const text = rawOf(el) || clean0(el?.parentElement?.innerText || el?.parentElement?.textContent || '');
      return hasExpirationWord(text);
    });

    let reason = 'ok';
    if (!nodes.length) reason = 'nenhum elemento correspondeu ao seletor';
    else if (!visible.length) reason = 'elementos encontrados, mas nenhum estava visível';
    else if (!withText.length) reason = 'elementos visíveis encontrados, mas sem texto de Expiração';
    else if (!withText.some(el => hasDuration(rawOf(el) + ' ' + clean0(el?.parentElement?.innerText || el?.parentElement?.textContent || '')))) {
      reason = 'texto de Expiração encontrado, mas sem valor de duração no elemento/contexto imediato';
    }

    selectorAttempts.push({
      selector,
      found: nodes.length,
      visible: visible.length,
      expirationTextMatches: withText.length,
      reason
    });

    if (!selected && withText.length) {
      selected = withText.find(el => hasDuration(rawOf(el) + ' ' + clean0(el?.parentElement?.innerText || el?.parentElement?.textContent || '')))
        || withText[0];
      selectedSelector = selector;
    }
  }

  if (!selected) {
    const roots = [document];
    const seen = new Set();
    while (roots.length && !selected) {
      const root = roots.shift();
      if (!root || seen.has(root)) continue;
      seen.add(root);

      let nodes = [];
      try { nodes = [...root.querySelectorAll('*')]; } catch {}
      for (const el of nodes) {
        try { if (el.shadowRoot) roots.push(el.shadowRoot); } catch {}
        if (!visible0(el)) continue;
        const own = rawOf(el);
        if (!own || own.length > 220 || !hasExpirationWord(own)) continue;
        selected = el;
        selectedSelector = 'fallback:text-scan';
        break;
      }
    }
    selectorAttempts.push({
      selector: 'fallback:text-scan',
      found: selected ? 1 : 0,
      visible: selected ? 1 : 0,
      reason: selected
        ? 'usado porque os seletores direcionados não localizaram um campo utilizável'
        : 'nenhum elemento visível contendo texto de Expiração foi encontrado'
    });
  }

  let rawText = '';
  let container = selected;
  if (selected) {
    rawText = rawOf(selected);
    if (!rawText) rawText = clean0(selected.innerText || selected.textContent || '');

    // Prefer the smallest nearby container that contains both the label and its
    // duration/value, without altering or clicking anything in CasaTrade.
    let cursor = selected;
    for (let i = 0; i < 5 && cursor; i++, cursor = cursor.parentElement) {
      const text = clean0(cursor.innerText || cursor.textContent || '');
      if (hasExpirationWord(text) && hasDuration(text)) {
        container = cursor;
        break;
      }
    }
  }

  const containerText = clean0(container?.innerText || container?.textContent || '');
  const outerHTML = String(container?.outerHTML || '').slice(0, 3000);
  let failureReason = '';
  if (!selected) failureReason = 'Nenhum campo/container visível com texto de Expiração foi localizado.';
  else if (!rawText && !containerText) failureReason = 'Container localizado, mas sem texto cru legível.';
  else if (!hasDuration(rawText + ' ' + containerText)) failureReason = 'Texto de Expiração localizado, mas nenhum valor de duração foi encontrado no contexto próximo.';
  else failureReason = 'O campo foi localizado pelo diagnóstico; compare este DOM com o seletor usado pelo leitor atual.';

  const bodyInnerText = (() => {
    try { return String(document.body?.innerText || ''); } catch { return ''; }
  })();
  const normalizedBodyText = fold0(bodyInnerText);
  const wordPresence = {
    expira: normalizedBodyText.includes('expira'),
    valor: normalizedBodyText.includes('valor'),
    comprar: normalizedBodyText.includes('comprar'),
    vender: normalizedBodyText.includes('vender'),
    lucro: normalizedBodyText.includes('lucro')
  };

  const iframeRows = [];
  let iframeNodes = [];
  try { iframeNodes = [...document.querySelectorAll('iframe')]; } catch {}
  for (const frame of iframeNodes) {
    let rect = { width: 0, height: 0 };
    try { rect = frame.getBoundingClientRect(); } catch {}
    let contentDocumentAccessible = false;
    try { contentDocumentAccessible = !!frame.contentDocument; } catch { contentDocumentAccessible = false; }
    iframeRows.push({
      src: String(frame.getAttribute?.('src') || '').slice(0, 200),
      sandbox: String(frame.getAttribute?.('sandbox') || ''),
      id: String(frame.id || ''),
      className: String(frame.className || ''),
      width: Math.round(Number(rect.width || 0)),
      height: Math.round(Number(rect.height || 0)),
      contentDocumentAccessible
    });
  }

  let openShadowRootCount = 0;
  let allElements = [];
  try { allElements = [...document.querySelectorAll('*')]; } catch {}
  for (const el of allElements) {
    try { if (el.shadowRoot) openShadowRootCount += 1; } catch {}
  }

  let canvasCount = 0;
  try { canvasCount = document.querySelectorAll('canvas').length; } catch {}

  const diagnosticRequestId = `ats-exp-diag-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const diagnosticSnapshots = await new Promise(resolve => {
    let canvas = null;
    let bridge = null;
    let network = null;
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      try { window.removeEventListener('message', onDiagnosticMessage); } catch {}
      resolve({ canvas, bridge, network });
    };

    const onDiagnosticMessage = event => {
      const data = event.data;
      if (!data || data.requestId !== diagnosticRequestId) return;
      if (data.source === 'ATS_CANVAS_DIAGNOSTIC_SNAPSHOT') canvas = data.payload || null;
      if (data.source === 'ATS_EMBEDDED_FEED_DIAGNOSTIC_SNAPSHOT') bridge = data.payload || null;
      if (data.source === 'ATS_NETWORK_DIAGNOSTIC_SNAPSHOT') network = data.payload || null;
      if (canvas && bridge && network) finish();
    };

    try { window.addEventListener('message', onDiagnosticMessage); } catch {}
    try {
      window.postMessage({
        source: 'ATS_EXPIRATION_DIAGNOSTIC_REQUEST',
        requestId: diagnosticRequestId
      }, '*');
    } catch {}

    setTimeout(finish, 260);
  });

  return {
    host: String(location.hostname || '').toLowerCase(),
    href: String(location.href || '').slice(0, 300),
    isTop: window === window.top,
    visibilityState: String(document.visibilityState || ''),
    title: String(document.title || '').slice(0, 300),
    bodyInnerTextLength: bodyInnerText.length,
    wordPresence,
    documentContext: {
      iframeCount: iframeRows.length,
      iframes: iframeRows,
      openShadowRootCount,
      canvasCount
    },
    canvasDiagnostic: diagnosticSnapshots.canvas,
    canvasDiagnosticError: diagnosticSnapshots.canvas ? '' : 'ATS_CANVAS_DIAGNOSTIC_SNAPSHOT não respondeu dentro de 220 ms',
    embeddedFeedDiagnostic: diagnosticSnapshots.bridge,
    embeddedFeedDiagnosticError: diagnosticSnapshots.bridge ? '' : 'ATS_EMBEDDED_FEED_DIAGNOSTIC_SNAPSHOT não respondeu dentro de 260 ms',
    networkDiagnostic: diagnosticSnapshots.network,
    networkDiagnosticError: diagnosticSnapshots.network ? '' : 'ATS_NETWORK_DIAGNOSTIC_SNAPSHOT não respondeu dentro de 260 ms',
    selectedSelector,
    rawText: rawText || containerText || '',
    containerOuterHTML: outerHTML,
    selectorAttempts,
    failureReason,
    observedAt: Date.now()
  };
}

async function getTabDiagnostic(tabId) {
  if (!tabId || !chrome.tabs?.get) return { tab: null, error: 'chrome.tabs.get unavailable or targetTabId missing' };
  return new Promise(resolve => {
    let settled = false;
    const finish = (tab, error = '') => {
      if (settled) return;
      settled = true;
      resolve({
        tab: tab ? {
          id: tab.id ?? null,
          url: String(tab.url || ''),
          active: tab.active === true,
          discarded: tab.discarded === true,
          status: String(tab.status || ''),
          windowId: tab.windowId ?? null
        } : null,
        error: String(error || '')
      });
    };
    try {
      const returned = chrome.tabs.get(Number(tabId), tab => {
        let runtimeError = null;
        try { runtimeError = chrome.runtime?.lastError || null; } catch {}
        finish(tab || null, runtimeError?.message || '');
      });
      if (returned && typeof returned.then === 'function') {
        returned.then(tab => finish(tab || null, '')).catch(error => finish(null, String(error?.message || error)));
      }
    } catch (error) {
      finish(null, String(error?.message || error));
    }
  });
}

async function listCasaTradeTabsDiagnostic() {
  const rows = await tabsQuery({}).catch(() => []);
  return (Array.isArray(rows) ? rows : []).filter(tab => {
    try { return new URL(String(tab?.url || '')).hostname.toLowerCase().includes('casatrade'); }
    catch { return false; }
  }).map(tab => ({
    id: tab.id ?? null,
    url: String(tab.url || ''),
    active: tab.active === true,
    discarded: tab.discarded === true,
    windowId: tab.windowId ?? null
  }));
}

async function collectExpirationDiagnostic(tabId) {
  const [targetTabInfo, casaTradeTabs] = await Promise.all([
    getTabDiagnostic(tabId),
    listCasaTradeTabsDiagnostic()
  ]);

  if (!tabId) {
    return {
      ok: false,
      error: 'target_tab_missing',
      executeScriptErrors: ['target_tab_missing'],
      targetTab: targetTabInfo.tab,
      targetTabError: targetTabInfo.error,
      casaTradeTabs,
      frameCount: 0,
      expectedFrameCountAtLeast: 0,
      best: null,
      frames: []
    };
  }

  let rows = [];
  const executeScriptErrors = [];
  let isolatedFailed = false;

  try {
    rows = await scriptingExecuteScript({
      target: { tabId: Number(tabId), allFrames: true },
      func: inspectExpirationDiagnostic,
      world: 'ISOLATED'
    }) || [];
  } catch (firstError) {
    isolatedFailed = true;
    executeScriptErrors.push(String(firstError?.message || firstError));
    try {
      rows = await scriptingExecuteScript({
        target: { tabId: Number(tabId), allFrames: true },
        func: inspectExpirationDiagnostic
      }) || [];
    } catch (secondError) {
      executeScriptErrors.push(String(secondError?.message || secondError));
      return {
        ok: false,
        error: String(secondError?.message || secondError || firstError),
        executeScriptErrors,
        targetTab: targetTabInfo.tab,
        targetTabError: targetTabInfo.error,
        casaTradeTabs,
        frameCount: 0,
        expectedFrameCountAtLeast: 0,
        best: null,
        frames: []
      };
    }
  }

  const frames = rows.map(row => ({
    frameId: Number.isFinite(Number(row?.frameId)) ? Number(row.frameId) : null,
    ...(row?.result || {})
  }));

  const topFrame = frames.find(row => row.isTop === true) || frames.find(row => Number(row.frameId) === 0) || null;
  const topIframeCount = Number(topFrame?.documentContext?.iframeCount || 0);
  const expectedFrameCountAtLeast = topFrame ? 1 + topIframeCount : 1;

  if (frames.length < expectedFrameCountAtLeast) {
    executeScriptErrors.push(
      `executeScript_returned_fewer_frames: returned=${frames.length} expected_at_least=${expectedFrameCountAtLeast} top_iframe_count=${topIframeCount}`
    );
  }

  if (isolatedFailed && !executeScriptErrors.length) {
    executeScriptErrors.push('executeScript isolated-world failed without an exposed error message');
  }

  const useful = frames.filter(row => row.rawText || row.containerOuterHTML || row.selectedSelector);
  useful.sort((a, b) =>
    Number(!!b.containerOuterHTML) - Number(!!a.containerOuterHTML)
    || Number(!!b.rawText) - Number(!!a.rawText)
    || Number(b.isTop === true) - Number(a.isTop === true)
  );

  return {
    ok: true,
    frameCount: frames.length,
    expectedFrameCountAtLeast,
    executeScriptErrors,
    targetTab: targetTabInfo.tab,
    targetTabError: targetTabInfo.error,
    casaTradeTabs,
    best: useful[0] || null,
    frames
  };
}

async function probePlatformControlsDirect(tabId) {
  if (!tabId) return { ok: false, error: 'target_tab_missing' };
  let rows = [];
  try {
    rows = await scriptingExecuteScript({
      target: { tabId: Number(tabId), allFrames: true },
      func: inspectCasaTradeControlsDirect,
      world: 'ISOLATED'
    }) || [];
  } catch {
    try {
      rows = await scriptingExecuteScript({
        target: { tabId: Number(tabId), allFrames: true },
        func: inspectCasaTradeControlsDirect
      }) || [];
    } catch (error) {
      return { ok: false, error: String(error?.message || error) };
    }
  }

  const results = rows.map(row => ({
    frameId: Number.isFinite(Number(row?.frameId)) ? Number(row.frameId) : null,
    ...(row?.result || {})
  })).filter(row => row && (row.expiration || row.timeframe));

  const exp = results.filter(row => row.expiration)
    .sort((a,b) => Number(b.expirationConfidence || 0) - Number(a.expirationConfidence || 0)
      || Number(b.isTop === true) - Number(a.isTop === true))[0] || null;
  const tf = results.filter(row => row.timeframe)
    .sort((a,b) => Number(b.timeframeConfidence || 0) - Number(a.timeframeConfidence || 0))[0] || null;

  if (!exp && !tf) return { ok: false, error: 'controls_not_found', frames: results.length };

  const now = Date.now();
  const next = await updateScannerState(state => {
    if (Number(state.targetTabId || 0) && Number(state.targetTabId) !== Number(tabId)) return state;
    const previous = state.platformControls?.observed || {};
    const expiration = exp?.expiration || previous.expiration || null;
    const timeframe = tf?.timeframe || previous.timeframe || null;
    const observedAt = {
      ...(previous.observedAt || {}),
      ...(exp?.expiration ? { expiration: now } : {}),
      ...(tf?.timeframe ? { timeframe: now } : {})
    };
    const confidence = {
      ...(previous.confidence || {}),
      ...(exp?.expiration ? { expiration: Math.max(100, Number(exp.expirationConfidence || 0)) } : {}),
      ...(tf?.timeframe ? { timeframe: Math.max(70, Number(tf.timeframeConfidence || 0)) } : {})
    };
    const observed = {
      ...previous,
      expiration,
      timeframe,
      source: 'background-direct-dom',
      observedAt,
      confidence
    };
    const diagnostics = { ...(state.diagnostics || {}) };
    const operationMode = getOperationMode(state.analystPreferences?.operationMode || 'M1');
    const effectiveTf = clean(state.diagnostics?.marketClock?.timeframe || state.diagnostics?.marketSession?.timeframe || state.analysisTimeframe || state.timeframe || timeframe).toUpperCase();
    const expirationReady = expiration === operationMode.expiration && effectiveTf === operationMode.timeframe;
    const expirationLabel = operationMode.expiration === '300s' ? '5 minutos' : '1 minuto';
    diagnostics.expirationGuard = {
      ...(diagnostics.expirationGuard || {}),
      required: operationMode.expiration,
      actual: expiration,
      ready: expirationReady,
      validForM1: operationMode.timeframe === 'M1' ? expirationReady : false,
      validForMode: expirationReady,
      operationMode: operationMode.timeframe,
      reason: !expiration
        ? 'Expiração real da CasaTrade ainda não confirmada.'
        : expiration !== operationMode.expiration
          ? `Ajuste a expiração da CasaTrade para ${expirationLabel}`
          : effectiveTf !== operationMode.timeframe
            ? `Ajuste o timeframe da CasaTrade para ${operationMode.timeframe}.`
            : `Expiração ao vivo de ${expirationLabel} confirmada pela CasaTrade.`,
      at: now,
      source: 'background-direct-dom'
    };
    diagnostics.platformTime = {
      ...(diagnostics.platformTime || {}),
      timeframe: effectiveTf || timeframe || null,
      expiration,
      source: 'background-direct-dom',
      ready: expirationReady,
      at: now
    };
    return {
      ...state,
      ...(expiration ? { expiration, targetExpiration: expiration } : {}),
      platformControls: {
        ...(state.platformControls || {}),
        observed,
        checkedAt: now,
        expirationCheckedAt: exp?.expiration ? now : Number(state.platformControls?.expirationCheckedAt || 0),
        timeframeCheckedAt: tf?.timeframe ? now : Number(state.platformControls?.timeframeCheckedAt || 0),
        frameId: exp?.frameId ?? tf?.frameId ?? state.platformControls?.frameId ?? null,
        source: 'background-direct-dom',
        aligned: effectiveTf === operationMode.timeframe && expiration === operationMode.expiration,
        liveAuthority: true
      },
      diagnostics
    };
  });

  return {
    ok: true,
    expiration: exp?.expiration || null,
    timeframe: tf?.timeframe || null,
    frameId: exp?.frameId ?? tf?.frameId ?? null,
    evidence: exp?.evidence || null,
    state: next
  };
}

async function recoverLicense(state = {}, force = false) {
  if (!force && activeLicense(state.license)) return state.license;

  const restored = await restoreCachedLicense().catch(() => null);
  if (activeLicense(restored)) return restored;

  const { settings = {} } = await storageLocalGet('settings').catch(() => ({}));
  const validated = await validateLicense(settings).catch(() => null);
  if (validated?.ok && activeLicense(validated.license)) return { ...validated.license, status: 'active', error: null };

  if (activeLicense(state.license) && validated?.error === 'device_locked') {
    return { ...state.license, status: 'active', error: 'device_locked', syncPending: true };
  }
  return {
    ...(state.license || DEFAULT_LICENSE),
    status: activeLicense(state.license) ? 'active' : String(state.license?.status || 'unconfigured'),
    error: validated?.error || state.license?.error || null,
    syncPending: validated?.error === 'device_locked' || validated?.error === 'backend_unreachable'
  };
}

async function injectModern(tabId) {
  const inject = globalThis.__ATS_INJECT_MODERN_PIPELINE__;
  if (typeof inject !== 'function' || !tabId) return false;
  return inject(tabId).catch(() => false);
}

async function refreshTargetTab() {
  const state = await readScannerState();
  if (!activeLicense(state.license)) return { ok: false, error: 'license_required', state };
  const tabId = Number(state.targetTabId || 0);
  if (!tabId) return { ok: false, error: 'target_tab_missing', state };
  const injected = await injectModern(tabId);
  if (!injected) return { ok: false, error: 'runtime_injection_failed', state: await readScannerState() };
  const probed = await probePlatformControlsDirect(tabId).catch(() => null);
  return { ok: true, tabId, controls: probed || null, state: probed?.state || await readScannerState() };
}

async function connectActiveTab({ automatic = false } = {}) {
  let state = await readScannerState();
  const license = await recoverLicense(state);
  if (!activeLicense(license)) {
    const next = await updateScannerState(current => clearMarket(current, {
      license,
      diagnostics: licenseBlockedDiagnostics(license)
    }));
    return { ok: false, error: license.error || 'license_required', state: next };
  }

  const { tab, platform } = await activePlatformTab();
  if (!tab?.id || !platform) {
    const next = await updateScannerState(current => clearMarket(current, {
      license,
      diagnostics: { unsupportedHost: (() => { try { return new URL(tab?.url || '').hostname || null; } catch { return null; } })() }
    }));
    return { ok: false, error: 'platform_not_registered', state: next };
  }

  const next = await updateScannerState(current => {
    const currentFocus = current.diagnostics?.focusedAsset || null;
    const currentConfirmedAsset = current.asset || current.diagnostics?.marketSession?.asset || '';
    const sameTabBeforeReconnect = Number(current.targetTabId) === Number(tab.id);
    const sameConfirmedAsset = !!currentFocus?.asset
      && currentFocus.reliable === true
      && currentFocus.chartScoped === true
      && currentFocus.trustedChartFrame === true
      && sameAsset(currentFocus.asset, currentConfirmedAsset);
    const preserveDeclaredExpiration = automatic === true && sameTabBeforeReconnect && sameConfirmedAsset;
    const restartBase = preserveDeclaredExpiration ? current : clearUserDeclaredExpirationState(current);

    const sameTab = Number(restartBase.targetTabId) === Number(tab.id);
    const focus = restartBase.diagnostics?.focusedAsset || null;
    const focusFresh = Number(focus?.at || 0) > 0 && Date.now() - Number(focus.at) < 2500;
    const dataFresh = Number(restartBase.lastSeen || 0) > 0 && Date.now() - Number(restartBase.lastSeen) < 2500;
    const preserveLive = sameTab && restartBase.connection === 'online' && focusFresh && dataFresh
      && focus?.reliable === true && focus?.trustedChartFrame === true;

    const diagnostics = { ...(restartBase.diagnostics || {}) };
    delete diagnostics.connectionError;
    const base = {
      ...restartBase,
      license,
      platformId: platform.id,
      platformName: platform.name,
      targetTabId: tab.id,
      scanner: 'scanning',
      connection: preserveLive ? 'online' : 'connecting',
      diagnostics: {
        ...diagnostics,
        target: { host: new URL(tab.url).hostname, tabId: tab.id, connectedAt: Date.now(), pipeline: 'single-session' },
        acquisition: {
          stage: preserveLive ? 'diagnosing_next_candle' : 'confirming_asset',
          reason: preserveLive ? 'Sessão ao vivo preservada e conferida.' : 'CasaTrade conectada. Confirmando novamente o gráfico ativo.',
          at: Date.now()
        }
      }
    };

    if (preserveLive) return base;
    return clearMarketAuthorityState(base, {
      license,
      platformId: platform.id,
      platformName: platform.name,
      targetTabId: tab.id,
      scanner: 'scanning',
      connection: 'connecting',
      diagnostics: base.diagnostics,
      marketSessionSource: 'connect-active-tab'
    });
  });

  const injected = await injectModern(tab.id);
  if (!injected) {
    const failed = await updateScannerState(current => ({
      ...current,
      connection: current.connection === 'online' ? 'online' : 'connecting',
      diagnostics: {
        ...(current.diagnostics || {}),
        acquisition: {
          ...(current.diagnostics?.acquisition || {}),
          stage: 'runtime_injection_failed',
          reason: 'A CasaTrade foi reconhecida, mas os leitores ao vivo não conseguiram ser injetados. Recarregue a aba da CasaTrade e conecte novamente.',
          at: Date.now()
        }
      }
    }));
    return { ok: false, error: 'runtime_injection_failed', platform: { id: platform.id, name: platform.name }, tabId: tab.id, state: failed };
  }
  const probed = await probePlatformControlsDirect(tab.id).catch(() => null);
  const connectedAt = Number(next.diagnostics?.target?.connectedAt || Date.now());
  scheduleConnectionTimeout(tab.id, connectedAt);
  return { ok: true, platform: { id: platform.id, name: platform.name }, tabId: tab.id, controls: probed || null, state: probed?.state || await readScannerState() || next };
}

async function activate(key = '') {
  const { settings = {} } = await storageLocalGet('settings').catch(() => ({}));
  const response = await activateLicense(settings, clean(key));
  let license = response?.license || null;

  if (!response?.ok && response?.error === 'device_locked') {
    const restored = await restoreCachedLicense().catch(() => null);
    if (activeLicense(restored)) license = { ...restored, error: 'device_locked', syncPending: true };
  }

  const ok = activeLicense(license);
  const next = await updateScannerState(current => {
    if (ok) return { ...current, license: { ...license, status: 'active' } };
    const blockedLicense = {
      ...(current.license || DEFAULT_LICENSE),
      ...(license || {}),
      status: String(license?.status || current.license?.status || 'unconfigured'),
      error: response?.error || license?.error || 'license_inactive'
    };
    return clearMarket(current, { license: blockedLicense, diagnostics: licenseBlockedDiagnostics(blockedLicense) });
  });
  if (ok) return { ...response, ok: true, error: null, license: next.license, state: next };
  return { ...response, ok: false, error: response?.error || 'license_inactive', license: next.license, state: next };
}

async function validate() {
  const state = await readScannerState();
  const license = await recoverLicense(state, true);
  const ok = activeLicense(license);
  const next = await updateScannerState(current => ok
    ? { ...current, license }
    : clearMarket(current, { license, diagnostics: licenseBlockedDiagnostics(license) }));
  return { ok, license, state: next };
}

async function readSessionHistory() {
  const [session, shadow] = await Promise.all([
    storageSessionGet(SESSION_HISTORY_KEY).catch(() => ({})),
    storageLocalGet(SHADOW_KEY).catch(() => ({}))
  ]);
  const rows = Array.isArray(session?.[SESSION_HISTORY_KEY]) ? session[SESSION_HISTORY_KEY] : [];
  const shadowData = shadow?.[SHADOW_KEY] || { rows: [], metrics: {} };
  return {
    ok: true,
    rows,
    shadowRows: Array.isArray(shadowData.rows) ? shadowData.rows.slice(-100) : [],
    shadowMetrics: shadowData.metrics || {}
  };
}

function clockBoundToFocus(clock = {}, focus = {}) {
  const sameFrame = Number(clock.frameId) === Number(focus.frameId)
    && clean(clock.frameHost).toLowerCase() === clean(focus.frameHost).toLowerCase();
  const boundControlFrame = clock.crossFrameControl === true
    && Number(clock.boundFocusFrameId) === Number(focus.frameId)
    && clean(clock.boundFocusFrameHost).toLowerCase() === clean(focus.frameHost).toLowerCase();
  return sameFrame || boundControlFrame;
}

function exactTradeReady(state = {}) {
  const clock = state.diagnostics?.marketClock || {};
  const focus = state.diagnostics?.focusedAsset || {};
  const professional = state.professionalDecision || {};
  const expirationAt = Number(state.platformControls?.expirationCheckedAt || state.platformControls?.observed?.observedAt?.expiration || 0);
  const controlsFresh = expirationAt > 0 && Date.now() - expirationAt < 7000;
  const actualExpiration = controlsFresh ? clean(state.platformControls?.observed?.expiration || '') : '';
  if (professional.timeReady !== true || professional.expirationReady !== true || professional.actionable !== true) return false;
  if (clock.verified !== true || clock.available === false || clock.role !== 'candle-close' || !EXACT_CLOCK_SOURCES.has(clean(clock.source))) return false;
  if (Date.now() - Number(clock.at || 0) >= 3000) return false;
  if (!sameAsset(clock.asset, state.asset) || !sameAsset(focus.asset, state.asset)) return false;
  if (!clockBoundToFocus(clock, focus)) return false;
  if (!actualExpiration || !controlsFresh) return false;
  return true;
}

async function manualIntent(direction = '') {
  direction = String(direction || '').toUpperCase();
  if (!['BUY', 'SELL'].includes(direction)) return { ok: false, error: 'invalid_direction' };
  const state = await readScannerState();
  if (!activeLicense(state.license)) return { ok: false, error: 'license_required', state };
  const signalDirection = String(state.signal?.direction || '').toUpperCase();
  const confirmed = state.signal?.state === 'CONFIRM' || ['ENTER_BUY', 'ENTER_SELL'].includes(String(state.signal?.uiState || ''));
  if (!confirmed || signalDirection !== direction) return { ok: false, error: 'signal_not_confirmed', state };

  const professional = state.professionalDecision || {};
  const expectedUi = direction === 'BUY' ? 'ENTER_BUY' : 'ENTER_SELL';
  if (professional.uiState !== expectedUi || professional.direction !== direction || professional.actionable !== true) {
    return { ok: false, error: 'professional_signal_not_confirmed', state };
  }
  if (!exactTradeReady(state)) return { ok: false, error: 'time_not_synchronized', state };

  const actualExpiration = clean(state.platformControls?.observed?.expiration || state.targetExpiration || state.expiration || '') || null;
  const intent = {
    direction, asset: state.asset, timeframe: state.analysisTimeframe || state.timeframe,
    expiration: actualExpiration,
    targetStart: state.signal?.targetStart || null,
    mode: 'manual-only', createdAt: Date.now()
  };
  const next = await updateScannerState(current => ({ ...current, tradeIntent: intent }));
  return { ok: true, intent, state: next };
}

async function setScanner(enabled = false) {
  const state = await readScannerState();
  if (enabled && !activeLicense(state.license)) {
    const next = await updateScannerState(current => clearMarket(current, {
      license: current.license || DEFAULT_LICENSE,
      diagnostics: licenseBlockedDiagnostics(current.license || DEFAULT_LICENSE)
    }));
    return { ok: false, error: 'license_required', state: next };
  }
  const next = await updateScannerState(current => {
    const restartBase = enabled ? clearUserDeclaredExpirationState(current) : current;
    return {
      ...restartBase,
      scanner: enabled ? 'scanning' : 'idle',
      ...(enabled ? {} : { signal: null, professionalDecision: null, tradeIntent: null })
    };
  });
  return { ok: true, state: next };
}

sidePanelSetBehavior({ openPanelOnActionClick: true }).catch(() => {});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const type = String(message?.type || '');

  if (type === 'ATS_CONNECT_ACTIVE_TAB') {
    connectActiveTab().then(sendResponse).catch(error => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }

  if (type === 'ATS_REFRESH_MARKET') {
    connectActiveTab({ automatic: true }).then(sendResponse).catch(error => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }

  if (type === 'ATS_REFRESH_TARGET_TAB') {
    refreshTargetTab().then(sendResponse).catch(error => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }

  if (type === 'ATS_PROBE_PLATFORM_CONTROLS') {
    readScannerState().then(state => probePlatformControlsDirect(Number(state.targetTabId || 0)))
      .then(sendResponse)
      .catch(error => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }

  if (type === 'ATS_GET_EXPIRATION_DIAGNOSTIC') {
    readScannerState().then(state => collectExpirationDiagnostic(Number(state.targetTabId || 0)))
      .then(sendResponse)
      .catch(error => sendResponse({ ok: false, error: String(error?.message || error), frames: [] }));
    return true;
  }

  if (type === 'ATS_READ_SCANNER_STATE' || type === 'ATS_GET_STATE') {
    readScannerState().then(state => sendResponse({ ok: true, state })).catch(error => sendResponse({ ok: false, error: String(error?.message || error), state: {} }));
    return true;
  }

  if (type === 'ATS_ACTIVATE_LICENSE') {
    activate(message.key).then(async result => {
      if (result.ok) {
        const connected = await connectActiveTab().catch(() => null);
        if (connected?.state) result.state = connected.state;
      }
      sendResponse(result);
    }).catch(error => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }

  if (type === 'ATS_VALIDATE_LICENSE') {
    validate().then(sendResponse).catch(error => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }

  if (type === 'ATS_CLEAR_LICENSE') {
    clearLicense().then(() => updateScannerState(current => clearMarket(current, { license: DEFAULT_LICENSE, diagnostics: licenseBlockedDiagnostics(DEFAULT_LICENSE) })))
      .then(state => sendResponse({ ok: true, state }))
      .catch(error => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }

  if (type === 'ATS_GET_PLATFORM_CONFIG') {
    let host = clean(message.host);
    if (!host && sender?.url) { try { host = new URL(sender.url).hostname; } catch {} }
    const platform = detectPlatform(host);
    sendResponse({ ok: !!platform, platform: platform ? { ...platform } : null });
    return false;
  }

  if (type === 'ATS_READ_PLATFORM_CONTROLS' || type === 'ATS_SYNC_PLATFORM_PREFERENCES') {
    readScannerState().then(state => {
      const observed = state.platformControls?.observed || {};
      sendResponse({ ok: true, aligned: !!state.platformControls?.aligned, observed });
    }).catch(error => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }

  if (type === 'ATS_PREPARE_TRADE') {
    manualIntent(message.direction).then(sendResponse).catch(error => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }

  if (type === 'ATS_GET_SESSION_HISTORY') {
    readSessionHistory().then(sendResponse).catch(error => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }

  if (type === 'ATS_SET_SCANNER') {
    setScanner(message.enabled === true).then(sendResponse).catch(error => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }

  if (type === 'ATS_RESET_STATE') {
    readScannerState().then(state => updateScannerState(() => clearMarket({}, { license: state.license || DEFAULT_LICENSE, diagnostics: activeLicense(state.license) ? {} : licenseBlockedDiagnostics(state.license || DEFAULT_LICENSE) })))
      .then(state => sendResponse({ ok: true, state }))
      .catch(error => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }

  if (['ATS_PLATFORM_SNAPSHOT', 'ATS_DOM_CATALOG', 'ATS_NETWORK_DIAGNOSTIC'].includes(type)) {
    sendResponse({ ok: true, ignored: true, reason: 'single_session_market_authority' });
    return false;
  }

  return false;
});

(async () => {
  const state = await readScannerState().catch(() => ({}));
  const license = await recoverLicense(state).catch(() => state.license || DEFAULT_LICENSE);
  await updateScannerState(current => activeLicense(license)
    ? { ...current, license }
    : clearMarket(current, { license, diagnostics: licenseBlockedDiagnostics(license) }));
})().catch(() => {});
