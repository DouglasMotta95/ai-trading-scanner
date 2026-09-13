import { processSnapshot, resetOrchestrator } from './core/orchestrator.js';
import { isCasaTradeHost } from './platforms/registry.js';
import { updateScannerState } from './services/scanner-state-atomic.js';

const allowedTransports = new Set(['ws', 'fetch', 'xhr', 'rendered', 'worker', 'sharedworker', 'broadcast', 'serviceworker', 'window']);
const quotes = new Set(['USDT','USDC','USD','EUR','GBP','JPY','AUD','CAD','CHF','NZD','BRL','BTC','ETH']);
const focusedAssets = new Map();
let lastRun = 0;
const num = v => v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null;
const clean = v => String(v ?? '').trim();
const FOCUS_STABLE_MS = 2000;
const FOCUS_CHANGE_MIN_SCORE = 70;
const licenseActive = state => ['active', 'valid'].includes(String(state?.license?.status || '').toLowerCase());

const trustedEmbeddedHost = host => {
  const h = clean(host).toLowerCase().replace(/\.$/, '');
  return h === 'casatraders.online' || h.endsWith('.casatraders.online') ||
    h === 'ivcasatraders.online' || h.endsWith('.ivcasatraders.online');
};

const normAsset = v => {
  let s = clean(v).toUpperCase();
  if (!s) return '';
  const otc = /(?:\(|\b|[_-])OTC(?:\)|\b)?/.test(s);
  s = s.replace(/\(OTC\)|\bOTC\b/g, '').replace(/^FRX[:_-]?/, '').replace(/\s+/g, '').replace(/_/g, '/').replace(/-/g, '/').replace(/^\/+|\/+$/g, '').replace(/\/{2,}/g, '/');
  if (!s.includes('/')) {
    const q = [...quotes].find(x => s.length > x.length && s.endsWith(x));
    if (q) s = `${s.slice(0, -q.length)}/${q}`;
    else if (/^[A-Z]{6}$/.test(s)) s = `${s.slice(0, 3)}/${s.slice(3)}`;
  }
  const m = s.match(/^([A-Z0-9]{2,16})\/([A-Z0-9]{2,12})$/);
  if (!m || !quotes.has(m[2])) return '';
  return `${m[1]}/${m[2]}${otc ? ' (OTC)' : ''}`;
};

const assetIdentity = value => normAsset(value).replace(/\s*\(OTC\)\s*$/, '');
const sameAsset = (a, b) => {
  const left = assetIdentity(a);
  const right = assetIdentity(b);
  return !!left && !!right && left === right;
};

const normTf = v => {
  const s = clean(v).toUpperCase().replace(/\s+/g, '');
  if (/^\d+M$/.test(s)) return `M${s.replace('M', '')}`;
  if (/^\d+S$/.test(s)) return `S${s.replace('S', '')}`;
  if (/^M\d+$/.test(s) || /^S\d+$/.test(s) || /^H\d+$/.test(s)) return s;
  return null;
};

const normExp = v => {
  const s = clean(v).toLowerCase().replace(/\s+/g, '');
  let m = s.match(/^(\d+)s$/); if (m) return `${Number(m[1])}s`;
  m = s.match(/^(\d+)m(?:in)?$/); if (m) return Number(m[1]) === 1 ? '60s' : `${Number(m[1])}m`;
  return s || null;
};

function sanitizeRows(rows = []) {
  if (!Array.isArray(rows)) return [];
  return rows.slice(-240).map(r => {
    let time = num(r?.time ?? r?.timestamp);
    if (time != null && time > 0 && time < 1e12) time *= 1000;
    const open = num(r?.open), high = num(r?.high), low = num(r?.low), close = num(r?.close);
    if (![time, open, high, low, close].every(Number.isFinite)) return null;
    return { time, open, high, low, close, timeframe: normTf(r?.timeframe) };
  }).filter(Boolean).sort((a, b) => a.time - b.time);
}

function sanitizeRecentCandles(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const out = {};
  for (const [rawAsset, rows] of Object.entries(input).slice(0, 80)) {
    const asset = normAsset(rawAsset);
    const cleanRows = sanitizeRows(rows);
    if (asset && cleanRows.length) out[asset] = cleanRows;
  }
  return out;
}

