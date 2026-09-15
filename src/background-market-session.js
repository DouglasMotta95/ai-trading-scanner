import { processSnapshot, resetOrchestrator } from './core/orchestrator.js';
import { updateScannerState } from './services/scanner-state-atomic.js';

const clean = value => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
const num = value => value == null || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null;
const traderHost = value => value === 'casatraders.online' || value.endsWith('.casatraders.online') || value === 'ivcasatraders.online' || value.endsWith('.ivcasatraders.online');
const casaHost = value => value === 'casatrade.com' || value.endsWith('.casatrade.com') || value === 'casatrade.io' || value.endsWith('.casatrade.io');
const licenseActive = state => ['active', 'valid'].includes(String(state?.license?.status || '').toLowerCase());
const CLOCK_FRESH_MS = 2200;
const FOCUS_FRESH_MS = 5000;

function normAsset(value = '') {
  const raw = clean(value).toUpperCase();
  if (!raw || raw.length > 100) return '';
  const otc = /(?:\(|\b|[_-])OTC(?:\)|\b)?/i.test(raw);
  const direct = raw.match(/\b([A-Z0-9]{2,20})\s*[\/_-]\s*([A-Z0-9]{2,12})/i);
  if (!direct) return '';
  return `${direct[1]}/${direct[2]}${otc ? ' (OTC)' : ''}`;
}
const marketId = value => normAsset(value);
const sameMarket = (a, b) => !!marketId(a) && marketId(a) === marketId(b);

function normTf(value) {
  const s = clean(value).toUpperCase().replace(/\s+/g, '');
  let m = s.match(/^S(\d{1,5})$/); if (m && Number(m[1]) > 0) return `S${Number(m[1])}`;
  m = s.match(/^M(\d{1,4})$/); if (m && Number(m[1]) > 0) return `M${Number(m[1])}`;
  m = s.match(/^H(\d{1,3})$/); if (m && Number(m[1]) > 0) return `H${Number(m[1])}`;
  m = s.match(/^(\d{1,5})S$/); if (m && Number(m[1]) > 0) return `S${Number(m[1])}`;
  m = s.match(/^(\d{1,4})M$/); if (m && Number(m[1]) > 0) return `M${Number(m[1])}`;
  return null;
}

function senderMeta(sender = {}) {
  let frameHost = '', topHost = '';
  try { frameHost = new URL(sender.url || '').hostname.toLowerCase(); } catch {}
  try { topHost = new URL(sender.tab?.url || '').hostname.toLowerCase(); } catch {}
  return {
    trusted: !!sender.tab?.id && sender.frameId !== 0 && traderHost(frameHost) && casaHost(topHost),
    frameHost, topHost, frameId: sender.frameId, tabId: sender.tab?.id || null
  };
}

function normalizeTime(value) {
  let t = num(value);
  if (t != null && t > 0 && t < 1e12) t *= 1000;
  return Number.isFinite(t) && t > 0 ? t : null;
}

function sanitizeRows(rows = []) {
  if (!Array.isArray(rows)) return [];
  const byKey = new Map();
  for (const raw of rows.slice(-300)) {
    const time = normalizeTime(raw?.time ?? raw?.timestamp);
    const open = num(raw?.open), high = num(raw?.high), low = num(raw?.low), close = num(raw?.close);
    if (time == null || ![open, high, low, close].every(Number.isFinite)) continue;
    const timeframe = normTf(raw?.timeframe);
    byKey.set(`${time}|${timeframe || ''}`, { time, open, high, low, close, timeframe });
  }
  return [...byKey.values()].sort((a, b) => a.time - b.time).slice(-240);
}

function mergeRows(a = [], b = []) {
  return sanitizeRows([...sanitizeRows(a), ...sanitizeRows(b)]);
}

function candidates(payload = {}) {
  return (Array.isArray(payload.candidates) ? payload.candidates : []).map(row => {
    const asset = normAsset(row?.asset);
    const bid = num(row?.bid), ask = num(row?.ask);
    const price = num(row?.price) ?? (bid != null && ask != null ? (bid + ask) / 2 : null);
    return { ...row, asset, price, bid, ask };
  }).filter(row => row.asset && row.price != null && row.price > 0);
}

function bestForFocus(payload = {}, focus = '') {
  const rows = candidates(payload).filter(row => sameMarket(row.asset, focus));
  rows.sort((a, b) => Number(b.selected === true) - Number(a.selected === true)
    || Number(b.confidence || 0) - Number(a.confidence || 0)
    || Number(b.observedAt || 0) - Number(a.observedAt || 0));
  return rows[0] || null;
}

