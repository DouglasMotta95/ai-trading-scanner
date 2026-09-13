import { processSnapshot, resetOrchestrator, serializeCompletedDecisions, restoreCompletedDecisions } from './core/orchestrator.js';
import { resolveMarketEvidence, marketHistoryFor, acquisitionStage } from './core/market-evidence.js';
import { detectPlatform } from './platforms/registry.js';
import { activateLicense, validateLicense, consumeSignal, clearLicense, licenseRequired, restoreCachedLicense } from './services/license.js';
import { heartbeat, track } from './services/telemetry.js';
import { readScannerState, updateScannerState, replaceScannerState } from './services/scanner-state-atomic.js';

const SESSION_HISTORY_KEY = 'atsSessionSignalHistory';
const COMPLETED_DECISIONS_KEY = 'atsCompletedDecisions';
const RUNTIME_SESSION_KEY = 'atsRuntimeSessionId';
const NON_RESTORABLE_LICENSE_STATUSES = new Set(['limit', 'expired', 'device_locked']);
const DEFAULT_LICENSE = {
  status: 'unconfigured', plan: null, planLabel: null, dailyLimit: null, usedToday: 0,
  remainingToday: null, totalLimit: null, usedTotal: 0, remainingTotal: null, error: null
};
const AUTHORITATIVE_BACKGROUND_LICENSE_ERRORS = new Set([
  'license_not_found',
  'license_inactive',
  'license_expired',
  'device_limit_reached'
]);
const EMPTY_MARKET = {
  connection: 'offline', platformId: null, platformName: null, targetTabId: null,
  asset: null, marketType: 'unknown', instrumentType: 'unknown', timeframe: null,
  analysisTimeframe: null, expiration: null, targetExpiration: null, price: null,
  serverTime: null, capabilities: { structuredQuotes: false, candles: false, expiration: false, multiAsset: false },
  diagnostics: {}, marketCatalog: { assets: [], timeframes: [], expirations: [], lines: [] },
  marketHistory: {}, platformControls: null, signal: null, tradeIntent: null, lastSeen: null,
  candles: [], currentCandle: null, lastConfirmed: null,
  telemetry: { feedQuality: 0, latency: null, lastSync: null }
};
const DEFAULT_STATE = { ...EMPTY_MARKET, scanner: 'idle', license: DEFAULT_LICENSE };

let lastLicenseCheck = 0;
let lastHeartbeatAt = 0;
let lastDirectScanAt = 0;
let directScanPromise = null;
let completedDecisionRestorePromise = null;
let runtimeSessionPromise = null;

const clean = v => String(v ?? '').trim();
const num = v => v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null;
const sameTarget = (s, sender) => !s?.targetTabId || !sender?.tab?.id || s.targetTabId === sender.tab.id;
const platformFromUrl = u => { try { return detectPlatform(new URL(u).hostname); } catch { return null; } };

const FOCUS_STABLE_MS = 2000;
const licenseActive = license => ['active', 'valid'].includes(String(license?.status || '').toLowerCase());
const normAsset = value => clean(value).toUpperCase()
  .replace(/\s+/g, ' ')
  .replace(/\s*\(\s*OTC\s*\)\s*$/, ' (OTC)')
  .trim();
const assetIdentity = value => normAsset(value).replace(/\s*\(OTC\)\s*$/, '');
const sameAsset = (a, b) => {
  const left = assetIdentity(a), right = assetIdentity(b);
  return !!left && !!right && left === right;
};
const focusedAssetMeta = state => state?.diagnostics?.focusedAsset || null;
const focusedAsset = state => normAsset(focusedAssetMeta(state)?.asset);
const focusStableFor = (state, asset) => {
  const meta = focusedAssetMeta(state);
  const since = Number(meta?.stableSince || meta?.at || 0);
  return sameAsset(meta?.asset, asset) && Number.isFinite(since) && since > 0 && Date.now() - since >= FOCUS_STABLE_MS;
};

const merge = (state = {}, patch = {}) => ({
  ...DEFAULT_STATE, ...state, ...patch,
  license: { ...DEFAULT_LICENSE, ...(state.license || {}), ...(patch.license || {}) },
  capabilities: { ...DEFAULT_STATE.capabilities, ...(state.capabilities || {}), ...(patch.capabilities || {}) },
  diagnostics: { ...(state.diagnostics || {}), ...(patch.diagnostics || {}) },
  telemetry: { ...DEFAULT_STATE.telemetry, ...(state.telemetry || {}), ...(patch.telemetry || {}) }
});

const marketCleared = (state = {}, patch = {}) => ({
  ...state, ...EMPTY_MARKET, scanner: 'idle', license: state.license || DEFAULT_LICENSE, ...patch
});

async function runtimeSessionId() {
  if (!runtimeSessionPromise) {
    runtimeSessionPromise = (async () => {
      const stored = await chrome.storage.session.get(RUNTIME_SESSION_KEY);
      let sessionId = clean(stored[RUNTIME_SESSION_KEY]);
      if (!sessionId) {
        sessionId = crypto.randomUUID();
        await chrome.storage.session.set({ [RUNTIME_SESSION_KEY]: sessionId });
      }
      return sessionId;
    })();
  }
  return runtimeSessionPromise;
}

async function restoreCompletedDecisionCache() {
  const sessionId = await runtimeSessionId();
  const stored = await chrome.storage.local.get(COMPLETED_DECISIONS_KEY);
  const cached = stored[COMPLETED_DECISIONS_KEY];
  if (cached?.sessionId === sessionId && Array.isArray(cached.rows)) {
    restoreCompletedDecisions(cached.rows);
    return;
  }
  restoreCompletedDecisions([]);
  if (cached) await chrome.storage.local.remove(COMPLETED_DECISIONS_KEY);
}

