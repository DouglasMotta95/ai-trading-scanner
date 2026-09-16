import { normalizeAsset, normalizeTimeframe, sameAsset } from './market-normalizers.js';

export function resetMarketSession(state = {}, { asset, timeframe = null, frameId = null, frameHost = '', source = 'asset-switch', reason = '' } = {}) {
  const nextAsset = normalizeAsset(asset);
  const tf = normalizeTimeframe(timeframe);
  const previous = state.diagnostics?.marketSession || {};
  const epoch = Math.max(0, Number(previous.epoch || 0)) + 1;
  return {
    ...state,
    connection: 'connecting',
    asset: nextAsset || null,
    price: null,
    timeframe: tf,
    analysisTimeframe: tf,
    expiration: null,
    targetExpiration: null,
    serverTime: null,
    candles: [],
    currentCandle: null,
    marketHistory: {},
    signal: null,
    professionalDecision: null,
    aiAudit: null,
    lastConfirmed: null,
    tradeIntent: null,
    lastSeen: null,
    decisionCycle: null,
    decisionTrace: [],
    platformControls: null,
    diagnostics: {
      ...(state.diagnostics || {}),
      marketClock: null,
      marketSession: { epoch, asset: nextAsset || null, timeframe: tf, frameId, frameHost, source, startedAt: Date.now(), dataMode: 'syncing' },
      acquisition: { stage: 'syncing_session', reason: reason || `Ativo ${nextAsset || '—'} selecionado. Reiniciando leitura limpa.`, at: Date.now() }
    }
  };
}

export function sessionChanged(state = {}, asset = '', timeframe = null) {
  const currentAsset = state.diagnostics?.marketSession?.asset || state.asset;
  const currentTf = normalizeTimeframe(state.diagnostics?.marketSession?.timeframe || state.analysisTimeframe || state.timeframe);
  const nextTf = normalizeTimeframe(timeframe);
  return !sameAsset(currentAsset, asset) || (!!currentTf && !!nextTf && currentTf !== nextTf);
}