function historyFor(payload = {}, focus = '') {
  const source = payload.recentCandles || {};
  const key = Object.keys(source).find(asset => sameMarket(asset, focus));
  return key ? sanitizeRows(source[key]) : [];
}

function stateHistory(state = {}, asset = '') {
  const source = state.marketHistory || {};
  const key = Object.keys(source).find(value => sameMarket(value, asset));
  const fromHistory = key ? sanitizeRows(source[key]) : [];
  return fromHistory.length ? fromHistory : sanitizeRows(state.candles || []);
}

function exactClock(state = {}, info = null) {
  const focus = state.diagnostics?.focusedAsset || null;
  const clock = state.diagnostics?.marketClock || null;
  if (!focus || !clock || !focus.asset) return null;
  if (focus.reliable !== true || focus.chartScoped !== true || focus.embeddedTrader !== true) return null;
  if (Date.now() - Number(focus.at || 0) > FOCUS_FRESH_MS) return null;
  if (clock.verified !== true || clean(clock.role) !== 'candle-close') return null;
  if (!['trader-dom-countdown', 'network-server-cycle'].includes(clean(clock.source))) return null;
  if (Date.now() - Number(clock.at || 0) > CLOCK_FRESH_MS) return null;
  if (!sameMarket(clock.asset, focus.asset)) return null;
  if (Number(clock.frameId) !== Number(focus.frameId)) return null;
  if (clean(clock.frameHost).toLowerCase() !== clean(focus.frameHost).toLowerCase()) return null;
  if (info && (Number(info.frameId) !== Number(focus.frameId) || info.frameHost !== clean(focus.frameHost).toLowerCase())) return null;
  if (num(clock.secondsRemaining) == null) return null;
  return clock;
}

function nextEpoch(previous = {}) {
  return Math.max(0, Number(previous?.epoch || 0)) + 1;
}

function resetForSession(state = {}, { asset, timeframe = null, info, reason, source }) {
  resetOrchestrator();
  const previous = state.diagnostics?.marketSession || {};
  const epoch = nextEpoch(previous);
  return {
    ...state,
    connection: 'connecting',
    asset,
    price: null,
    timeframe,
    analysisTimeframe: timeframe,
    expiration: null,
    targetExpiration: null,
    serverTime: null,
    candles: [],
    currentCandle: null,
    marketHistory: {},
    signal: null,
    lastConfirmed: null,
    tradeIntent: null,
    lastSeen: null,
    platformControls: timeframe ? state.platformControls : null,
    diagnostics: {
      ...(state.diagnostics || {}),
      marketClock: null,
      marketSession: {
        epoch, asset, timeframe, frameId: info?.frameId ?? null, frameHost: info?.frameHost || null,
        source: source || 'visible-chart', startedAt: Date.now(), dataMode: 'syncing'
      },
      acquisition: { stage: 'syncing_session', reason, at: Date.now() }
    }
  };
}

function clockRecord(message = {}, info = {}, asset = '', timeframe = null, secondsRemaining = null) {
  return {
    asset, timeframe, secondsRemaining, available: true, verified: true, role: 'candle-close',
    source: clean(message.clockSource), mode: clean(message.clockMode || 'exact'), confidence: Number(message.confidence || 0),
    text: clean(message.clockText || ''), token: clean(message.clockToken || ''),
    frameId: info.frameId, frameHost: info.frameHost, at: Date.now()
  };
}

function evaluateAtClock(state = {}, focus = null, clock = null) {
  if (!focus?.asset || !clock || num(state.price) == null) return state;
  if (!sameMarket(state.asset, focus.asset)) return state;
  const timeframe = normTf(clock.timeframe || state.analysisTimeframe || state.timeframe);
  if (!timeframe) return state;
  const rows = stateHistory(state, focus.asset);
  if (rows.length < 2) return state;

  const snapshot = {
    platformId: 'casatrade', platformName: 'CasaTrade', connection: 'online',
    asset: normAsset(focus.asset), price: Number(state.price),
    timeframe, analysisTimeframe: timeframe,
    expiration: state.targetExpiration || state.expiration || null,
    secondsRemaining: Number(clock.secondsRemaining),
    serverTime: Date.now(), candles: rows,
    capabilities: { ...(state.capabilities || {}), structuredQuotes: true, candles: true },
    diagnostics: { capture: 'exact-clock-heartbeat', feedQuality: Number(state.diagnostics?.acquisition?.feedQuality || 0) }
  };
  const processed = processSnapshot(snapshot, state);
  if (!processed) return state;
  return {
    ...state,
    ...processed,
    platformId: 'casatrade', platformName: 'CasaTrade',
    asset: normAsset(focus.asset), price: Number(state.price),
    timeframe, analysisTimeframe: timeframe,
    expiration: state.targetExpiration || state.expiration || null,
    targetExpiration: state.targetExpiration || state.expiration || null,
    serverTime: snapshot.serverTime,
    candles: rows,
    marketHistory: state.marketHistory || {},
    lastSeen: state.lastSeen,
    connection: state.connection,
    diagnostics: {
      ...(state.diagnostics || {}),
      ...(processed.diagnostics || {}),
      focusedAsset: focus,
      marketClock: clock,
      marketSession: state.diagnostics?.marketSession || null
    }
  };
}