async function ensureCompletedDecisionCache() {
  if (!completedDecisionRestorePromise) {
    completedDecisionRestorePromise = restoreCompletedDecisionCache().catch(() => {
      restoreCompletedDecisions([]);
    });
  }
  await completedDecisionRestorePromise;
}

async function persistCompletedDecisionCache() {
  const rows = serializeCompletedDecisions();
  if (!rows.length) {
    await chrome.storage.local.remove(COMPLETED_DECISIONS_KEY);
    return;
  }
  const sessionId = await runtimeSessionId();
  await chrome.storage.local.set({
    [COMPLETED_DECISIONS_KEY]: { sessionId, rows, updatedAt: Date.now() }
  });
}

async function clearCompletedDecisionCache() {
  resetOrchestrator();
  await chrome.storage.local.remove(COMPLETED_DECISIONS_KEY);
}

function licenseError(r, currentLicense = DEFAULT_LICENSE) {
  const error = r?.error || 'license_required';
  if (!AUTHORITATIVE_BACKGROUND_LICENSE_ERRORS.has(error)) {
    return { ...currentLicense, error, syncPending: true };
  }
  const status = error === 'license_expired' ? 'expired'
    : error === 'device_limit_reached' ? 'device_locked'
      : 'inactive';
  return { ...currentLicense, status, error, syncPending: false };
}

async function syncLicense(settings = {}, state = {}, force = false) {
  if (!force && state.license?.status === 'active' && Date.now() - lastLicenseCheck < 30000) return state.license;
  const r = await validateLicense(settings);
  lastLicenseCheck = Date.now();
  return r.ok ? { ...r.license, error: r.license?.error || null } : licenseError(r, state.license || DEFAULT_LICENSE);
}

function feedQuality(state = {}) {
  if (state.connection !== 'online' || state.price == null) return 0;
  const reported = Number(state.diagnostics?.network?.feedQuality);
  if (Number.isFinite(reported) && reported > 0) return Math.max(0, Math.min(100, reported));
  if (state.capabilities?.structuredQuotes) return 100;
  return state.asset && state.price != null ? 65 : 0;
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
const telemetryState = state => merge(state, {
  telemetry: { feedQuality: feedQuality(state), latency: latencyOf(state), lastSync: Date.now() }
});

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

async function ensureSupportedActiveTab() {
  const { tab, platform } = await activeCasaTradeTab();
  if (tab?.id && platform) return { scannerState: await readScannerState(), tab, platform };
  const unsupportedHost = (() => { try { return new URL(tab?.url || '').hostname || null; } catch { return null; } })();
  const cleared = await updateScannerState(current => marketCleared(current, {
    diagnostics: { unsupportedHost }
  }));
  return { scannerState: cleared, tab, platform: null };
}

async function injectReaders(tabId) {
  const scripts = [
    { file: 'src/content/focused-asset.js', world: 'ISOLATED', allFrames: false },
    { file: 'src/content/worker-probe.js', world: 'MAIN', allFrames: true },
    { file: 'src/content/canvas-probe.js', world: 'MAIN', allFrames: true },
    { file: 'src/content/network-probe.js', world: 'MAIN', allFrames: true },
    { file: 'src/content/network-bridge.js', world: 'ISOLATED', allFrames: true },
    { file: 'src/content/embedded-feed-bridge.js', world: 'ISOLATED', allFrames: true },
    { file: 'src/content/generic-adapter.js', world: 'ISOLATED', allFrames: true },
    { file: 'src/content/platform-sync.js', world: 'ISOLATED', allFrames: true }
  ];
  for (const { file, world, allFrames } of scripts) {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames },
      files: [file],
      world
    }).catch(() => {});
  }
}

async function connectActiveTab() {
  const [{ settings = {} }, initialState] = await Promise.all([
    chrome.storage.local.get('settings'),
    readScannerState()
  ]);
  let scannerState = initialState;
  const currentLicenseStatus = String(scannerState.license?.status || '').toLowerCase();
  if (!licenseActive(scannerState.license) && !NON_RESTORABLE_LICENSE_STATUSES.has(currentLicenseStatus)) {
    const restored = await restoreCachedLicense().catch(() => null);
    let recoveredLicense = restored;
    if (!licenseActive(recoveredLicense)) {
      recoveredLicense = await syncLicense(settings, scannerState, true).catch(() => scannerState.license || DEFAULT_LICENSE);
    }
    if (licenseActive(recoveredLicense)) {
      scannerState = await updateScannerState(current => merge(current, { license: recoveredLicense }));
    }
  }

  if (!licenseActive(scannerState.license)) {
    const locked = await updateScannerState(current => marketCleared(current, {
      license: current.license || DEFAULT_LICENSE,
      diagnostics: { ...(current.diagnostics || {}), access: { state: 'license_required', at: Date.now() } }
    }));
    return { ok: false, error: 'license_required', state: locked };
  }

  const { tab, platform } = await activeCasaTradeTab();
  if (!tab?.id || !tab.url || !platform) {
    const unsupportedHost = (() => { try { return new URL(tab?.url || '').hostname || null; } catch { return null; } })();
    const next = await updateScannerState(current => marketCleared(current, {
      diagnostics: { unsupportedHost }
    }));
    return { ok: false, error: 'platform_not_registered', state: next };
  }

  await injectReaders(tab.id);

  const next = await updateScannerState(current => {
    const sameTab = current.targetTabId === tab.id;
    return merge(current, {
      connection: sameTab && current.connection === 'online' ? 'online' : 'connecting',
      platformId: platform.id,
      platformName: platform.name,
      targetTabId: tab.id,
      scanner: 'scanning',
      ...(sameTab ? {} : { asset: null, price: null, signal: null, platformControls: null }),
      diagnostics: {
        ...(current.diagnostics || {}),
        target: { host: new URL(tab.url).hostname, tabId: tab.id, connectedAt: Date.now() },
        acquisition: {
          stage: 'confirming_asset',
          reason: 'CasaTrade conectada. Confirmando o ativo aberto.',
          at: Date.now()
        }
      }
    });
  });
  telemetryEvent('platform_connected', { platformId: platform.id, platformName: platform.name }, settings);
  return { ok: true, platform: { id: platform.id, name: platform.name }, tabId: tab.id, state: next };
}

