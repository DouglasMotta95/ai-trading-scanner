import { updateScannerState } from './services/scanner-state-atomic.js';
import { getThresholds, getOperationMode } from './core/analysis.js';
import { clearUserDeclaredExpirationState } from './background-market-session.js';

const clean = value => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
const num = value => value == null || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null;
const casaHost = value => value === 'casatrade.com' || value.endsWith('.casatrade.com') || value === 'casatrade.io' || value.endsWith('.casatrade.io');
const traderHost = value => value === 'casatraders.online' || value.endsWith('.casatraders.online') || value === 'ivcasatraders.online' || value.endsWith('.ivcasatraders.online');

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

function mergeObserved(previous = {}, incoming = {}, previousExpirationSource = '') {
  const oldConfidence = previous.confidence || {};
  const next = {
    amount: previous.amount ?? null,
    expiration: previous.expiration ?? null,
    timeframe: previous.timeframe ?? null,
    source: incoming.source || previous.source || 'casatrade-ui-v2',
    observedAt: { ...(previous.observedAt || {}) },
    confidence: { ...oldConfidence }
  };
  for (const field of ['amount', 'expiration', 'timeframe']) {
    const value = incoming[field];
    const score = Number(incoming.confidence?.[field] || 0);
    const oldScore = Number(oldConfidence[field] || 0);
    const incomingAt = Number(incoming.observedAt?.[field] || 0);
    const previousAt = Number(previous.observedAt?.[field] || 0);
    const previousStale = !previousAt || Date.now() - previousAt >= 7000;
    const newer = incomingAt > previousAt;
    const notOlder = incomingAt >= previousAt;
    const realOverridesDeclared = field === 'expiration'
      && previousExpirationSource === 'user-declared'
      && clean(incoming.source) !== 'user-declared';
    if (value != null && (realOverridesDeclared || next[field] == null || previousStale || (newer && score >= Math.max(55, oldScore - 15)) || (notOlder && score >= oldScore - 2))) {
      next[field] = value;
      next.confidence[field] = score;
      next.observedAt[field] = incomingAt || Date.now();
    }
  }
  return next;
}

const USER_DECLARED_EXPIRATIONS = new Set(['5s','15s','30s','60s','300s']);
const USER_DECLARED_FRESH_OFFSET_MS = 10 * 365 * 24 * 60 * 60 * 1000;

function expLabel(value = '') {
  const exp = normExp(value);
  if (!exp) return '—';
  const seconds = Number(exp.replace(/\D/g, ''));
  return seconds % 60 === 0 ? `${seconds / 60} min` : `${seconds} seg`;
}

function expirationContext(state = {}, observed = {}, expirationSource = '') {
  const now = Date.now();
  const declared = normExp(state.platformControls?.userDeclaredExpiration || '');
  let realExpiration = normExp(state.platformControls?.realExpiration || '');
  let realExpirationAt = Number(state.platformControls?.realExpirationAt || 0);
  let realExpirationSource = clean(state.platformControls?.realExpirationSource || '');

  const observedAt = Number(observed.observedAt?.expiration || 0);
  const observedExpiration = normExp(observed.expiration || '');
  const observedSource = clean(expirationSource || state.platformControls?.expirationSource || observed.source || '');
  const observedIsReal = observedExpiration
    && observedSource
    && observedSource !== 'user-declared'
    && observedAt > 0
    && now - observedAt < 7000;

  if (observedIsReal) {
    realExpiration = observedExpiration;
    realExpirationAt = observedAt;
    realExpirationSource = observedSource;
  }

  const realFresh = !!realExpiration && realExpirationAt > 0 && now - realExpirationAt < 7000;
  const divergence = !!(realFresh && declared && realExpiration !== declared);
  const actual = realFresh ? realExpiration : declared || null;
  const source = realFresh ? (realExpirationSource || 'real') : declared ? 'user-declared' : null;

  return {
    declared,
    realExpiration: realFresh ? realExpiration : null,
    realExpirationAt: realFresh ? realExpirationAt : 0,
    realExpirationSource: realFresh ? (realExpirationSource || 'real') : '',
    realFresh,
    divergence,
    actual,
    source
  };
}

