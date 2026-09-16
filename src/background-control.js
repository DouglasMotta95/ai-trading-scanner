import { activateLicense, validateLicense, clearLicense, restoreCachedLicense } from './services/license.js';
import { readScannerState, updateScannerState } from './services/scanner-state-atomic.js';
import { storageLocalGet, storageSessionGet, tabsQuery, sidePanelSetBehavior } from './services/chrome-compat.js';
import { detectPlatform } from './platforms/registry.js';

const DEFAULT_LICENSE = Object.freeze({
  status: 'unconfigured', plan: null, planLabel: null, dailyLimit: null, usedToday: 0,
  remainingToday: null, totalLimit: null, usedTotal: 0, remainingTotal: null, error: null
});
const SESSION_HISTORY_KEY = 'atsSessionSignalHistory';
const SHADOW_KEY = 'atsShadowCalibrationV1';
const EXACT_CLOCK_SOURCES = new Set(['trader-dom-countdown', 'network-server-cycle']);

const activeLicense = license => ['active', 'valid'].includes(String(license?.status || '').toLowerCase());
const clean = value => String(value ?? '').trim();
const sameAsset = (a, b) => clean(a).toUpperCase().replace(/\s*\(\s*OTC\s*\)\s*$/i, '') === clean(b).toUpperCase().replace(/\s*\(\s*OTC\s*\)\s*$/i, '') && !!clean(a) && !!clean(b);

function platformFromUrl(url = '') {
  try { return detectPlatform(new URL(url).hostname); } catch { return null; }
}

function clearMarket(state = {}, extra = {}) {
  return {
    ...state,
    scanner: 'idle',
    connection: 'offline', platformId: null, platformName: null, targetTabId: null,
    asset: null, price: null, timeframe: null, analysisTimeframe: null,
    expiration: null, targetExpiration: null, serverTime: null,
    candles: [], currentCandle: null, marketHistory: {}, signal: null,
    professionalDecision: null, aiAudit: null,
    tradeIntent: null, lastConfirmed: null, lastSeen: null,
    platformControls: null,
    diagnostics: { ...(extra.diagnostics || {}) },
    ...extra,
    license: extra.license || state.license || DEFAULT_LICENSE
  };
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

async function connectActiveTab() {
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
    const sameTab = Number(current.targetTabId) === Number(tab.id);
    const focus = current.diagnostics?.focusedAsset || null;
    const focusFresh = Number(focus?.at || 0) > 0 && Date.now() - Number(focus.at) < 2500;
    const dataFresh = Number(current.lastSeen || 0) > 0 && Date.now() - Number(current.lastSeen) < 2500;
    const preserveLive = sameTab && current.connection === 'online' && focusFresh && dataFresh
      && focus?.reliable === true && focus?.trustedChartFrame === true;
    const diagnostics = { ...(current.diagnostics || {}) };
    if (!preserveLive) {
      delete diagnostics.focusedAsset;
      delete diagnostics.marketClock;
      delete diagnostics.marketSession;
    }
    return {
      ...current,
      license,
      platformId: platform.id,
      platformName: platform.name,
      targetTabId: tab.id,
      scanner: 'scanning',
      connection: preserveLive ? 'online' : 'connecting',
      ...(!preserveLive ? {
        asset: null, price: null, timeframe: null, analysisTimeframe: null,
        expiration: null, targetExpiration: null, candles: [], currentCandle: null, marketHistory: {},
        signal: null, professionalDecision: null, aiAudit: null,
        lastConfirmed: null, tradeIntent: null, lastSeen: null, platformControls: null
      } : {}),
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
  });

  await injectModern(tab.id);
  return { ok: true, platform: { id: platform.id, name: platform.name }, tabId: tab.id, state: await readScannerState() || next };
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

function exactTradeReady(state = {}) {
  const clock = state.diagnostics?.marketClock || {};
  const focus = state.diagnostics?.focusedAsset || {};
  const professional = state.professionalDecision || {};
  const actualExpiration = clean(state.platformControls?.observed?.expiration || '');
  const controlsFresh = Number(state.platformControls?.checkedAt || 0) > 0 && Date.now() - Number(state.platformControls.checkedAt) < 7000;
  if (professional.timeReady !== true || professional.expirationReady !== true || professional.actionable !== true) return false;
  if (clock.verified !== true || clock.available === false || clock.role !== 'candle-close' || !EXACT_CLOCK_SOURCES.has(clean(clock.source))) return false;
  if (Date.now() - Number(clock.at || 0) >= 3000) return false;
  if (!sameAsset(clock.asset, state.asset) || !sameAsset(focus.asset, state.asset)) return false;
  if (Number(clock.frameId) !== Number(focus.frameId)) return false;
  if (clean(clock.frameHost).toLowerCase() !== clean(focus.frameHost).toLowerCase()) return false;
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
  const next = await updateScannerState(current => ({
    ...current,
    scanner: enabled ? 'scanning' : 'idle',
    ...(enabled ? {} : { signal: null, professionalDecision: null, tradeIntent: null })
  }));
  return { ok: true, state: next };
}

sidePanelSetBehavior({ openPanelOnActionClick: true }).catch(() => {});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const type = String(message?.type || '');

  if (type === 'ATS_CONNECT_ACTIVE_TAB' || type === 'ATS_REFRESH_MARKET') {
    connectActiveTab().then(sendResponse).catch(error => sendResponse({ ok: false, error: String(error?.message || error) }));
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