function scanCasaTradeFrame() {
  const host = String(location.hostname || '').toLowerCase().replace(/\.$/, '');
  if (!(host === 'casatrade.com' || host.endsWith('.casatrade.com') || host === 'casatrade.io' || host.endsWith('.casatrade.io'))) return null;

  const cleanText = v => String(v ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  const fold = v => cleanText(v).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const toNum = v => {
    let s = cleanText(v).replace(/[^\d,.-]/g, '');
    if (!s) return null;
    if (s.includes(',') && s.includes('.')) s = s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
    else s = s.replace(',', '.');
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  };
  const visible = el => {
    if (!el || !(el instanceof Element)) return false;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity || 1) > 0;
  };

  const roots = [document];
  const seenRoots = new Set(roots);
  for (let i = 0; i < roots.length && i < 300; i++) {
    let nodes = [];
    try { nodes = roots[i].querySelectorAll('*'); } catch {}
    for (const el of nodes) {
      if (el.shadowRoot && !seenRoots.has(el.shadowRoot)) {
        seenRoots.add(el.shadowRoot);
        roots.push(el.shadowRoot);
      }
    }
  }

  const elements = [];
  for (const root of roots) {
    let nodes = [];
    try { nodes = root.querySelectorAll('button,[role="button"],[role="tab"],[aria-selected],input,select,span,strong,b,p,div,li,svg text'); } catch {}
    for (const el of nodes) if (visible(el)) elements.push(el);
  }

  const texts = elements.map(el => cleanText(
    el instanceof HTMLInputElement || el instanceof HTMLSelectElement
      ? (el.value || el.selectedOptions?.[0]?.textContent || '')
      : (el.innerText || el.textContent || '')
  )).filter(Boolean);
  const pageText = cleanText([document.body?.innerText || '', ...texts.slice(0, 2500)].join(' '));

  const pairRe = /\b([A-Z0-9]{2,16})\s*\/\s*(USDT|USDC|USD|EUR|GBP|JPY|AUD|CAD|CHF|NZD|BRL|BTC|ETH)(?:\s*\(OTC\))?/i;
  const assetRows = [];
  for (const el of elements) {
    const text = cleanText(el.innerText || el.textContent || '');
    if (!text || text.length > 100) continue;
    const m = text.toUpperCase().match(pairRe);
    if (!m) continue;
    const assetMatch = m[0].replace(/\s+/g, ' ').trim().toUpperCase();
    const r = el.getBoundingClientRect();
    let score = 30;
    if (/\(OTC\)/i.test(assetMatch)) score += 20;
    if (el.getAttribute?.('aria-selected') === 'true' || /active|selected|current/i.test(String(el.className || ''))) score += 45;
    if (r.top >= 0 && r.top < innerHeight * .38) score += 20;
    if (r.left >= 0 && r.left < innerWidth * .60) score += 12;
    if (/portfolio|historico|histórico|chat|suporte|ranking|leader/i.test(fold(text))) score -= 35;
    assetRows.push({ asset: assetMatch, score });
  }
  if (!assetRows.length) {
    const m = pageText.toUpperCase().match(pairRe);
    if (m) assetRows.push({ asset: m[0].replace(/\s+/g, ' ').trim().toUpperCase(), score: 15 });
  }
  assetRows.sort((a, b) => b.score - a.score);
  const asset = assetRows[0]?.asset || null;

  const decimals = text => {
    const out = [];
    for (const m of String(text || '').matchAll(/\b\d{1,6}[.,]\d{3,8}\b/g)) {
      const n = toNum(m[0]);
      if (n != null && n > 0) out.push(n);
    }
    return out;
  };

  let buy = null, sell = null;
  for (const el of elements) {
    const text = cleanText(el.innerText || el.textContent || '');
    if (!text || text.length > 120) continue;
    const f = fold(text);
    const values = decimals(text);
    if (!values.length) continue;
    if (buy == null && /\b(comprar|buy)\b/.test(f)) buy = values[values.length - 1];
    if (sell == null && /\b(vender|sell)\b/.test(f)) sell = values[values.length - 1];
  }
  let price = buy != null && sell != null ? (buy + sell) / 2 : (buy ?? sell ?? null);
  let priceSource = price != null ? 'buttons' : null;

  if (price == null) {
    const rows = [];
    for (const el of elements) {
      const text = cleanText(el.innerText || el.textContent || '');
      if (!text || text.length > 35 || /%|\$|R\$/i.test(text)) continue;
      const values = decimals(text);
      if (!values.length) continue;
      const r = el.getBoundingClientRect();
      for (const value of values) {
        let score = 0;
        if (r.left > innerWidth * .55) score += 20;
        if (r.top > innerHeight * .12 && r.top < innerHeight * .86) score += 15;
        if (/price|quote|rate/i.test(String(el.className || ''))) score += 25;
        rows.push({ value, score });
      }
    }
    rows.sort((a, b) => b.score - a.score);
    price = rows[0]?.value ?? null;
    if (price != null) priceSource = 'chart';
  }

  const normalizeTf = value => {
    const s = fold(value).replace(/\s+/g, '');
    let m = s.match(/^m(1|2|5|15|30)$/); if (m) return `M${m[1]}`;
    m = s.match(/^(1|2|5|15|30)(?:m|min|minuto|minutos)$/); if (m) return `M${m[1]}`;
    m = s.match(/^s(5|15|30)$/); if (m) return `S${m[1]}`;
    m = s.match(/^(5|15|30)(?:s|seg|segundo|segundos)$/); if (m) return `S${m[1]}`;
    return /^(h1|1h|60m|60min)$/.test(s) ? 'H1' : null;
  };

  const tfRows = [];
  for (const el of elements) {
    const text = cleanText(el.innerText || el.textContent || '');
    if (!text || text.length > 20) continue;
    const tf = normalizeTf(text);
    if (!tf) continue;
    const r = el.getBoundingClientRect();
    let score = 5;
    if (el.getAttribute?.('aria-selected') === 'true' || /active|selected|current/i.test(String(el.className || ''))) score += 50;
    if (r.left < innerWidth * .35) score += 15;
    if (r.top > innerHeight * .20 && r.top < innerHeight * .90) score += 8;
    tfRows.push({ tf, score });
  }
  tfRows.sort((a, b) => b.score - a.score);
  const timeframe = tfRows[0]?.tf || 'M1';

  const expMatch = pageText.match(/(?:expira(?:ção|cao)|expiry|duration)\s*[:\-]?\s*(\d{1,4})\s*(s|seg|segundo|segundos|m|min|minuto|minutos)/i);
  let expiration = null;
  if (expMatch) {
    const n = Number(expMatch[1]);
    expiration = /^m|min/i.test(expMatch[2]) ? (n === 1 ? '60s' : `${n}m`) : `${n}s`;
  }

  const amountMatch = pageText.match(/\bvalor\b\s*(?:R\$|\$)?\s*([\d.]+(?:,\d+)?)/i);
  const amount = amountMatch ? toNum(amountMatch[1]) : null;

  const instrumentType = /\bblitz\b/i.test(pageText) ? 'blitz'
    : /\bbin[aá]ri[ao]\b|\bbinary\b/i.test(pageText) ? 'binary'
      : /\bturbo\b/i.test(pageText) ? 'turbo' : 'unknown';

  const marketType = /\(OTC\)/i.test(asset || '') ? 'otc' : 'regular';
  const score = (asset ? 55 : 0) + (price != null ? 45 : 0) + (expiration ? 8 : 0) + (amount != null ? 6 : 0);

  return {
    asset, price, priceSource, buy, sell, timeframe, expiration, amount, instrumentType, marketType,
    score, frameUrl: location.href
  };
}

