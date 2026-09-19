import { updateScannerState } from './services/scanner-state-atomic.js';

const clean = value => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
const num = value => value == null || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null;
const casaHost = value => value === 'casatrade.com' || value.endsWith('.casatrade.com') || value === 'casatrade.io' || value.endsWith('.casatrade.io');
const traderHost = value => value === 'casatraders.online' || value.endsWith('.casatraders.online') || value === 'ivcasatraders.online' || value.endsWith('.ivcasatraders.online');

const EXPIRATION_PIPELINE_BG_KEY = 'atsExpirationPipelineBackgroundDiagnosticsV1';

function storageGetLocal(key) {
  return new Promise(resolve => {
    try {
      chrome.storage.local.get(key, value => {
        try { void chrome.runtime.lastError; } catch {}
        resolve(value || {});
      });
    } catch { resolve({}); }
  });
}

function storageSetLocal(value) {
  return new Promise(resolve => {
    try {
      chrome.storage.local.set(value, () => {
        try { void chrome.runtime.lastError; } catch {}
        resolve();
      });
    } catch { resolve(); }
  });
}

let expirationPipelineTelemetry = {
  version: 1,
  startedAt: Date.now(),
  messagesReceived: 0,
  discardedByTargetTabId: 0,
  untrustedRejected: 0,
  lastAt: 0,
  lastKind: '',
  lastTabId: null,
  lastTargetTabId: null,
  lastFrameId: 0
};
let expirationPipelineTelemetryFlushTimer = 0;
const expirationPipelineTelemetryReady = storageGetLocal(EXPIRATION_PIPELINE_BG_KEY).then(stored => {
  const previous = stored?.[EXPIRATION_PIPELINE_BG_KEY];
  if (previous?.version === 1) expirationPipelineTelemetry = { ...expirationPipelineTelemetry, ...previous };
}).catch(() => {});

function flushExpirationPipelineBackground() {
  if (expirationPipelineTelemetryFlushTimer) return;
  expirationPipelineTelemetryFlushTimer = setTimeout(() => {
    expirationPipelineTelemetryFlushTimer = 0;
    storageSetLocal({ [EXPIRATION_PIPELINE_BG_KEY]: { ...expirationPipelineTelemetry } }).catch(() => {});
  }, 500);
}

function recordExpirationPipelineBackground(kind, details = {}) {
  expirationPipelineTelemetryReady.then(() => {
    const now = Date.now();
    if (kind === 'received') expirationPipelineTelemetry.messagesReceived = Number(expirationPipelineTelemetry.messagesReceived || 0) + 1;
    if (kind === 'targetTabDiscard') expirationPipelineTelemetry.discardedByTargetTabId = Number(expirationPipelineTelemetry.discardedByTargetTabId || 0) + 1;
    if (kind === 'untrusted') expirationPipelineTelemetry.untrustedRejected = Number(expirationPipelineTelemetry.untrustedRejected || 0) + 1;
    expirationPipelineTelemetry.lastAt = now;
    expirationPipelineTelemetry.lastKind = kind;
    expirationPipelineTelemetry.lastTabId = Number(details.tabId || 0) || null;
    expirationPipelineTelemetry.lastTargetTabId = Number(details.targetTabId || 0) || null;
    expirationPipelineTelemetry.lastFrameId = Number(details.frameId || 0);
    flushExpirationPipelineBackground();
  }).catch(() => {});
}

function trusted(sender = {}) {
  let frameHost = '', topHost = '';
  try { frameHost = new URL(sender.url || '').hostname.toLowerCase(); } catch {}
  if (!frameHost) { try { frameHost = new URL(sender.origin || '').hostname.toLowerCase(); } catch {} }
  try { topHost = new URL(sender.tab?.url || '').hostname.toLowerCase(); } catch {}
  const tabOwned = !!sender.tab?.id && (casaHost(topHost) || traderHost(topHost));
  const knownFrame = casaHost(frameHost) || traderHost(frameHost);
  const opaqueChild = tabOwned && Number(sender.frameId) > 0 && (!frameHost || frameHost === 'null');
  // match_origin_as_fallback can inject our own content script into an opaque
  // CasaTrade child frame. That trusted extension sender is allowed to report
  // only platform controls; ordinary web pages still cannot call this handler.
  return tabOwned && (knownFrame || opaqueChild);
}

function normExp(value = '') {
  const s = clean(value).toLowerCase().replace(/\s+/g, '');
  if (!s || s === 'auto') return null;
  let m = s.match(/^(\d{1,5})(?:s|seg|segundo|segundos)$/); if (m) return `${Number(m[1])}s`;
  m = s.match(/^(\d{1,4})(?:m|min|minuto|minutos)$/); if (m) return `${Number(m[1]) * 60}s`;
  m = s.match(/^(\d{1,3}):(\d{2})$/); if (m) return `${Number(m[1]) * 60 + Number(m[2])}s`;
  return null;
}