function normalizedCandidates(payload = {}) {
  return (Array.isArray(payload.candidates) ? payload.candidates : []).slice(0, 240).map(c => {
    const asset = normAsset(c?.asset);
    const bid = num(c?.bid), ask = num(c?.ask);
    const price = num(c?.price) ?? (bid != null && ask != null ? (bid + ask) / 2 : null);
    const transport = clean(c?.transport || payload.primaryTransport || '');
    return { ...c, asset, bid, ask, price, transport };
  }).filter(c => c.asset && c.price != null && c.price > 0 && (!c.transport || allowedTransports.has(c.transport)));
}

const strongCandidate = candidate => !!candidate && (
  candidate.selected === true
  || Number(candidate.confidence || 0) >= 82
  || Number(candidate.seenCount || 0) >= 2
);

function chooseCandidate(payload = {}, preferredAsset = '') {
  const focus = normAsset(preferredAsset);
  let rows = normalizedCandidates(payload);
  if (focus) rows = rows.filter(row => sameAsset(row.asset, focus));
  rows.sort((a, b) =>
    Number(b?.selected === true) - Number(a?.selected === true)
    || Number(b?.confidence || 0) - Number(a?.confidence || 0)
    || Number(b?.seenCount || 0) - Number(a?.seenCount || 0)
    || Number(b?.observedAt || 0) - Number(a?.observedAt || 0)
  );
  const candidate = rows[0] || null;
  return focus || strongCandidate(candidate) ? candidate : null;
}

function focusedAssetFor(tabId, scannerState = {}) {
  const inMemory = normAsset(focusedAssets.get(tabId)?.asset);
  if (inMemory) return inMemory;
  const stored = normAsset(scannerState?.diagnostics?.focusedAsset?.asset);
  return stored || '';
}

async function keepRealFeedContext(payload = {}, sender = {}) {
  if (Date.now() - lastRun < 80) return;
  lastRun = Date.now();
  const { settings = {} } = await chrome.storage.local.get('settings');
  if (settings.runtimePaused) return;

  return updateScannerState(scannerState => {
    if (!licenseActive(scannerState)) return;
    if (scannerState.targetTabId && sender?.tab?.id && scannerState.targetTabId !== sender.tab.id) return;

    const recentCandles = sanitizeRecentCandles(payload.recentCandles || {});
    const candidates = normalizedCandidates(payload);
    const previousNetwork = scannerState.diagnostics?.network || {};
    const mergedHistory = { ...(previousNetwork.recentCandles || {}) };
    for (const [asset, rows] of Object.entries(recentCandles)) {
      const previous = Array.isArray(mergedHistory[asset]) ? mergedHistory[asset] : [];
      const byTime = new Map([...previous, ...rows].map(row => [`${row.time}|${row.timeframe || ''}`, row]));
      mergedHistory[asset] = [...byTime.values()].sort((a, b) => a.time - b.time).slice(-240);
    }

    const previousCandidates = Array.isArray(previousNetwork.candidates) ? previousNetwork.candidates : [];
    const mergedCandidates = [...candidates, ...previousCandidates].filter((c, index, arr) => {
      const asset = normAsset(c?.asset);
      const price = num(c?.price) ?? ((num(c?.bid) != null && num(c?.ask) != null) ? (num(c.bid) + num(c.ask)) / 2 : null);
      if (!asset || price == null || price <= 0) return false;
      return arr.findIndex(x => normAsset(x?.asset) === asset && clean(x?.transport) === clean(c?.transport)) === index;
    }).slice(0, 180);

    return {
      ...scannerState,
      marketHistory: mergedHistory,
      diagnostics: {
        ...(scannerState.diagnostics || {}),
        network: {
          ...previousNetwork,
          messages: payload.messages || previousNetwork.messages || {},
          connections: payload.connections || previousNetwork.connections || {},
          endpoints: Array.isArray(payload.endpoints) ? payload.endpoints.slice(-30) : (previousNetwork.endpoints || []),
          keys: Array.isArray(payload.keys) ? payload.keys.slice(0, 180) : (previousNetwork.keys || []),
          candidates: mergedCandidates,
          candidateCount: mergedCandidates.length,
          recentCandles: mergedHistory,
          feedQuality: Math.max(Number(previousNetwork.feedQuality || 0), Number(payload.feedQuality || 0)),
          parser: { ...(previousNetwork.parser || {}), ...(payload.parser || {}) },
          primaryTransport: payload.primaryTransport || previousNetwork.primaryTransport || null,
          lastSeen: Date.now()
        }
      }
    };
  });
}