function historyForAsset(state = {}, asset = '') {
  return marketHistoryFor(state, asset);
}

function evidenceFocusGate(evidence = {}, snapshot = {}) {
  const focused = evidence.assetSource?.startsWith('focused');
  return {
    state: evidence.asset ? (focused ? 'ready' : 'fallback') : 'blocked',
    focusedAsset: evidence.focusAsset || null,
    receivedAsset: normAsset(snapshot?.asset) || null,
    resolvedAsset: evidence.asset || null,
    assetSource: evidence.assetSource || null,
    priceSource: evidence.priceSource || null,
    stable: evidence.focusStable === true,
    reliable: evidence.focusReliable === true,
    corroborated: evidence.focusCorroborated === true,
    reason: !evidence.asset
      ? evidence.reason
      : focused
        ? (evidence.focusStable ? null : 'Foco liberado por evidência consistente do mesmo ativo; aguardando 2s não bloqueia a leitura.')
        : `FocusGate em fallback seguro: usando ${evidence.assetSource || 'evidência alternativa'} sem inventar ativo.`,
    at: Date.now()
  };
}

async function applySnapshot(snapshot, _scannerState = {}, settings = {}, platform = { id: 'casatrade', name: 'CasaTrade' }) {
  await ensureCompletedDecisionCache();
  let becameConfirm = false;
  let confirmedRecord = null;
  let processedSnapshot = false;

  const next = await updateScannerState(async scannerState => {
    if (licenseRequired(settings) && !licenseActive(scannerState.license)) {
      return marketCleared(scannerState, {
        license: scannerState.license || DEFAULT_LICENSE,
        diagnostics: { ...(scannerState.diagnostics || {}), access: { state: 'license_required', at: Date.now() } }
      });
    }

    const license = await syncLicense(settings, scannerState);
    if (licenseRequired(settings) && !licenseActive(license)) {
      return marketCleared(scannerState, {
        license,
        diagnostics: { ...(scannerState.diagnostics || {}), access: { state: 'license_required', at: Date.now() } }
      });
    }

    const evidence = resolveMarketEvidence(snapshot, scannerState, { focusStableMs: FOCUS_STABLE_MS });
    const focusGate = evidenceFocusGate(evidence, snapshot);
    const resolvedAsset = normAsset(evidence.asset);

    if (!resolvedAsset) {
      return merge(scannerState, {
        license,
        scanner: 'scanning',
        platformId: platform.id,
        platformName: platform.name,
        connection: 'connecting',
        asset: null,
        price: null,
        candles: [],
        currentCandle: null,
        signal: null,
        lastConfirmed: null,
        lastSeen: Date.now(),
        diagnostics: {
          ...(scannerState.diagnostics || {}),
          ...(snapshot?.diagnostics || {}),
          focusGate,
          acquisition: {
            stage: 'confirming_asset',
            reason: evidence.reason || 'Ativo não confirmado: aguardando foco, DOM ou feed de rede.',
            assetSource: null,
            priceSource: null,
            candleCount: 0,
            requiredCandles: 3,
            at: Date.now()
          }
        }
      });
    }

    const fallbackHistory = historyForAsset(scannerState, resolvedAsset);
    if (num(evidence.price) == null) {
      return merge(scannerState, {
        license,
        scanner: 'scanning',
        platformId: platform.id,
        platformName: platform.name,
        connection: 'connecting',
        asset: resolvedAsset,
        price: null,
        candles: fallbackHistory,
        currentCandle: null,
        signal: null,
        lastSeen: Date.now(),
        diagnostics: {
          ...(scannerState.diagnostics || {}),
          ...(snapshot?.diagnostics || {}),
          focusGate,
          acquisition: {
            stage: 'reading_price',
            reason: evidence.reason || `Ativo ${resolvedAsset} confirmado. Aguardando preço real.`,
            assetSource: evidence.assetSource,
            priceSource: null,
            candleCount: fallbackHistory.length,
            requiredCandles: 3,
            at: Date.now()
          }
        }
      });
    }

    if (scannerState.asset && !sameAsset(scannerState.asset, resolvedAsset)) resetOrchestrator();

    const analysisTimeframe = snapshot.timeframe || scannerState.analysisTimeframe || scannerState.timeframe || 'M1';
    const targetExpiration = snapshot.expiration || scannerState.targetExpiration || scannerState.expiration || null;
    const snapshotAsset = normAsset(snapshot?.asset);
    const snapshotCandles = (!snapshotAsset || sameAsset(snapshotAsset, resolvedAsset)) && Array.isArray(snapshot.candles)
      ? snapshot.candles
      : [];
    const candles = snapshotCandles.length ? snapshotCandles : fallbackHistory;
    const enriched = {
      ...snapshot,
      asset: resolvedAsset,
      price: Number(evidence.price),
      platformId: platform.id,
      platformName: platform.name,
      analysisTimeframe,
      targetExpiration,
      candles
    };

    const activeScanner = settings.runtimePaused ? 'idle' : 'scanning';
    if (activeScanner !== 'scanning') {
      return merge(scannerState, {
        license, scanner: 'idle', connection: 'offline', signal: null, price: null, lastSeen: null
      });
    }

    processedSnapshot = true;
    let candidate = merge(scannerState, {
      ...enriched,
      scanner: 'scanning',
      license,
      connection: 'online',
      lastSeen: Date.now(),
      diagnostics: {
        ...(scannerState.diagnostics || {}),
        ...(snapshot?.diagnostics || {}),
        focusGate,
        acquisition: {
          stage: candles.length >= 3 ? 'analyzing_current' : 'reading_history',
          reason: candles.length >= 3
            ? 'Ativo e preço confirmados. Analisando a vela atual.'
            : `Lendo histórico de velas (${candles.length}/3).`,
          assetSource: evidence.assetSource,
          priceSource: evidence.priceSource,
          candleCount: candles.length,
          requiredCandles: 3,
          at: Date.now()
        }
      }
    });
    candidate = merge(candidate, processSnapshot(enriched, candidate));
    const processedCount = Math.max(0, Number(candidate.signal?.candleCount ?? candidate.candles?.length ?? 0));
    const stage = acquisitionStage(candidate.signal, processedCount);
    candidate = merge(candidate, {
      diagnostics: {
        ...(candidate.diagnostics || {}),
        focusGate,
        acquisition: {
          ...(candidate.diagnostics?.acquisition || {}),
          stage,
          reason: stage === 'reading_history'
            ? `Lendo histórico de velas (${processedCount}/3).`
            : stage === 'analyzing_current'
              ? 'Histórico mínimo pronto. Analisando a vela atual.'
              : 'Analisando a vela atual e calculando o diagnóstico da próxima vela.',
          assetSource: evidence.assetSource,
          priceSource: evidence.priceSource,
          candleCount: processedCount,
          requiredCandles: 3,
          at: Date.now()
        }
      }
    });

    const previousState = scannerState?.signal?.state || null;
    const previousDirection = scannerState?.signal?.direction || null;
    becameConfirm = candidate.signal?.state === 'CONFIRM'
      && (previousState !== 'CONFIRM' || previousDirection !== candidate.signal?.direction);

    if (becameConfirm) {
      const usage = await consumeSignal(settings);
      if (!usage.ok) {
        const hint = usage.error === 'daily_limit_reached'
          ? 'Limite diário do plano atingido.'
          : usage.error === 'trial_limit_reached'
            ? 'O teste já utilizou todas as previsões disponíveis.'
            : 'Não foi possível registrar o uso desta previsão. O status da licença foi mantido.';
        candidate = merge(candidate, {
          license,
          signal: { ...candidate.signal, state: 'NO_TRADE', direction: null, diagnosis: 'WAIT', hint, reason: hint, provisional: true }
        });
      } else {
        candidate = merge(candidate, {
          license: {
            ...license,
            ...(usage.license || {}),
            ...(usage.usage || {}),
            status: license.status,
            error: license.error || null
          }
        });
        confirmedRecord = localSignalRecord(candidate);
      }
    }

    return telemetryState(candidate);
  });

  if (processedSnapshot) await persistCompletedDecisionCache().catch(() => {});
  if (confirmedRecord) {
    await appendSessionHistory(confirmedRecord);
    await telemetryEvent('signal_confirmed', confirmedRecord, settings);
  }
  telemetryHeartbeat(next, settings, becameConfirm);
  return next;
}