async function applyFocus(message = {}, sender = {}) {
  const info = senderMeta(sender);
  if (!info.trusted || message.chartScoped !== true || message.reliable !== true || message.frameRole !== 'trader-frame') return null;
  const asset = normAsset(message.asset);
  if (!asset) return null;
  return updateScannerState(state => {
    if (!licenseActive(state)) return;
    if (state.targetTabId && state.targetTabId !== info.tabId) return;
    const old = state.diagnostics?.focusedAsset || null;
    const changed = !sameMarket(old?.asset, asset) || Number(old?.frameId) !== Number(info.frameId) || clean(old?.frameHost).toLowerCase() !== info.frameHost;
    let next = state;
    if (changed || (state.asset && !sameMarket(state.asset, asset))) {
      next = resetForSession(state, {
        asset, info, source: clean(message.source || 'visible-chart'),
        reason: `Ativo ${asset} confirmado no gráfico. Sincronizando a sessão ao vivo.`
      });
    }
    return {
      ...next,
      targetTabId: info.tabId,
      platformId: 'casatrade', platformName: 'CasaTrade', scanner: 'scanning',
      diagnostics: {
        ...(next.diagnostics || {}),
        focusedAsset: {
          asset, at: Date.now(), stableSince: changed ? Date.now() : Number(old?.stableSince || old?.at || Date.now()),
          score: Number(message.score || 0), samples: Number(message.samples || 0), reliable: true,
          visual: true, explicit: message.explicit === true, chartScoped: true, embeddedTrader: true,
          frameRole: 'trader-frame', frameId: info.frameId, frameHost: info.frameHost,
          source: clean(message.source || 'visible-chart')
        }
      }
    };
  });
}

async function applyClock(message = {}, sender = {}) {
  const info = senderMeta(sender);
  if (!info.trusted) return null;
  const asset = normAsset(message.asset);
  const timeframe = normTf(message.timeframe);
  const secondsRemaining = num(message.secondsRemaining);
  const exact = message.verified === true && message.available !== false && clean(message.clockRole) === 'candle-close'
    && ['trader-dom-countdown', 'network-server-cycle'].includes(clean(message.clockSource));

  return updateScannerState(state => {
    if (!licenseActive(state)) return;
    const focus = state.diagnostics?.focusedAsset || null;
    if (!focus?.asset || !sameMarket(focus.asset, asset) || Number(focus.frameId) !== Number(info.frameId) || clean(focus.frameHost).toLowerCase() !== info.frameHost) return;

    if (!exact || secondsRemaining == null || secondsRemaining < 0) {
      return {
        ...state,
        signal: null,
        diagnostics: {
          ...(state.diagnostics || {}),
          marketClock: {
            asset, timeframe, available: false, verified: false, role: 'candle-close',
            source: clean(message.clockSource || 'unverified'), mode: clean(message.clockMode || ''),
            frameId: info.frameId, frameHost: info.frameHost, at: Date.now()
          },
          acquisition: { ...(state.diagnostics?.acquisition || {}), stage: 'syncing_clock', reason: 'Aguardando o fechamento exato da vela da CasaTrade.', at: Date.now() }
        }
      };
    }

    const session = state.diagnostics?.marketSession || {};
    const sessionChanged = !sameMarket(session.asset, asset) || clean(session.timeframe).toUpperCase() !== clean(timeframe).toUpperCase()
      || Number(session.frameId) !== Number(info.frameId) || clean(session.frameHost).toLowerCase() !== info.frameHost;
    let next = state;
    if (sessionChanged) {
      next = resetForSession(state, {
        asset, timeframe, info, source: 'exact-candle-clock',
        reason: `Sessão ${asset} • ${timeframe || '—'} sincronizada ao fechamento real da vela.`
      });
    }

    const record = clockRecord(message, info, asset, timeframe, secondsRemaining);
    const clockState = {
      ...next,
      connection: next.price != null ? 'online' : 'connecting',
      timeframe: timeframe || next.timeframe,
      analysisTimeframe: timeframe || next.analysisTimeframe,
      expiration: message.expiration || next.expiration || null,
      targetExpiration: message.expiration || next.targetExpiration || null,
      diagnostics: {
        ...(next.diagnostics || {}),
        marketClock: record,
        marketSession: {
          ...(next.diagnostics?.marketSession || {}), asset, timeframe,
          frameId: info.frameId, frameHost: info.frameHost, dataMode: next.price != null ? 'live' : 'syncing'
        }
      }
    };

    // A timeframe/frame/asset change starts an empty session. Never analyze old
    // candles during that clock tick; wait for the new market feed to hydrate it.
    if (sessionChanged) return clockState;

    // The exact candle-close clock is the heartbeat of the decision cycle. This
    // advances BUILDING/POSSIBLE/DECIDING/ENTER/SKIP even if the network feed does
    // not emit another packet during the final seconds of the current candle.
    return evaluateAtClock(clockState, focus, record);
  });
}

