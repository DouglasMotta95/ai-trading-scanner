import { processSnapshot, resetOrchestrator } from './core/orchestrator.js';
import { detectPlatform } from './platforms/registry.js';
import { activateLicense, validateLicense, consumeSignal, clearLicense, licenseRequired } from './services/license.js';
import { heartbeat, track } from './services/telemetry.js';

const SESSION_HISTORY_KEY = 'atsSessionSignalHistory';
const DEFAULT_LICENSE = {
  status: 'unconfigured', plan: null, planLabel: null, dailyLimit: null, usedToday: 0,
  remainingToday: null, totalLimit: null, usedTotal: 0, remainingTotal: null, error: null
};
const EMPTY_MARKET = {
  connection: 'offline', platformId: null, platformName: null, targetTabId: null,
  asset: null, marketType: 'unknown', instrumentType: 'unknown', timeframe: null,
  analysisTimeframe: null, expiration: null, targetExpiration: null, price: null,
  serverTime: null, capabilities: { structuredQuotes: false, candles: false, expiration: false, multiAsset: false },
  diagnostics: {}, marketCatalog: { assets: [], timeframes: [], expirations: [], lines: [] },
  marketHistory: {}, platformControls: null, signal: null, tradeIntent: null, lastSeen: null,
  telemetry: { feedQuality: 0, latency: null, lastSync: null }
};
const DEFAULT_STATE = { ...EMPTY_MARKET, scanner: 'idle', license: DEFAULT_LICENSE };

let lastLicenseCheck = 0;
let lastHeartbeatAt = 0;
const clean = v => String(v ?? '').trim();
const uniq = a => [...new Set(a.filter(Boolean))];
const num = v => v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null;
const sameTarget = (s, sender) => !s?.targetTabId || !sender?.tab?.id || s.targetTabId === sender.tab.id;
const platformFromUrl = u => { try { return detectPlatform(new URL(u).hostname); } catch { return null; } };

const merge = (state = {}, snapshot = {}) => ({
  ...DEFAULT_STATE, ...state, ...snapshot,
  license: { ...DEFAULT_LICENSE, ...(state.license || {}), ...(snapshot.license || {}) },
  capabilities: { ...DEFAULT_STATE.capabilities, ...(state.capabilities || {}), ...(snapshot.capabilities || {}) },
  diagnostics: { ...(state.diagnostics || {}), ...(snapshot.diagnostics || {}) },
  telemetry: { ...DEFAULT_STATE.telemetry, ...(state.telemetry || {}), ...(snapshot.telemetry || {}) }
});
const marketCleared = (state = {}, patch = {}) => ({
  ...state, ...EMPTY_MARKET, scanner: 'idle', license: state.license || DEFAULT_LICENSE, ...patch
});

function configuredPrefs(p = {}) {
  const amount = num(p.tradeAmount ?? p.stake);
  return amount != null && amount > 0 && p.timeframe && p.timeframe !== 'AUTO' && p.expiration && p.expiration !== 'AUTO';
}