async function directScanActiveTab(force = false) {
  if (!force && directScanPromise) return directScanPromise;
  if (!force && Date.now() - lastDirectScanAt < 650) return readScannerState();

  directScanPromise = (async () => {
    lastDirectScanAt = Date.now();
    const [{ settings = {} }, scannerState] = await Promise.all([chrome.storage.local.get('settings'), readScannerState()]);

    if (!licenseActive(scannerState.license)) {
      return updateScannerState(current => marketCleared(current, {
        license: current.license || DEFAULT_LICENSE,
        diagnostics: { ...(current.diagnostics || {}), access: { state: 'license_required', at: Date.now() } }
      }));
    }

    const { tab, platform } = await activeCasaTradeTab();
    if (!tab?.id || !platform) {
      const supported = await ensureSupportedActiveTab();
      return supported.scannerState;
    }

    if (scannerState.targetTabId !== tab.id || scannerState.platformId !== platform.id) {
      const connected = await connectActiveTab();
      if (!connected?.ok) return connected?.state || scannerState;
    }

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: scanCasaTradeFrame,
      world: 'ISOLATED'
    }).catch(() => []);

    const rows = (Array.isArray(results) ? results : [])
      .map(x => x?.result)
      .filter(Boolean)
      .sort((a, b) => Number(b.score || 0) - Number(a.score || 0));

    const latest = await readScannerState();
    const focus = focusedAsset(latest);
    const focusRows = focus ? rows.filter(x => x.asset && sameAsset(x.asset, focus)) : [];
    const bestFocused = focusRows.find(x => x.asset && num(x.price) != null) || null;
    const bestFallback = rows.find(x => x.asset && num(x.price) != null) || rows.find(x => x.asset) || null;
    const priceOnly = rows.find(x => num(x.price) != null) || null;
    const best = bestFocused || bestFallback || priceOnly;
    const observedAsset = normAsset(best?.asset || focus || '');
    const observedPrice = num(best?.price) ?? (focus && priceOnly ? num(priceOnly.price) : null);
    const history = historyForAsset(latest, observedAsset || focus);

    if (!observedAsset && observedPrice == null) {
      return applySnapshot({
        platformId: platform.id,
        platformName: platform.name,
        connection: 'connecting',
        asset: null,
        price: null,
        diagnostics: { directScan: { framesSeen: rows.length, at: Date.now() } }
      }, latest, settings, platform);
    }

    const observed = {
      amount: best?.amount ?? null,
      timeframe: best?.timeframe || null,
      expiration: best?.expiration || null,
      detected: {
        amount: best?.amount != null,
        timeframe: !!best?.timeframe,
        expiration: !!best?.expiration
      },
      sources: { amount: 'direct', timeframe: 'direct', expiration: 'direct' },
      at: Date.now()
    };

    const assetSource = bestFocused ? 'focused-dom' : best?.asset ? 'dom-fallback' : focus ? 'focused-price-fallback' : null;
    const priceSource = best?.priceSource || (best?.buy != null || best?.sell != null ? 'buttons' : observedPrice != null ? 'chart' : null);
    const snapshot = {
      platformId: platform.id,
      platformName: platform.name,
      connection: observedAsset && observedPrice != null ? 'online' : 'connecting',
      asset: observedAsset || null,
      price: observedPrice,
      timeframe: best?.timeframe || 'M1',
      expiration: best?.expiration || null,
      instrumentType: best?.instrumentType || 'unknown',
      marketType: /\(OTC\)$/i.test(observedAsset) ? 'otc' : (best?.marketType || 'regular'),
      serverTime: null,
      candles: history,
      capabilities: {
        structuredQuotes: false,
        candles: history.length >= 3,
        expiration: !!best?.expiration,
        multiAsset: false
      },
      diagnostics: {
        assetSource,
        priceSource,
        directScan: {
          frameUrl: best?.frameUrl || null,
          score: Number(best?.score || 0),
          buy: best?.buy ?? null,
          sell: best?.sell ?? null,
          framesSeen: rows.length,
          filteredTo: observedAsset || focus || null,
          usedFocusFallback: !!focus && !bestFocused,
          at: Date.now()
        }
      },
      platformControls: { aligned: false, observed, checkedAt: Date.now() }
    };

    return applySnapshot(snapshot, latest, settings, platform);
  })();

  try {
    return await directScanPromise;
  } finally {
    directScanPromise = null;
  }
}