async function applyFeed(payload = {}, sender = {}) {
  const info = senderMeta(sender);
  if (!info.trusted) return null;
  return updateScannerState(state => {
    if (!licenseActive(state)) return;
    if (state.targetTabId && state.targetTabId !== info.tabId) return;
    const focus = state.diagnostics?.focusedAsset || null;
    if (!focus?.asset || Number(focus.frameId) !== Number(info.frameId) || clean(focus.frameHost).toLowerCase() !== info.frameHost) return;
    const asset = normAsset(focus.asset);
    const candidate = bestForFocus(payload, asset);
    if (!candidate) return;

    const incomingHistory = historyFor(payload, asset);
    const previousHistory = stateHistory(state, asset);
    const mergedHistory = mergeRows(previousHistory, incomingHistory);
    const marketHistory = { ...(state.marketHistory || {}), [asset]: mergedHistory };
    const clock = exactClock(state, info);
    const timeframe = normTf(clock?.timeframe || state.analysisTimeframe || candidate.timeframe) || null;
    const price = Number(candidate.price);
    const serverTime = normalizeTime(candidate.timestamp) || Date.now();
    const snapshot = {
      platformId: 'casatrade', platformName: 'CasaTrade', connection: 'online', asset, price,
      timeframe, analysisTimeframe: timeframe,
      expiration: state.targetExpiration || state.expiration || candidate.expiration || null,
      secondsRemaining: clock ? Number(clock.secondsRemaining) : null,
      serverTime, candles: mergedHistory,
      capabilities: { ...(state.capabilities || {}), structuredQuotes: true, candles: mergedHistory.length >= 2 },
      diagnostics: { capture: `embedded:${candidate.transport || payload.primaryTransport || 'market'}`, feedQuality: Number(payload.feedQuality || 0) }
    };

    let processed = null;
    if (clock) processed = processSnapshot(snapshot, { ...state, marketHistory });
    const historicalJump = incomingHistory.length > 1 && mergedHistory.length - previousHistory.length > 1;
    const next = processed || {
      ...state, asset, price, timeframe, analysisTimeframe: timeframe, serverTime,
      candles: mergedHistory, lastSeen: Date.now(), connection: 'online', marketHistory,
      signal: null
    };
    return {
      ...next,
      targetTabId: info.tabId,
      platformId: 'casatrade', platformName: 'CasaTrade', scanner: 'scanning',
      asset, price, timeframe: timeframe || next.timeframe, analysisTimeframe: timeframe || next.analysisTimeframe,
      serverTime, marketHistory, candles: mergedHistory, lastSeen: Date.now(), connection: 'online',
      diagnostics: {
        ...(state.diagnostics || {}), ...(next.diagnostics || {}),
        focusedAsset: focus,
        marketClock: state.diagnostics?.marketClock || null,
        marketSession: {
          ...(state.diagnostics?.marketSession || {}), asset, timeframe,
          frameId: info.frameId, frameHost: info.frameHost,
          dataMode: historicalJump ? 'backfill' : 'live',
          lastLiveAt: Date.now(), historyCount: mergedHistory.length
        },
        acquisition: {
          stage: clock ? 'diagnosing_next_candle' : 'syncing_clock',
          reason: clock ? `Sessão ao vivo ${asset} • ${timeframe || '—'} sincronizada.` : 'Preço e histórico prontos. Aguardando o fechamento exato da vela.',
          priceSource: candidate.transport || payload.primaryTransport || 'market', candleCount: mergedHistory.length, requiredCandles: 2,
          feedQuality: Number(payload.feedQuality || 0), at: Date.now()
        },
        inspector: state.diagnostics?.inspector || null
      }
    };
  });
}

