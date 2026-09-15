import { updateScannerState } from './services/scanner-state-atomic.js';

const clean = value => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
const num = value => value == null || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null;
const casaHost = value => value === 'casatrade.com' || value.endsWith('.casatrade.com') || value === 'casatrade.io' || value.endsWith('.casatrade.io');
const traderHost = value => value === 'casatraders.online' || value.endsWith('.casatraders.online') || value === 'ivcasatraders.online' || value.endsWith('.ivcasatraders.online');

function trusted(sender = {}) {
  let frameHost = '', topHost = '';
  try { frameHost = new URL(sender.url || '').hostname.toLowerCase(); } catch {}
  try { topHost = new URL(sender.tab?.url || '').hostname.toLowerCase(); } catch {}
  return !!sender.tab?.id && casaHost(topHost) && (casaHost(frameHost) || traderHost(frameHost));
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
  return {
    amount: amount != null && amount > 0 ? amount : null,
    expiration: normExp(snapshot.expiration),
    timeframe: normTf(snapshot.timeframe),
    source: clean(snapshot.source || 'casatrade-ui-v2').slice(0, 64),
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
    confidence: { ...oldConfidence }
  };
  for (const field of ['amount', 'expiration', 'timeframe']) {
    const value = incoming[field];
    const score = Number(incoming.confidence?.[field] || 0);
    const oldScore = Number(oldConfidence[field] || 0);
    if (value != null && (next[field] == null || score >= oldScore - 2)) {
      next[field] = value;
      next.confidence[field] = score;
    }
  }
  return next;
}

function analystPrefs(state = {}, message = {}) {
  const current = state.analystPreferences || {};
  const mode = String(message.mode ?? current.mode ?? 'NORMAL').toUpperCase() === 'A_PLUS' ? 'A_PLUS' : 'NORMAL';
  const holdSeconds = Math.max(3, Math.min(5, Number(message.holdSeconds ?? current.holdSeconds ?? 3) || 3));
  const preferredExpiration = message.preferredExpiration === null || String(message.preferredExpiration || '').toUpperCase() === 'AUTO'
    ? null
    : normExp(message.preferredExpiration ?? current.preferredExpiration ?? state.executionPreferences?.expiration ?? '');
  return {
    ...current,
    mode,
    holdSeconds,
    geminiEnabled: message.geminiEnabled == null ? current.geminiEnabled !== false : message.geminiEnabled !== false,
    preferredExpiration,
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
    // Backwards-compatible preference channel. It is deliberately NOT a live-time
    // authority: CasaTrade's observed expiration always remains authoritative.
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
  if (!trusted(sender)) { sendResponse({ ok: false, error: 'untrusted_sender' }); return false; }
  const tabId = Number(sender.tab?.id || 0);
  const incoming = safeObserved(message.snapshot || {});

  updateScannerState(state => {
    if (Number(state.targetTabId || 0) && Number(state.targetTabId) !== tabId) return state;
    const previous = state.platformControls?.observed || {};
    const observed = mergeObserved(previous, incoming);
    const actualExpiration = observed.expiration || null;
    const actualTimeframe = observed.timeframe || null;
    const preferred = normExp(state.analystPreferences?.preferredExpiration || state.executionPreferences?.expiration || '');
    const oldTf = normTf(state.analysisTimeframe || state.timeframe);
    const reliableTf = actualTimeframe && Number(observed.confidence?.timeframe || 0) >= 18 ? actualTimeframe : null;
    const timeframeChanged = !!oldTf && !!reliableTf && oldTf !== reliableTf;

    const diagnostics = { ...(state.diagnostics || {}) };
    if (timeframeChanged) {
      delete diagnostics.marketClock;
      delete diagnostics.marketSession;
    }
    diagnostics.expirationGuard = {
      preferred,
      actual: actualExpiration,
      ready: !!actualExpiration,
      matchesPreference: !preferred || !actualExpiration || preferred === actualExpiration,
      reason: !actualExpiration
        ? 'Expiração real da CasaTrade ainda não confirmada.'
        : preferred && preferred !== actualExpiration
          ? `CasaTrade em ${actualExpiration}; preferência salva ${preferred}. O tempo ao vivo da CasaTrade prevalece.`
          : 'Expiração ao vivo confirmada pela CasaTrade.',
      at: Date.now()
    };
    diagnostics.platformTime = {
      timeframe: reliableTf || oldTf || null,
      expiration: actualExpiration,
      source: observed.source,
      ready: !!(reliableTf || oldTf) && !!actualExpiration,
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
        frameId: Number(sender.frameId || 0),
        source: observed.source,
        aligned: !!(reliableTf || oldTf) && !!actualExpiration,
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