async function readPlatformControls() {
  const state = await directScanActiveTab(true);
  const observed = state?.platformControls?.observed || {};
  return { ok: !!(observed.amount != null || observed.timeframe || observed.expiration), observed };
}

async function refreshPlatformControls() {
  const state = await directScanActiveTab(true);
  const observed = state?.platformControls?.observed || {};
  return { ok: true, aligned: !!state?.platformControls?.aligned, observed };
}

async function syncPlatformPreferences() {
  return refreshPlatformControls();
}

async function prepareTrade(direction) {
  if (!['BUY', 'SELL'].includes(direction)) return { ok: false, error: 'invalid_direction' };
  const [{ settings = {} }, scannerState] = await Promise.all([chrome.storage.local.get('settings'), readScannerState()]);
  if (!licenseActive(scannerState.license)) return { ok: false, error: 'license_required' };
  const supported = await ensureSupportedActiveTab();
  if (!supported.platform || !supported.tab?.id || supported.tab.id !== scannerState.targetTabId) return { ok: false, error: 'platform_tab_not_connected' };

  const sig = scannerState.signal || {};
  if (sig.state !== 'CONFIRM' || sig.direction !== direction || sig.provisional) return { ok: false, error: 'signal_not_confirmed' };

  if (!scannerState.platformControls?.observed) return { ok: false, error: 'platform_not_aligned' };

  const intent = {
    direction,
    asset: scannerState.asset || null,
    timeframe: scannerState.analysisTimeframe || scannerState.timeframe || null,
    expiration: scannerState.targetExpiration || scannerState.expiration || null,
    stake: num(scannerState.platformControls?.observed?.amount) ?? num(settings.scanPreferences?.tradeAmount ?? settings.scanPreferences?.stake),
    createdAt: Date.now(),
    status: 'prepared'
  };

  await chrome.tabs.update(supported.tab.id, { active: true }).catch(() => {});
  await chrome.scripting.executeScript({
    target: { tabId: supported.tab.id, allFrames: true },
    files: ['src/content/trade-handoff.js'],
    world: 'ISOLATED'
  }).catch(() => {});

  const handoff = await chrome.tabs.sendMessage(supported.tab.id, {
    type: 'ATS_HIGHLIGHT_TRADE', ...intent
  }).catch(() => ({ found: false }));

  const nextIntent = { ...intent, handoff: { found: !!handoff?.found, label: handoff?.label || null } };
  await updateScannerState(current => merge(current, { tradeIntent: nextIntent }));
  telemetryEvent('trade_handoff_prepared', { ...intent, found: !!handoff?.found }, settings);
  return { ok: true, intent: nextIntent };
}