async function setFocusedAsset(message = {}, sender = {}) {
  const focused = normAsset(message.asset);
  if (!focused || !sender?.tab?.id || sender.frameId !== 0) return;

  let senderHost = '';
  try { senderHost = new URL(sender.url || sender.tab.url || '').hostname; } catch {}
  if (!isCasaTradeHost(senderHost)) return;

  const tabId = sender.tab.id;
  const previousFocus = focusedAssets.get(tabId) || null;
  const score = Number(message.score || 0);
  const samples = Number(message.samples || 0);
  const reliable = message.reliable === true || score >= FOCUS_CHANGE_MIN_SCORE || samples >= 2;
  if (previousFocus?.asset && !sameAsset(previousFocus.asset, focused) && !reliable) return;

  focusedAssets.set(tabId, { asset: focused, score, samples, reliable, at: Date.now() });

  return updateScannerState(scannerState => {
    if (!licenseActive(scannerState)) return;
    if (scannerState.targetTabId && scannerState.targetTabId !== tabId) return;

    const previousStored = scannerState.diagnostics?.focusedAsset || null;
    const sameStoredFocus = sameAsset(previousStored?.asset, focused);
    if (previousStored?.asset && !sameStoredFocus && !reliable) return;

    const changed = (!!previousFocus?.asset && !sameAsset(previousFocus.asset, focused)) || (!!previousStored?.asset && !sameStoredFocus);
    const stateAssetMismatch = scannerState.asset && !sameAsset(scannerState.asset, focused);
    const stableSince = sameStoredFocus
      ? Number(previousStored?.stableSince || previousStored?.at || Date.now())
      : Date.now();
    if ((changed || stateAssetMismatch) && reliable) resetOrchestrator();

    return {
      ...scannerState,
      targetTabId: tabId,
      ...((changed || stateAssetMismatch) && reliable ? {
        asset: focused,
        price: null,
        candles: [],
        currentCandle: null,
        signal: null,
        lastSeen: Date.now()
      } : {}),
      diagnostics: {
        ...(scannerState.diagnostics || {}),
        focusedAsset: {
          asset: focused,
          at: Date.now(),
          stableSince,
          score,
          samples,
          reliable,
          source: message.source || 'chart-header'
        }
      }
    };
  });
}