function normTf(value = '') {
  const s = clean(value).toUpperCase().replace(/\s+/g, '');
  let m = s.match(/^M(\d{1,4})$/) || s.match(/^(\d{1,4})(?:M|MIN)$/); if (m && Number(m[1]) > 0) return `M${Number(m[1])}`;
  m = s.match(/^S(\d{1,5})$/) || s.match(/^(\d{1,5})S$/); if (m && Number(m[1]) > 0) return `S${Number(m[1])}`;
  m = s.match(/^H(\d{1,3})$/) || s.match(/^(\d{1,3})H$/); return m && Number(m[1]) > 0 ? `H${Number(m[1])}` : null;
}

function safeObserved(snapshot = {}) {
  const amount = num(snapshot.amount);
  const observedAt = Number(snapshot.observedAt || Date.now());
  const expiration = normExp(snapshot.expiration);
  const timeframe = normTf(snapshot.timeframe);
  return {
    amount: amount != null && amount > 0 ? amount : null,
    expiration,
    timeframe,
    expirationDirty: snapshot.expirationDirty === true,
    eventAt: observedAt,
    source: clean(snapshot.source || 'casatrade-ui-v2').slice(0, 64),
    observedAt: {
      amount: amount != null && amount > 0 ? observedAt : 0,
      expiration: expiration ? observedAt : 0,
      timeframe: timeframe ? observedAt : 0
    },
    confidence: {
      amount: Math.max(0, num(snapshot.confidence?.amount) || 0),
      expiration: Math.max(0, num(snapshot.confidence?.expiration) || 0),
      timeframe: Math.max(0, num(snapshot.confidence?.timeframe) || 0)
    }
  };
}

function mergeObserved(previous = {}, incoming = {}) {
  const oldConfidence = previous.confidence || {};
  const next = {
    amount: previous.amount ?? null,
    expiration: previous.expiration ?? null,
    timeframe: previous.timeframe ?? null,
    source: incoming.source || previous.source || 'casatrade-ui-v2',
    observedAt: { ...(previous.observedAt || {}) },
    confidence: { ...oldConfidence },
    expirationRecheckPendingAt: Number(previous.expirationRecheckPendingAt || 0)
  };
  if (incoming.expirationDirty === true && incoming.expiration == null) {
    // A click/open/change event only means "re-read this control". It is not
    // evidence that the previously confirmed value ceased to be real.
    // Keep the last confirmed expiration until a contradictory real reading
    // arrives; otherwise a transient DOM miss traps the UI in PENDENTE forever.
    next.expirationRecheckPendingAt = Number(incoming.eventAt || Date.now());
  }

  for (const field of ['amount', 'expiration', 'timeframe']) {
    const value = incoming[field];
    const score = Number(incoming.confidence?.[field] || 0);
    const oldScore = Number(oldConfidence[field] || 0);
    const incomingAt = Number(incoming.observedAt?.[field] || 0);
    const previousAt = Number(previous.observedAt?.[field] || 0);
    const previousStale = !previousAt || Date.now() - previousAt >= 7000;
    const newer = incomingAt > previousAt;
    const notOlder = incomingAt >= previousAt;
    if (value != null && (next[field] == null || previousStale || (newer && score >= Math.max(55, oldScore - 15)) || (notOlder && score >= oldScore - 2))) {
      next[field] = value;
      next.confidence[field] = score;
      next.observedAt[field] = incomingAt || Date.now();
      if (field === 'expiration') next.expirationRecheckPendingAt = 0;
    }
  }
  return next;
}