chrome.runtime.onInstalled.addListener(async () => {
  const { settings = {} } = await chrome.storage.local.get('settings');
  await updateScannerState(current => {
    if (!Object.keys(current || {}).length) return DEFAULT_STATE;
    if (!licenseActive(current.license)) return marketCleared(current, {
      license: current.license || DEFAULT_LICENSE,
      diagnostics: {}
    });
    return;
  });
  await chrome.storage.local.set({
    settings: {
      ...settings,
      scanPreferences: { tradeAmount: null, stake: null, timeframe: 'AUTO', expiration: 'AUTO', ...(settings.scanPreferences || {}) }
    }
  });
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

chrome.tabs?.onActivated?.addListener(async () => {
  const scannerState = await readScannerState();
  if (!licenseActive(scannerState.license)) return;
  const { tab, platform } = await activeCasaTradeTab();
  if (tab?.id && platform) {
    await connectActiveTab().catch(() => {});
    await directScanActiveTab(true).catch(() => {});
    return;
  }
  await ensureSupportedActiveTab();
});

chrome.tabs?.onUpdated?.addListener(async (tabId, changeInfo, tab) => {
  if (!changeInfo.url && changeInfo.status !== 'complete') return;
  const scannerState = await readScannerState();
  if (!licenseActive(scannerState.license)) return;
  const platform = tab?.url ? platformFromUrl(tab.url) : null;
  if (tab?.active && platform && tabId) {
    await connectActiveTab().catch(() => {});
    await directScanActiveTab(true).catch(() => {});
    return;
  }
  if (scannerState.targetTabId === tabId || tab?.active) await ensureSupportedActiveTab();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'ATS_CONNECT_ACTIVE_TAB') {
    (async () => {
      const connected = await connectActiveTab();
      if (!connected.ok) return connected;
      const state = await directScanActiveTab(true);
      return { ...connected, state };
    })().then(sendResponse).catch(e => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }

  if (message?.type === 'ATS_ACTIVATE_LICENSE') {
    Promise.all([readScannerState(), chrome.storage.local.get('settings')]).then(async ([scannerState, { settings = {} }]) => {
      const r = await activateLicense(settings, message.key);
      lastLicenseCheck = 0;
      const activated = !!r?.ok && licenseActive(r.license);
      const activationError = activated ? null : (r?.error || 'license_inactive');
      const license = activated
        ? { ...r.license, status: 'active', error: null, syncPending: false }
        : licenseError({ ...r, error: activationError }, scannerState?.license || DEFAULT_LICENSE);

      await clearCompletedDecisionCache();
      let next = await updateScannerState(current => marketCleared(current, {
        license,
        diagnostics: { access: { state: activated ? 'licensed' : 'license_required', at: Date.now() } }
      }));

      if (activated) {
        await telemetryEvent('license_activated', { plan: license.plan, planLabel: license.planLabel }, settings);
        await telemetryHeartbeat(telemetryState(next), settings, true);
        const connected = await connectActiveTab().catch(() => ({ ok: false }));
        if (connected?.ok) next = await directScanActiveTab(true).catch(() => next);
      }

      sendResponse({ ...r, ok: activated, error: activationError, license, state: next });
    }).catch(e => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }

  if (message?.type === 'ATS_VALIDATE_LICENSE') {
    Promise.all([readScannerState(), chrome.storage.local.get('settings')]).then(async ([scannerState, { settings = {} }]) => {
      const license = await syncLicense(settings, scannerState, true);
      const next = await updateScannerState(current => merge(current, { license }));
      if (license.status === 'active') telemetryHeartbeat(telemetryState(next), settings, true);
      sendResponse({ ok: license.status === 'active', license });
    }).catch(e => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }

  if (message?.type === 'ATS_CLEAR_LICENSE') {
  (async () => {
    await clearLicense();
    await clearCompletedDecisionCache();
    await updateScannerState(current => marketCleared(current, { license: DEFAULT_LICENSE, diagnostics: {} }));
    sendResponse({ ok: true });
  })().catch(e => sendResponse({ ok: false, error: String(e?.message || e) }));
  return true;
}

  if (message?.type === 'ATS_GET_PLATFORM_CONFIG') {
    let host = message.host || '';
    if (!host && sender?.url) try { host = new URL(sender.url).hostname; } catch {}
    const platform = detectPlatform(host);
    sendResponse({ ok: !!platform, platform: platform ? { ...platform } : null });
    return;
  }

  if (message?.type === 'ATS_READ_PLATFORM_CONTROLS') {
    refreshPlatformControls().then(sendResponse).catch(e => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }

  if (message?.type === 'ATS_SYNC_PLATFORM_PREFERENCES') {
    syncPlatformPreferences().then(sendResponse).catch(e => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }

  if (message?.type === 'ATS_PREPARE_TRADE') {
    prepareTrade(String(message.direction || '').toUpperCase()).then(sendResponse).catch(e => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }

  if (message?.type === 'ATS_GET_SESSION_HISTORY') {
    chrome.storage.session.get(SESSION_HISTORY_KEY).then(x => sendResponse({
      ok: true,
      rows: Array.isArray(x[SESSION_HISTORY_KEY]) ? x[SESSION_HISTORY_KEY] : []
    }));
    return true;
  }

  if (message?.type === 'ATS_DOM_CATALOG') {
  const p = message.payload || {};
  (async () => {
    let host = '';
    try { host = new URL(sender?.url || '').hostname; } catch {}
    const platform = detectPlatform(host);
    let response = { ok: true, ignored: true };
    await updateScannerState(current => {
      if (!licenseActive(current.license)) {
        response = { ok: true, ignored: true, reason: 'license_required' };
        return;
      }
      if (!platform || !sameTarget(current, sender)) return;
      const candidate = Array.isArray(p.candidates) ? p.candidates.find(x => x?.asset && num(x?.price) != null) : null;
      const marketCatalog = candidate ? {
        assets: [candidate.asset],
        timeframes: p.timeframe ? [p.timeframe] : [],
        expirations: p.expiration ? [p.expiration] : [],
        lines: [candidate]
      } : current.marketCatalog || { assets: [], timeframes: [], expirations: [], lines: [] };
      response = { ok: true, catalog: marketCatalog };
      return merge(current, {
        marketCatalog,
        diagnostics: {
          ...(current.diagnostics || {}),
          domCatalog: { ...p, lastSeen: Date.now() }
        }
      });
    });
    sendResponse(response);
  })().catch(e => sendResponse({ ok: false, error: String(e?.message || e) }));
  return true;
}

  if (message?.type === 'ATS_NETWORK_DIAGNOSTIC') {
  const p = message.payload || {};
  (async () => {
    let host = '';
    try { host = new URL(sender?.url || '').hostname; } catch {}
    const platform = detectPlatform(host);
    let response = { ok: true, ignored: true };
    await updateScannerState(current => {
      if (!licenseActive(current.license)) {
        response = { ok: true, ignored: true, reason: 'license_required' };
        return;
      }
      if (!platform || !sameTarget(current, sender)) return;
      const network = {
        messages: p.messages || {},
        connections: p.connections || {},
        endpoints: Array.isArray(p.endpoints) ? p.endpoints.slice(-30) : [],
        keys: Array.isArray(p.keys) ? p.keys.slice(0, 180) : [],
        candidates: Array.isArray(p.candidates) ? p.candidates.slice(0, 180).map(x => ({ ...x, source: 'network' })) : [],
        candidateCount: Number(p.candidateCount) || 0,
        recentCandles: p.recentCandles || {},
        feedQuality: Number(p.feedQuality || 0),
        parser: p.parser || {},
        primaryTransport: p.primaryTransport || null,
        lastSeen: Date.now()
      };
      response = { ok: true };
      return merge(current, {
        platformId: platform.id,
        platformName: platform.name,
        diagnostics: { ...(current.diagnostics || {}), network }
      });
    });
    sendResponse(response);
  })().catch(e => sendResponse({ ok: false, error: String(e?.message || e) }));
  return true;
}

  if (message?.type === 'ATS_PLATFORM_SNAPSHOT') {
    const snapshot = message.payload || {};
    Promise.all([readScannerState(), chrome.storage.local.get('settings')]).then(async ([scannerState, { settings = {} }]) => {
      let host = '';
      try { host = new URL(sender?.url || '').hostname; } catch {}
      const platform = detectPlatform(host);
      if (!platform || !sameTarget(scannerState, sender)) return sendResponse({ ok: true, ignored: true });
      const next = await applySnapshot(snapshot, scannerState, settings, platform);
      sendResponse({ ok: true, signal: next.signal, license: next.license });
    }).catch(e => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }

  if (message?.type === 'ATS_GET_STATE') {
  readScannerState().then(async scannerState => {
    if (!licenseActive(scannerState.license)) {
      const locked = await updateScannerState(current => marketCleared(current, {
        license: current.license || DEFAULT_LICENSE,
        diagnostics: { ...(current.diagnostics || {}), access: { state: 'license_required', at: Date.now() } }
      }));
      return sendResponse(merge(locked));
    }
    try {
      const state = await directScanActiveTab();
      sendResponse(merge(state));
    } catch {
      const supported = await ensureSupportedActiveTab();
      sendResponse(merge(supported.scannerState));
    }
  });
  return true;
}

  if (message?.type === 'ATS_SET_SCANNER') {
  Promise.all([readScannerState(), chrome.storage.local.get('settings')]).then(async ([scannerState, { settings = {} }]) => {
    const scanning = !!message.enabled;
    if (scanning && licenseRequired(settings) && !licenseActive(scannerState.license)) {
      return sendResponse({ ok: false, error: 'license_required', state: marketCleared(scannerState, { license: scannerState.license || DEFAULT_LICENSE }) });
    }
    const supported = await ensureSupportedActiveTab();
    if (!supported.platform) return sendResponse({ ok: false, error: 'platform_not_registered', state: supported.scannerState });
    const license = scanning ? await syncLicense(settings, supported.scannerState, true) : supported.scannerState.license;
    if (scanning && licenseRequired(settings) && !licenseActive(license)) return sendResponse({ ok: false, error: 'license_required' });
    const next = await updateScannerState(current => merge(current, { scanner: scanning ? 'scanning' : 'idle', license }));
    sendResponse({ ok: true, state: next });
  }).catch(e => sendResponse({ ok: false, error: String(e?.message || e) }));
  return true;
}

  if (message?.type === 'ATS_RESET_STATE') {
  Promise.all([
    clearCompletedDecisionCache(),
    replaceScannerState(DEFAULT_STATE),
    chrome.storage.session.remove(SESSION_HISTORY_KEY)
  ]).then(() => sendResponse({ ok: true }));
  return true;
}

});