function applyExpirationAuthority(state = {}, observedInput = {}, expirationSource = '') {
  const now = Date.now();
  const authority = expirationContext(state, observedInput, expirationSource);
  const observed = {
    ...observedInput,
    observedAt: { ...(observedInput.observedAt || {}) },
    confidence: { ...(observedInput.confidence || {}) }
  };

  let storedExpirationSource = authority.source || clean(expirationSource || observed.source || '');
  let expirationCheckedAt = Number(observed.observedAt?.expiration || 0);

  if (authority.divergence) {
    observed.expiration = null;
    observed.observedAt.expiration = 0;
    observed.confidence.expiration = 0;
    expirationCheckedAt = 0;
  } else if (!authority.realFresh && authority.declared) {
    const declaredAt = now + USER_DECLARED_FRESH_OFFSET_MS;
    observed.expiration = authority.declared;
    observed.observedAt.expiration = declaredAt;
    observed.confidence.expiration = 0;
    observed.source = 'user-declared';
    storedExpirationSource = 'user-declared';
    expirationCheckedAt = declaredAt;
  } else if (authority.realFresh) {
    observed.expiration = authority.realExpiration;
    observed.observedAt.expiration = authority.realExpirationAt;
    storedExpirationSource = authority.realExpirationSource;
    expirationCheckedAt = authority.realExpirationAt;
  }

  const actualTimeframeAt = Number(observed.observedAt?.timeframe || 0);
  const actualTimeframe = actualTimeframeAt > 0 && now - actualTimeframeAt < 7000
    ? normTf(observed.timeframe)
    : null;
  const oldTf = normTf(state.analysisTimeframe || state.timeframe);
  const reliableTf = actualTimeframe && Number(observed.confidence?.timeframe || 0) >= 18 ? actualTimeframe : null;
  const clockTf = normTf(state.diagnostics?.marketClock?.timeframe);
  const sessionTf = normTf(state.diagnostics?.marketSession?.timeframe);
  const effectiveTf = clockTf || sessionTf || reliableTf || oldTf || null;
  const operationMode = getOperationMode(state.analystPreferences?.operationMode || 'M1');
  const modeReady = effectiveTf === operationMode.timeframe;
  const expirationValid = authority.actual === operationMode.expiration;
  const ready = !!authority.actual && modeReady && expirationValid && !authority.divergence;
  const preferred = normExp(state.analystPreferences?.preferredExpiration || state.executionPreferences?.expiration || '');
  const expirationLabel = operationMode.expiration === '300s' ? '5 minutos' : '1 minuto';

  const reason = authority.divergence
    ? `Divergência de expiração: CasaTrade confirmou ${expLabel(authority.realExpiration)}, mas você informou ${expLabel(authority.declared)}. Ajuste antes de entrar.`
    : !modeReady
      ? `Ajuste o timeframe da CasaTrade para ${operationMode.timeframe}.`
      : !authority.actual
        ? 'Expiração real da CasaTrade ainda não confirmada.'
        : !expirationValid
          ? `Ajuste a expiração da CasaTrade para ${expirationLabel}`
          : authority.source === 'user-declared'
            ? `Expiração de ${expirationLabel} informada por você, não verificada.`
            : `Expiração ao vivo de ${expirationLabel} confirmada pela CasaTrade.`;

  const diagnostics = { ...(state.diagnostics || {}) };
  diagnostics.expirationGuard = {
    ...(diagnostics.expirationGuard || {}),
    preferred,
    required: operationMode.expiration,
    actual: authority.actual,
    source: authority.source,
    verified: authority.realFresh,
    userDeclared: authority.declared,
    real: authority.realExpiration,
    divergence: authority.divergence,
    label: authority.source === 'user-declared' ? 'informada por você, não verificada' : authority.source ? 'confirmada pela CasaTrade' : 'pendente',
    ready,
    validForM1: operationMode.timeframe === 'M1' ? ready : false,
    validForMode: ready,
    operationMode: operationMode.timeframe,
    matchesPreference: !preferred || !authority.actual || preferred === authority.actual,
    reason,
    at: now
  };
  diagnostics.platformTime = {
    ...(diagnostics.platformTime || {}),
    timeframe: effectiveTf,
    expiration: authority.actual,
    source: authority.source,
    ready,
    at: now
  };

  return {
    observed,
    diagnostics,
    authority,
    effectiveTf,
    reliableTf,
    expirationCheckedAt,
    timeframeCheckedAt: actualTimeframeAt,
    expirationSource: storedExpirationSource,
    ready
  };
}