async function applyChartPrice(message = {}, sender = {}) {
  const info = senderMeta(sender);
  if (!info.trusted) return null;
  const price = num(message.price);
  if (price == null || price <= 0) return null;
  return updateScannerState(state => {
    if (!licenseActive(state)) return;
    const focus = state.diagnostics?.focusedAsset || null;
    if (!focus?.asset || Number(focus.frameId) !== Number(info.frameId) || clean(focus.frameHost).toLowerCase() !== info.frameHost) return;
    if (message.asset && !sameMarket(message.asset, focus.asset)) return;
    const clock = exactClock(state, info);
    return {
      ...state,
      asset: normAsset(focus.asset), price, lastSeen: Date.now(), connection: 'online',
      ...(!clock ? { signal: null } : {}),
      diagnostics: {
        ...(state.diagnostics || {}),
        marketSession: { ...(state.diagnostics?.marketSession || {}), dataMode: 'live', lastLiveAt: Date.now() },
        acquisition: {
          ...(state.diagnostics?.acquisition || {}),
          stage: clock ? 'diagnosing_next_candle' : 'syncing_clock',
          reason: clock ? 'Cotação e relógio da vela sincronizados.' : 'Cotação do gráfico pronta. Aguardando fechamento exato da vela.',
          priceSource: clean(message.priceSource || 'visible-chart'), at: Date.now()
        }
      }
    };
  });
}

async function applyInspector(message = {}, sender = {}) {
  const info = senderMeta(sender);
  if (!info.trusted) return null;
  const snapshot = message.snapshot && typeof message.snapshot === 'object' ? message.snapshot : {};
  return updateScannerState(state => {
    if (!licenseActive(state)) return;
    const focus = state.diagnostics?.focusedAsset || null;
    if (focus?.frameId != null && Number(focus.frameId) !== Number(info.frameId)) return;
    return {
      ...state,
      diagnostics: {
        ...(state.diagnostics || {}),
        inspector: {
          frameId: info.frameId, frameHost: info.frameHost, at: Date.now(),
          transports: snapshot.transports || {}, endpoints: Array.isArray(snapshot.endpoints) ? snapshot.endpoints.slice(-12) : [],
          keys: Array.isArray(snapshot.keys) ? snapshot.keys.slice(0, 80) : [],
          focusedCandidate: snapshot.focusedCandidate || null,
          candleCount: Number(snapshot.candleCount || 0),
          rawCandidateCount: Number(snapshot.rawCandidateCount || 0)
        }
      }
    };
  });
}

let repairing = false;
chrome.storage.onChanged.addListener(changes => {
  if (!changes.scannerState || repairing) return;
  const state = changes.scannerState.newValue || {};
  if (!licenseActive(state)) return;
  const focus = state.diagnostics?.focusedAsset || null;
  const session = state.diagnostics?.marketSession || null;
  if (!focus?.asset || !session?.asset) return;
  const mismatch = (state.asset && !sameMarket(state.asset, session.asset))
    || (state.analysisTimeframe && session.timeframe && normTf(state.analysisTimeframe) !== normTf(session.timeframe));
  if (!mismatch) return;
  repairing = true;
  updateScannerState(current => resetForSession(current, {
    asset: normAsset(focus.asset), timeframe: normTf(session.timeframe),
    info: { frameId: focus.frameId, frameHost: clean(focus.frameHost).toLowerCase() },
    source: 'session-integrity', reason: 'Dado atrasado de outra sessão foi bloqueado.'
  })).finally(() => { repairing = false; });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  let task = null;
  if (message?.type === 'ATS_VISUAL_FOCUS_V2') task = applyFocus(message, sender);
  else if (message?.type === 'ATS_MARKET_CLOCK_V2') task = applyClock(message, sender);
  else if (message?.type === 'ATS_EMBEDDED_FEED') task = applyFeed(message.payload || {}, sender);
  else if (message?.type === 'ATS_CHART_FRAME_MARKET') task = applyChartPrice(message, sender);
  else if (message?.type === 'ATS_DATA_INSPECTOR') task = applyInspector(message, sender);
  if (!task) return false;
  Promise.resolve(task).then(state => sendResponse({ ok: true, state })).catch(error => sendResponse({ ok: false, error: String(error?.message || error) }));
  return true;
});