function analystPrefs(state = {}, message = {}) {
  const current = state.analystPreferences || {};
  return {
    ...current,
    mode: 'NORMAL',
    holdSeconds: 3,
    geminiEnabled: message.geminiEnabled == null ? current.geminiEnabled !== false : message.geminiEnabled !== false,
    preferredExpiration: null,
    updatedAt: Date.now()
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'ATS_SET_ANALYST_PREFERENCES') {
    updateScannerState(state => ({ ...state, analystPreferences: analystPrefs(state, message) }))
      .then(state => sendResponse({ ok: true, analystPreferences: state.analystPreferences }))
      .catch(error => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }

  if (message?.type === 'ATS_SET_EXECUTION_PREFERENCES') {
    const preferredExpiration = normExp(message.expiration || '');
    updateScannerState(state => ({
      ...state,
      executionPreferences: { ...(state.executionPreferences || {}), expiration: preferredExpiration },
      analystPreferences: analystPrefs(state, { preferredExpiration })
    }))
      .then(state => sendResponse({ ok: true, executionPreferences: state.executionPreferences, analystPreferences: state.analystPreferences }))
      .catch(error => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }

  if (message?.type !== 'ATS_PLATFORM_CONTROLS_OBSERVED') return false;
  const tabId = Number(sender.tab?.id || 0);
  recordExpirationPipelineBackground('received', { tabId, frameId: Number(sender.frameId || 0) });
  if (!trusted(sender)) {
    recordExpirationPipelineBackground('untrusted', { tabId, frameId: Number(sender.frameId || 0) });
    sendResponse({ ok: false, error: 'untrusted_sender' });
    return false;
  }
  const incoming = safeObserved(message.snapshot || {});

  updateScannerState(state => {
    const targetTabId = Number(state.targetTabId || 0);
    if (targetTabId && targetTabId !== tabId) {
      recordExpirationPipelineBackground('targetTabDiscard', {
        tabId,
        targetTabId,
        frameId: Number(sender.frameId || 0)
      });
      return state;
    }
    const previous = state.platformControls?.observed || {};
    const observed = mergeObserved(previous, incoming);
    const expirationAt = Number(observed.observedAt?.expiration || 0);
    const timeframeAt = Number(observed.observedAt?.timeframe || 0);
    // Expiration is a user-selected control, not a streaming tick. Once read
    // from CasaTrade it remains authoritative for the current session until a
    // contradictory reading or an explicit interaction invalidates it.
    const expirationFresh = expirationAt > 0 && !!observed.expiration;
    const timeframeFresh = timeframeAt > 0 && Date.now() - timeframeAt < 7000;
    const actualExpiration = expirationFresh ? observed.expiration || null : null;
    const actualTimeframe = timeframeFresh ? observed.timeframe || null : null;
    const preferred = normExp(state.analystPreferences?.preferredExpiration || state.executionPreferences?.expiration || '');
    const oldTf = normTf(state.analysisTimeframe || state.timeframe);
    const reliableTf = actualTimeframe && Number(observed.confidence?.timeframe || 0) >= 18 ? actualTimeframe : null;
    const timeframeChanged = !!oldTf && !!reliableTf && oldTf !== reliableTf;

    const diagnostics = { ...(state.diagnostics || {}) };
    if (timeframeChanged) {
      delete diagnostics.marketClock;
      delete diagnostics.marketSession;
    }
    const effectiveTf = reliableTf || oldTf || null;
    const m1Ready = effectiveTf === 'M1';
    const expirationValid = actualExpiration === '60s';
    diagnostics.expirationGuard = {
      preferred,
      required: '60s',
      actual: actualExpiration,
      ready: !!actualExpiration && m1Ready && expirationValid,
      validForM1: m1Ready && expirationValid,
      matchesPreference: !preferred || !actualExpiration || preferred === actualExpiration,
      reason: !m1Ready
        ? 'Ajuste o timeframe da CasaTrade para M1.'
        : !actualExpiration
          ? 'Expiração real da CasaTrade ainda não confirmada.'
          : !expirationValid
            ? 'Ajuste a expiração da CasaTrade para 1 minuto'
            : 'Expiração ao vivo de 1 minuto confirmada pela CasaTrade.',
      at: Date.now()
    };
    diagnostics.platformTime = {
      timeframe: effectiveTf,
      expiration: actualExpiration,
      source: observed.source,
      ready: m1Ready && expirationValid,
      at: Date.now()
    };

    return {
      ...state,
      ...(reliableTf ? { timeframe: reliableTf, analysisTimeframe: reliableTf } : {}),
      ...(actualExpiration ? { expiration: actualExpiration, targetExpiration: actualExpiration } : {}),
      ...(timeframeChanged ? {
        price: null,
        candles: [],
        currentCandle: null,
        marketHistory: {},
        signal: null,
        professionalDecision: null,
        aiAudit: null,
        lastConfirmed: null,
        tradeIntent: null
      } : {}),
      platformControls: {
        observed,
        checkedAt: Date.now(),
        expirationCheckedAt: expirationAt,
        timeframeCheckedAt: timeframeAt,
        frameId: Number(sender.frameId || 0),
        source: observed.source,
        aligned: (reliableTf || oldTf) === 'M1' && actualExpiration === '60s',
        liveAuthority: true
      },
      diagnostics
    };
  }).then(state => sendResponse({
    ok: true,
    platformControls: state.platformControls,
    expirationGuard: state.diagnostics?.expirationGuard || null,
    analystPreferences: state.analystPreferences || null
  })).catch(error => sendResponse({ ok: false, error: String(error?.message || error) }));
  return true;
});