function analystPrefs(state = {}, message = {}) {
  const current = state.analystPreferences || {};
  const thresholds = getThresholds(message.sensitivityProfile ?? current.sensitivityProfile ?? 'MEDIO');
  const operationMode = getOperationMode(message.operationMode ?? current.operationMode ?? 'M1');
  return {
    ...current,
    mode: 'NORMAL',
    operationMode: operationMode.timeframe,
    operationExpiration: operationMode.expiration,
    operationDurationSeconds: operationMode.durationSeconds,
    sensitivityProfile: thresholds.profile,
    sensitivityLabel: thresholds.label,
    holdSeconds: thresholds.holdSeconds,
    geminiEnabled: message.geminiEnabled == null ? current.geminiEnabled !== false : message.geminiEnabled !== false,
    preferredExpiration: null,
    updatedAt: Date.now()
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'ATS_SET_ANALYST_PREFERENCES') {
    updateScannerState(state => {
      const currentMode = getOperationMode(state.analystPreferences?.operationMode || 'M1');
      const nextPreferences = analystPrefs(state, message);
      const nextMode = getOperationMode(nextPreferences.operationMode);
      const base = currentMode.timeframe !== nextMode.timeframe
        ? clearUserDeclaredExpirationState(state)
        : state;
      return { ...base, analystPreferences: analystPrefs(base, message) };
    })
      .then(state => sendResponse({ ok: true, analystPreferences: state.analystPreferences, state }))
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

  if (message?.type === 'ATS_SET_USER_DECLARED_EXPIRATION') {
    const declared = normExp(message.expiration || '');
    if (!USER_DECLARED_EXPIRATIONS.has(declared)) {
      sendResponse({ ok: false, error: 'invalid_user_declared_expiration' });
      return false;
    }

    updateScannerState(state => {
      const now = Date.now();
      const previousControls = state.platformControls || {};
      const previousObserved = previousControls.observed || {};
      const currentSource = clean(previousControls.expirationSource || previousObserved.source || '');
      const seededState = {
        ...state,
        platformControls: {
          ...previousControls,
          userDeclaredExpiration: declared,
          userDeclaredAt: now
        }
      };
      const resolved = applyExpirationAuthority(seededState, previousObserved, currentSource);

      return {
        ...seededState,
        expiration: resolved.authority.divergence ? null : resolved.authority.actual,
        targetExpiration: resolved.authority.divergence ? null : resolved.authority.actual,
        platformControls: {
          ...seededState.platformControls,
          observed: resolved.observed,
          checkedAt: now,
          expirationCheckedAt: resolved.expirationCheckedAt,
          timeframeCheckedAt: resolved.timeframeCheckedAt,
          source: resolved.authority.source,
          expirationSource: resolved.expirationSource,
          expirationVerified: resolved.authority.realFresh,
          liveAuthority: resolved.authority.realFresh,
          aligned: resolved.ready,
          realExpiration: resolved.authority.realExpiration || previousControls.realExpiration || null,
          realExpirationAt: resolved.authority.realExpirationAt || Number(previousControls.realExpirationAt || 0),
          realExpirationSource: resolved.authority.realExpirationSource || clean(previousControls.realExpirationSource || '')
        },
        diagnostics: resolved.diagnostics
      };
    }).then(state => sendResponse({
      ok: true,
      state,
      expirationGuard: state.diagnostics?.expirationGuard || null
    })).catch(error => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }

  if (message?.type !== 'ATS_PLATFORM_CONTROLS_OBSERVED') return false;
  if (!trusted(sender)) { sendResponse({ ok: false, error: 'untrusted_sender' }); return false; }
  const tabId = Number(sender.tab?.id || 0);
  const incoming = safeObserved(message.snapshot || {});

  updateScannerState(state => {
    if (Number(state.targetTabId || 0) && Number(state.targetTabId) !== tabId) return state;

    const previousControls = state.platformControls || {};
    const previous = previousControls.observed || {};
    const previousExpirationSource = clean(previousControls.expirationSource || previous.source || '');
    const observedRaw = mergeObserved(previous, incoming, previousExpirationSource);

    let realExpiration = normExp(previousControls.realExpiration || '');
    let realExpirationAt = Number(previousControls.realExpirationAt || 0);
    let realExpirationSource = clean(previousControls.realExpirationSource || '');

    if (incoming.expiration && clean(incoming.source) !== 'user-declared') {
      realExpiration = incoming.expiration;
      realExpirationAt = Number(incoming.observedAt?.expiration || Date.now());
      realExpirationSource = clean(incoming.source || 'real');
    }

    const seededState = {
      ...state,
      platformControls: {
        ...previousControls,
        realExpiration,
        realExpirationAt,
        realExpirationSource
      }
    };

    const incomingExpirationSource = incoming.expiration && clean(incoming.source) !== 'user-declared'
      ? clean(incoming.source)
      : previousExpirationSource;
    const resolved = applyExpirationAuthority(seededState, observedRaw, incomingExpirationSource);

    const oldTf = normTf(state.analysisTimeframe || state.timeframe);
    const timeframeChanged = !!oldTf && !!resolved.reliableTf && oldTf !== resolved.reliableTf;
    if (timeframeChanged) {
      resolved.diagnostics.timeframeTransition = {
        from: oldTf,
        to: resolved.reliableTf,
        at: Date.now(),
        source: observedRaw.source
      };
    }

    return {
      ...seededState,
      expiration: resolved.authority.divergence ? null : resolved.authority.actual,
      targetExpiration: resolved.authority.divergence ? null : resolved.authority.actual,
      platformControls: {
        ...seededState.platformControls,
        observed: resolved.observed,
        checkedAt: Date.now(),
        expirationCheckedAt: resolved.expirationCheckedAt,
        timeframeCheckedAt: resolved.timeframeCheckedAt,
        frameId: Number(sender.frameId || 0),
        source: resolved.authority.source,
        expirationSource: resolved.expirationSource,
        expirationVerified: resolved.authority.realFresh,
        liveAuthority: resolved.authority.realFresh,
        aligned: resolved.ready,
        realExpiration: resolved.authority.realExpiration || realExpiration || null,
        realExpirationAt: resolved.authority.realExpirationAt || realExpirationAt || 0,
        realExpirationSource: resolved.authority.realExpirationSource || realExpirationSource || ''
      },
      diagnostics: resolved.diagnostics
    };
  }).then(state => sendResponse({
    ok: true,
    platformControls: state.platformControls,
    expirationGuard: state.diagnostics?.expirationGuard || null,
    analystPreferences: state.analystPreferences || null
  })).catch(error => sendResponse({ ok: false, error: String(error?.message || error) }));
  return true;
});