function catalogFrom(candidates = [], prefs = {}) {
  const lines = [], seen = new Set();
  for (const c of candidates) {
    const asset = clean(c?.asset);
    if (!asset) continue;
    const key = `${asset}|${clean(c.timeframe)}|${clean(c.expiration)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push({
      asset, price: num(c.price), bid: num(c.bid), ask: num(c.ask), payout: num(c.payout),
      timeframe: clean(c.timeframe) || null, expiration: clean(c.expiration) || null,
      transport: clean(c.transport) || null, source: clean(c.source) || 'observed'
    });
  }
  const timeframes = uniq(lines.map(x => x.timeframe));
  const expirations = uniq(lines.map(x => x.expiration));
  if (prefs.timeframe && prefs.timeframe !== 'AUTO' && !timeframes.includes(prefs.timeframe)) timeframes.unshift(prefs.timeframe);
  if (prefs.expiration && prefs.expiration !== 'AUTO' && !expirations.includes(prefs.expiration)) expirations.unshift(prefs.expiration);
  return { assets: uniq(lines.map(x => x.asset)).sort(), timeframes, expirations, lines: lines.slice(0, 180) };
}

function licenseError(r) {
  const error = r?.error || 'license_required';
  const status = error === 'license_expired' ? 'expired'
    : error === 'daily_limit_reached' || error === 'trial_limit_reached' ? 'limit'
      : error === 'device_locked' || error === 'device_limit_reached' ? 'device_locked' : 'inactive';
  return { status, error };
}

async function syncLicense(settings = {}, state = {}, force = false) {
  if (!force && state.license?.status === 'active' && Date.now() - lastLicenseCheck < 30000) return state.license;
  const r = await validateLicense(settings);
  lastLicenseCheck = Date.now();
  return r.ok ? { ...r.license, error: r.license?.error || null } : { ...DEFAULT_LICENSE, ...licenseError(r), ...(r.license || {}) };
}

function feedQuality(state = {}) {
  if (state.connection !== 'online' || state.price == null) return 0;
  const reported = Number(state.diagnostics?.network?.feedQuality);
  if (Number.isFinite(reported) && reported > 0) return Math.max(0, Math.min(100, reported));
  if (state.capabilities?.structuredQuotes) return 100;
  const net = state.diagnostics?.network || {};
  const ws = Number(net.connections?.ws) || 0;
  const assets = state.marketCatalog?.assets?.length || Number(net.candidateCount) || 0;
  if (ws && assets) return 72;
  if (assets) return 58;
  return state.price != null ? 42 : 0;
}
function latencyOf(state = {}) {
  const t = Number(state.serverTime);
  if (!Number.isFinite(t) || t <= 1e12) return null;
  const delta = Math.abs(Date.now() - t);
  return delta < 600000 ? delta : null;
}
async function telemetryHeartbeat(state, settings, force = false) {
  if (!force && Date.now() - lastHeartbeatAt < 5000) return;
  lastHeartbeatAt = Date.now();
  await heartbeat(state, settings).catch(() => {});
}
const telemetryEvent = async (type, data, settings) => { await track(type, data, settings).catch(() => {}); };
const telemetryState = state => merge(state, { telemetry: { feedQuality: feedQuality(state), latency: latencyOf(state), lastSync: Date.now() } });

function localSignalRecord(state) {
  const s = state.signal || {};
  return {
    id: crypto.randomUUID(), at: Date.now(), asset: state.asset || '—', platform: 'CasaTrade', direction: s.direction,
    timeframe: state.analysisTimeframe || s.timeframe || state.timeframe || null,
    expiration: state.targetExpiration || s.targetExpiration || state.expiration || null,
    entryPrice: num(state.price), status: 'confirmed'
  };
}
async function appendSessionHistory(record) {
  const stored = await chrome.storage.session.get(SESSION_HISTORY_KEY);
  const rows = Array.isArray(stored[SESSION_HISTORY_KEY]) ? stored[SESSION_HISTORY_KEY] : [];
  await chrome.storage.session.set({ [SESSION_HISTORY_KEY]: [record, ...rows].slice(0, 50) });
}

async function activeCasaTradeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url) return { tab: null, platform: null };
  return { tab, platform: platformFromUrl(tab.url) };
}
async function ensureSupportedActiveTab(scannerState = {}) {
  const { tab, platform } = await activeCasaTradeTab();
  if (tab?.id && platform) return { scannerState, tab, platform };
  const cleared = marketCleared(scannerState, {
    diagnostics: { unsupportedHost: (() => { try { return new URL(tab?.url || '').hostname || null; } catch { return null; } })() }
  });
  await chrome.storage.local.set({ scannerState: cleared });
  return { scannerState: cleared, tab, platform: null };
}

async function connectActiveTab() {
  const { tab, platform } = await activeCasaTradeTab();
  const { scannerState = {} } = await chrome.storage.local.get('scannerState');
  if (!tab?.id || !tab.url || !platform) {
    const next = marketCleared(scannerState, {
      diagnostics: { unsupportedHost: (() => { try { return new URL(tab?.url || '').hostname || null; } catch { return null; } })() }
    });
    await chrome.storage.local.set({ scannerState: next });
    return { ok: false, error: 'platform_not_registered' };
  }
  const scripts = [
    ['src/content/network-probe.js', 'MAIN'],
    ['src/content/network-bridge.js', 'ISOLATED'],
    ['src/content/generic-adapter.js', 'ISOLATED'],
    ['src/content/platform-sync.js', 'ISOLATED']
  ];
  for (const [file, world] of scripts) await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: [file], world }).catch(() => {});
  const next = merge(scannerState, {
    connection: 'connecting', platformId: platform.id, platformName: platform.name, targetTabId: tab.id,
    asset: null, price: null, signal: null, platformControls: null,
    diagnostics: { target: { host: new URL(tab.url).hostname, tabId: tab.id, connectedAt: Date.now() } }
  });
  await chrome.storage.local.set({ scannerState: next });
  const { settings = {} } = await chrome.storage.local.get('settings');
  telemetryEvent('platform_connected', { platformId: platform.id, platformName: platform.name }, settings);
  return { ok: true, platform: { id: platform.id, name: platform.name }, tabId: tab.id };
}

async function readPlatformControls(tabId) {
  if (!tabId) return { ok: false, error: 'platform_tab_not_connected' };
  return chrome.tabs.sendMessage(tabId, { type: 'ATS_PLATFORM_READ' }).catch(() => ({ ok: false, error: 'platform_read_failed' }));
}
function controlAlignment(observed = {}, prefs = {}) {
  const amount = num(prefs.tradeAmount ?? prefs.stake);
  const amountOk = amount != null && num(observed.amount) === amount;
  const timeframeOk = clean(observed.timeframe).toUpperCase() === clean(prefs.timeframe).toUpperCase();
  const expirationOk = clean(observed.expiration).toLowerCase() === clean(prefs.expiration).toLowerCase();
  return { amountOk, timeframeOk, expirationOk, aligned: !!(amountOk && timeframeOk && expirationOk) };
}
async function syncPlatformPreferences() {
  const { scannerState = {}, settings = {} } = await chrome.storage.local.get(['scannerState', 'settings']);
  const supported = await ensureSupportedActiveTab(scannerState);
  if (!supported.platform || !supported.tab?.id) return { ok: false, error: 'platform_not_registered' };
  const prefs = settings.scanPreferences || {};
  if (!configuredPrefs(prefs)) return { ok: false, error: 'preferences_required' };
  const preferences = {
    tradeAmount: num(prefs.tradeAmount ?? prefs.stake), stake: num(prefs.tradeAmount ?? prefs.stake),
    timeframe: prefs.timeframe, expiration: prefs.expiration
  };
  const result = await chrome.tabs.sendMessage(supported.tab.id, { type: 'ATS_PLATFORM_APPLY', preferences })
    .catch(() => ({ ok: false, error: 'platform_sync_failed' }));
  const observed = result?.after || result?.observed || (await readPlatformControls(supported.tab.id))?.observed || {};
  const alignment = controlAlignment(observed, prefs);
  const latest = (await chrome.storage.local.get('scannerState')).scannerState || supported.scannerState;
  const next = merge(latest, { platformControls: { ...alignment, observed, checkedAt: Date.now() } });
  if (!alignment.aligned) next.scanner = 'idle';
  await chrome.storage.local.set({ scannerState: next });
  return { ok: !!result?.ok, ...alignment, observed };
}
async function refreshPlatformControls() {
  const { scannerState = {}, settings = {} } = await chrome.storage.local.get(['scannerState', 'settings']);
  const supported = await ensureSupportedActiveTab(scannerState);
  if (!supported.platform || !supported.tab?.id) return { ok: false, error: 'platform_not_registered' };
  const result = await readPlatformControls(supported.tab.id);
  const observed = result?.observed || {};
  const alignment = controlAlignment(observed, settings.scanPreferences || {});
  const latest = (await chrome.storage.local.get('scannerState')).scannerState || supported.scannerState;
  await chrome.storage.local.set({ scannerState: merge(latest, { platformControls: { ...alignment, observed, checkedAt: Date.now() } }) });
  return { ...result, ...alignment, observed };
}

async function prepareTrade(direction) {
  if (!['BUY', 'SELL'].includes(direction)) return { ok: false, error: 'invalid_direction' };
  const { scannerState = {}, settings = {} } = await chrome.storage.local.get(['scannerState', 'settings']);
  const supported = await ensureSupportedActiveTab(scannerState);
  if (!supported.platform || !supported.tab?.id || supported.tab.id !== scannerState.targetTabId) return { ok: false, error: 'platform_tab_not_connected' };
  const sig = scannerState.signal || {};
  if (sig.state !== 'CONFIRM' || sig.direction !== direction || sig.provisional) return { ok: false, error: 'signal_not_confirmed' };
  if (!scannerState.platformControls?.aligned) return { ok: false, error: 'platform_not_aligned' };
  const intent = {
    direction, asset: scannerState.asset || null,
    timeframe: scannerState.analysisTimeframe || scannerState.timeframe || null,
    expiration: scannerState.targetExpiration || scannerState.expiration || null,
    stake: num(settings.scanPreferences?.tradeAmount ?? settings.scanPreferences?.stake),
    createdAt: Date.now(), status: 'prepared'
  };
  await chrome.tabs.update(supported.tab.id, { active: true }).catch(() => {});
  await chrome.scripting.executeScript({ target: { tabId: supported.tab.id }, files: ['src/content/trade-handoff.js'], world: 'ISOLATED' }).catch(() => {});
  const handoff = await chrome.tabs.sendMessage(supported.tab.id, { type: 'ATS_HIGHLIGHT_TRADE', ...intent }).catch(() => ({ found: false }));
  const nextIntent = { ...intent, handoff: { found: !!handoff?.found, label: handoff?.label || null } };
  await chrome.storage.local.set({ scannerState: merge(scannerState, { tradeIntent: nextIntent }) });
  telemetryEvent('trade_handoff_prepared', { ...intent, found: !!handoff?.found }, settings);
  return { ok: true, intent: nextIntent };
}

chrome.runtime.onInstalled.addListener(async () => {
  const { scannerState, settings = {} } = await chrome.storage.local.get(['scannerState', 'settings']);
  const updates = {};
  if (!scannerState) updates.scannerState = DEFAULT_STATE;
  updates.settings = {
    ...settings,
    scanPreferences: { tradeAmount: null, stake: null, timeframe: 'AUTO', expiration: 'AUTO', ...(settings.scanPreferences || {}) }
  };
  await chrome.storage.local.set(updates);
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});
chrome.tabs?.onActivated?.addListener(async () => {
  const { scannerState = {} } = await chrome.storage.local.get('scannerState');
  await ensureSupportedActiveTab(scannerState);
});
chrome.tabs?.onUpdated?.addListener(async (tabId, changeInfo, tab) => {
  if (!changeInfo.url && !changeInfo.status) return;
  const { scannerState = {} } = await chrome.storage.local.get('scannerState');
  if (scannerState.targetTabId === tabId || tab?.active) await ensureSupportedActiveTab(scannerState);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'ATS_CONNECT_ACTIVE_TAB') {
    connectActiveTab().then(sendResponse).catch(e => sendResponse({ ok: false, error: String(e?.message || e) })); return true;
  }
  if (message?.type === 'ATS_ACTIVATE_LICENSE') {
    chrome.storage.local.get(['scannerState', 'settings']).then(async ({ scannerState, settings = {} }) => {
      const r = await activateLicense(settings, message.key); lastLicenseCheck = 0;
      const license = r.ok ? { ...r.license, error: null } : { ...DEFAULT_LICENSE, ...licenseError(r), ...(r.license || {}) };
      const next = merge(scannerState, { license }); await chrome.storage.local.set({ scannerState: next });
      if (r.ok) { await telemetryEvent('license_activated', { plan: license.plan, planLabel: license.planLabel }, settings); await telemetryHeartbeat(telemetryState(next), settings, true); }
      sendResponse({ ...r, license });
    }).catch(e => sendResponse({ ok: false, error: String(e?.message || e) })); return true;
  }
  if (message?.type === 'ATS_VALIDATE_LICENSE') {
    chrome.storage.local.get(['scannerState', 'settings']).then(async ({ scannerState, settings = {} }) => {
      const license = await syncLicense(settings, scannerState, true); const next = merge(scannerState, { license });
      await chrome.storage.local.set({ scannerState: next });
      if (license.status === 'active') telemetryHeartbeat(telemetryState(next), settings, true);
      sendResponse({ ok: license.status === 'active', license });
    }).catch(e => sendResponse({ ok: false, error: String(e?.message || e) })); return true;
  }
  if (message?.type === 'ATS_CLEAR_LICENSE') {
    chrome.storage.local.get('scannerState').then(async ({ scannerState }) => {
      await clearLicense();
      const next = merge(scannerState, { scanner: 'idle', license: DEFAULT_LICENSE, signal: null });
      await chrome.storage.local.set({ scannerState: next }); sendResponse({ ok: true });
    }); return true;
  }
  if (message?.type === 'ATS_GET_PLATFORM_CONFIG') {
    let host = message.host || ''; if (!host && sender?.url) try { host = new URL(sender.url).hostname; } catch {}
    const platform = detectPlatform(host); sendResponse({ ok: !!platform, platform: platform ? { ...platform } : null }); return;
  }
  if (message?.type === 'ATS_READ_PLATFORM_CONTROLS') {
    refreshPlatformControls().then(sendResponse).catch(e => sendResponse({ ok: false, error: String(e?.message || e) })); return true;
  }
  if (message?.type === 'ATS_SYNC_PLATFORM_PREFERENCES') {
    syncPlatformPreferences().then(sendResponse).catch(e => sendResponse({ ok: false, error: String(e?.message || e) })); return true;
  }
  if (message?.type === 'ATS_PREPARE_TRADE') {
    prepareTrade(String(message.direction || '').toUpperCase()).then(sendResponse).catch(e => sendResponse({ ok: false, error: String(e?.message || e) })); return true;
  }
  if (message?.type === 'ATS_GET_SESSION_HISTORY') {
    chrome.storage.session.get(SESSION_HISTORY_KEY).then(x => sendResponse({ ok: true, rows: Array.isArray(x[SESSION_HISTORY_KEY]) ? x[SESSION_HISTORY_KEY] : [] })); return true;
  }
  if (message?.type === 'ATS_DOM_CATALOG') {
    const p = message.payload || {};
    chrome.storage.local.get(['scannerState', 'settings']).then(async ({ scannerState = {}, settings = {} }) => {
      let host = ''; try { host = new URL(sender?.url || '').hostname; } catch {}
      if (!detectPlatform(host) || !sameTarget(scannerState, sender)) return sendResponse({ ok: true, ignored: true });
      const prefs = settings.scanPreferences || {};
      const domCatalog = { candidates: Array.isArray(p.candidates) ? p.candidates.slice(0, 180) : [], assetCount: Number(p.assetCount) || 0, timeframe: p.timeframe || null, expiration: p.expiration || null, instrumentType: p.instrumentType || 'unknown', lastSeen: Date.now() };
      const net = scannerState?.diagnostics?.network?.candidates || [];
      const marketCatalog = catalogFrom([...net, ...domCatalog.candidates], prefs);
      await chrome.storage.local.set({ scannerState: merge(scannerState, { marketCatalog, diagnostics: { ...(scannerState.diagnostics || {}), domCatalog } }) });
      sendResponse({ ok: true, catalog: marketCatalog });
    }); return true;
  }
  if (message?.type === 'ATS_NETWORK_DIAGNOSTIC') {
    const p = message.payload || {};
    chrome.storage.local.get(['scannerState', 'settings']).then(async ({ scannerState = {}, settings = {} }) => {
      let host = ''; try { host = new URL(sender?.url || '').hostname; } catch {}
      const platform = detectPlatform(host);
      if (!platform || !sameTarget(scannerState, sender)) return sendResponse({ ok: true, ignored: true });
      const prefs = settings.scanPreferences || {};
      const network = {
        messages: p.messages || {}, connections: p.connections || {}, endpoints: Array.isArray(p.endpoints) ? p.endpoints.slice(-30) : [],
        keys: Array.isArray(p.keys) ? p.keys.slice(0, 180) : [], candidates: Array.isArray(p.candidates) ? p.candidates.slice(0, 180).map(x => ({ ...x, source: 'network' })) : [],
        candidateCount: Number(p.candidateCount) || 0, recentCandles: p.recentCandles || {}, feedQuality: Number(p.feedQuality || 0),
        parser: p.parser || {}, primaryTransport: p.primaryTransport || null, lastSeen: Date.now()
      };
      const dom = scannerState?.diagnostics?.domCatalog?.candidates || [];
      const marketCatalog = catalogFrom([...network.candidates, ...dom], prefs);
      const next = merge(scannerState, { platformId: platform.id, platformName: platform.name, marketCatalog, diagnostics: { ...(scannerState.diagnostics || {}), network } });
      await chrome.storage.local.set({ scannerState: next }); sendResponse({ ok: true, catalog: marketCatalog });
    }); return true;
  }
  if (message?.type === 'ATS_PLATFORM_SNAPSHOT') {
    const snapshot = message.payload || {};
    chrome.storage.local.get(['scannerState', 'settings']).then(async ({ scannerState = {}, settings = {} }) => {
      let host = ''; try { host = new URL(sender?.url || '').hostname; } catch {}
      const platform = detectPlatform(host);
      if (!platform || !sameTarget(scannerState, sender)) return sendResponse({ ok: true, ignored: true });
      const prefs = settings.scanPreferences || {};
      const analysisTimeframe = prefs.timeframe && prefs.timeframe !== 'AUTO' ? prefs.timeframe : (snapshot.timeframe || null);
      const targetExpiration = prefs.expiration && prefs.expiration !== 'AUTO' ? prefs.expiration : (snapshot.expiration || null);
      const enriched = { ...snapshot, platformId: platform.id, platformName: platform.name, analysisTimeframe, targetExpiration };
      const license = await syncLicense(settings, scannerState);
      let activeScanner = scannerState.scanner;
      if (settings.runtimePaused || (licenseRequired(settings) && license.status !== 'active')) activeScanner = 'idle';
      let next = merge(scannerState, { ...enriched, scanner: activeScanner, license, connection: 'online', lastSeen: Date.now() });
      next = merge(next, processSnapshot(enriched, next));
      const previousState = scannerState?.signal?.state || null;
      const becameConfirm = next.signal?.state === 'CONFIRM' && previousState !== 'CONFIRM';
      if (becameConfirm) {
        const usage = await consumeSignal(settings);
        if (!usage.ok) {
          const hint = usage.error === 'daily_limit_reached' ? 'Limite diário do plano atingido.' : usage.error === 'trial_limit_reached' ? 'O teste já utilizou todas as entradas disponíveis.' : 'Licença inválida para liberar novo sinal.';
          next = merge(next, { license: { ...license, ...(usage.license || {}), ...licenseError(usage) }, signal: { ...next.signal, state: 'NO_TRADE', direction: null, hint, reason: hint, provisional: true } });
        } else {
          next = merge(next, { license: { ...license, ...(usage.license || {}), ...(usage.usage || {}), status: 'active', error: null } });
          const record = localSignalRecord(next);
          await appendSessionHistory(record);
          await telemetryEvent('signal_confirmed', record, settings);
        }
      }
      next = telemetryState(next);
      await chrome.storage.local.set({ scannerState: next });
      telemetryHeartbeat(next, settings, becameConfirm);
      sendResponse({ ok: true, signal: next.signal, license: next.license });
    }).catch(e => sendResponse({ ok: false, error: String(e?.message || e) })); return true;
  }
  if (message?.type === 'ATS_GET_STATE') {
    chrome.storage.local.get('scannerState').then(async ({ scannerState = {} }) => {
      const supported = await ensureSupportedActiveTab(scannerState);
      sendResponse(merge(supported.scannerState));
    }); return true;
  }
  if (message?.type === 'ATS_SET_SCANNER') {
    chrome.storage.local.get(['scannerState', 'settings']).then(async ({ scannerState = {}, settings = {} }) => {
      const supported = await ensureSupportedActiveTab(scannerState);
      if (!supported.platform) return sendResponse({ ok: false, error: 'platform_not_registered', state: supported.scannerState });
      const scanning = !!message.enabled;
      const license = await syncLicense(settings, supported.scannerState, true);
      const prefs = settings.scanPreferences || {};
      if (scanning && licenseRequired(settings) && license.status !== 'active') return sendResponse({ ok: false, error: 'license_required' });
      if (scanning && (!configuredPrefs(prefs) || !supported.scannerState?.platformControls?.aligned)) return sendResponse({ ok: false, error: 'preflight_required' });
      const next = merge(supported.scannerState, { scanner: scanning ? 'scanning' : 'idle', license });
      await chrome.storage.local.set({ scannerState: next });
      sendResponse({ ok: true, state: next });
    }); return true;
  }
  if (message?.type === 'ATS_RESET_STATE') {
    resetOrchestrator();
    Promise.all([chrome.storage.local.set({ scannerState: DEFAULT_STATE }), chrome.storage.session.remove(SESSION_HISTORY_KEY)])
      .then(() => sendResponse({ ok: true }));
    return true;
  }
});