async function applyEmbeddedFeed(payload = {}, sender = {}) {
  let frameHost = '';
  let topHost = '';
  try { frameHost = new URL(sender?.url || '').hostname; } catch {}
  try { topHost = new URL(sender?.tab?.url || '').hostname; } catch {}
  if (!trustedEmbeddedHost(frameHost) || !isCasaTradeHost(topHost) || !sender?.tab?.id) return;

  await keepRealFeedContext(payload, sender).catch(() => {});
  const { settings = {} } = await chrome.storage.local.get('settings');
  if (settings.runtimePaused) return;

  return updateScannerState(scannerState => {
    if (!licenseActive(scannerState)) return;
    if (scannerState.targetTabId && scannerState.targetTabId !== sender.tab.id) return;

    const focus = focusedAssetFor(sender.tab.id, scannerState);
    const focusMeta = scannerState.diagnostics?.focusedAsset || null;
    const stableSince = Number(focusMeta?.stableSince || focusMeta?.at || 0);
    const focusStable = !!focus && sameAsset(focusMeta?.asset, focus)
      && Number.isFinite(stableSince) && stableSince > 0 && Date.now() - stableSince >= FOCUS_STABLE_MS;

    const focusedCandidate = focus ? chooseCandidate(payload, focus) : null;
    const fallbackCandidate = focusedCandidate || chooseCandidate(payload, '');
    if (!fallbackCandidate) return;

    const focusCorroborated = !!focus && sameAsset(fallbackCandidate.asset, focus);
    const focusReliable = focusMeta?.reliable === true || Number(focusMeta?.score || 0) >= FOCUS_CHANGE_MIN_SCORE;
    const asset = focus && (focusCorroborated || focusStable || focusReliable)
      ? focus
      : normAsset(fallbackCandidate.asset);
    const candidate = sameAsset(fallbackCandidate.asset, asset)
      ? fallbackCandidate
      : chooseCandidate(payload, asset);
    if (!asset || !candidate || !sameAsset(candidate.asset, asset)) return;

    const allHistory = sanitizeRecentCandles(payload.recentCandles || {});
    const historyKey = Object.keys(allHistory).find(k => sameAsset(k, asset));
    const candles = historyKey ? allHistory[historyKey] : [];
    const timeframe = normTf(candidate.timeframe) || candles.at(-1)?.timeframe || scannerState.analysisTimeframe || scannerState.timeframe || 'M1';
    const expiration = normExp(candidate.expiration) || scannerState.targetExpiration || scannerState.expiration || null;
    const secondsRemaining = num(candidate.secondsRemaining ?? payload.secondsRemaining);

    const snapshot = {
      platformId: 'casatrade',
      platformName: 'CasaTrade',
      connection: 'online',
      asset,
      price: Number(candidate.price),
      timeframe,
      analysisTimeframe: timeframe,
      expiration,
      targetExpiration: expiration,
      secondsRemaining,
      serverTime: num(candidate.timestamp) || null,
      candles,
      capabilities: {
        structuredQuotes: true,
        candles: candles.length >= 3,
        expiration: !!expiration,
        multiAsset: false
      }
    };

    if (scannerState.asset && !sameAsset(scannerState.asset, asset)) resetOrchestrator();
    const assetSource = focus && sameAsset(asset, focus)
      ? (focusStable ? 'focused-stable' : 'focused-corroborated')
      : 'network-fallback';
    const base = {
      ...scannerState,
      ...snapshot,
      targetTabId: sender.tab.id,
      scanner: 'scanning',
      connection: 'online',
      lastSeen: Date.now(),
      platformControls: {
        ...(scannerState.platformControls || {}),
        observed: {
          ...(scannerState.platformControls?.observed || {}),
          timeframe,
          expiration,
          detected: { timeframe: !!timeframe, expiration: !!expiration },
          at: Date.now()
        }
      },
      diagnostics: {
        ...(scannerState.diagnostics || {}),
        focusGate: {
          state: assetSource === 'network-fallback' ? 'fallback' : 'ready',
          focusedAsset: focus || null,
          receivedAsset: normAsset(candidate.asset),
          resolvedAsset: asset,
          assetSource,
          stable: focusStable,
          reason: assetSource === 'network-fallback' ? 'Foco ainda não confirmado; usando cotação de rede consistente.' : null,
          at: Date.now()
        },
        acquisition: {
          stage: candles.length >= 3 ? 'diagnosing_next_candle' : 'reading_history',
          reason: candles.length >= 3 ? 'Ativo e preço confirmados; analisando a próxima vela.' : `Lendo histórico de velas (${candles.length}/3).`,
          assetSource,
          priceSource: `network:${candidate.transport || payload.primaryTransport || 'market'}`,
          candleCount: candles.length,
          requiredCandles: 3,
          at: Date.now()
        },
        embeddedFeed: {
          frameHost,
          transport: candidate.transport || payload.primaryTransport || null,
          candidateCount: normalizedCandidates(payload).length,
          filteredTo: asset,
          candleCount: candles.length,
          at: Date.now()
        }
      }
    };

    const processed = processSnapshot(snapshot, base);
    const processedCount = Number(processed.signal?.candleCount ?? candles.length ?? 0);
    const stage = processedCount < 3 || processed.signal?.state === 'SEARCHING'
      ? 'reading_history'
      : 'diagnosing_next_candle';
    return {
      ...base,
      ...processed,
      license: scannerState.license,
      diagnostics: {
        ...base.diagnostics,
        acquisition: {
          ...base.diagnostics.acquisition,
          stage,
          reason: stage === 'reading_history'
            ? `Lendo histórico de velas (${processedCount}/3).`
            : 'Analisando a vela atual e calculando o diagnóstico da próxima vela.',
          candleCount: processedCount,
          at: Date.now()
        }
      }
    };
  });
}

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type === 'ATS_FOCUSED_ASSET') {
    setTimeout(() => setFocusedAsset(message, sender).catch(() => {}), 0);
  }
  if (message?.type === 'ATS_NETWORK_DIAGNOSTIC') {
    setTimeout(() => keepRealFeedContext(message.payload || {}, sender).catch(() => {}), 30);
  }
  if (message?.type === 'ATS_EMBEDDED_FEED') {
    setTimeout(() => applyEmbeddedFeed(message.payload || {}, sender).catch(() => {}), 0);
  }
});
