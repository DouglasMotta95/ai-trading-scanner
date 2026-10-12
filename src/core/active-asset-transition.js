const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const marketId = value => {
  const raw = clean(value).toUpperCase();
  if (!raw) return '';
  const otc = /(?:\(|\b|[_-])OTC(?:\)|\b)?/.test(raw);
  const match = raw.match(/\b([A-Z0-9]{2,20})\s*[\/_-]\s*([A-Z0-9]{2,12})/);
  return match ? `${match[1]}/${match[2]}${otc ? ' (OTC)' : ''}` : raw;
};
const sameMarket = (a, b) => !!marketId(a) && marketId(a) === marketId(b);

/**
 * Detect that the selected/focused asset has moved on while the decision or last
 * candle still belongs to the prior asset. This is a display/analysis reset only;
 * it never authorizes an order.
 */
export function activeAssetTransitionNeeded(state = {}) {
  const focus = state.diagnostics?.focusedAsset || {};
  const target = marketId(state.asset || '');
  const focused = marketId(focus.asset || '');
  if (!target || !focused || target !== focused) return false;
  if (focus.reliable !== true || focus.chartScoped !== true || focus.trustedChartFrame !== true) return false;
  const existing = marketId(state.signal?.asset || '');
  const candle = marketId(state.currentCandle?.asset || '');
  return (!!existing && existing !== target) || (!!candle && candle !== target);
}

export function clearStaleAssetDecision(state = {}, now = Date.now()) {
  const focus = state.diagnostics?.focusedAsset || {};
  const target = marketId(state.asset || '');
  const from = marketId(state.signal?.asset || state.currentCandle?.asset || '') || null;
  if (!activeAssetTransitionNeeded(state) || !target) return state;
  const previous = state.diagnostics?.activeAssetTransition || {};
  if (marketId(previous.to || '') === target && previous.clearedAt > 0) return state;
  return {
    ...state,
    signal: null,
    professionalDecision: null,
    decisionCycle: null,
    candidateBlockerTrace: [],
    // Keep the prior candle as evidence that fresh current-asset data is still
    // required. historyFor will refuse to fall back to unkeyed candles until it
    // is replaced by a candle tagged to the selected asset.
    diagnostics: {
      ...(state.diagnostics || {}),
      activeAssetTransition: {
        from, to: target, clearedAt: now,
        reason: 'Ativo trocado; sinal e decisão antigos descartados, aguardando candles do ativo atual.'
      }
    }
  };
}

export function activeAssetCandles(state = {}, asset = state.asset || '') {
  const target = marketId(asset);
  const history = state.marketHistory || {};
  const key = Object.keys(history).find(value => sameMarket(value, target));
  if (key && Array.isArray(history[key])) return history[key];
  const candleAsset = marketId(state.currentCandle?.asset || '');
  const signalAsset = marketId(state.signal?.asset || '');
  const transitionTarget = marketId(state.diagnostics?.activeAssetTransition?.to || '');
  if (transitionTarget === target && (!candleAsset || candleAsset !== target)) return [];
  if (candleAsset && candleAsset !== target) return [];
  if (signalAsset && signalAsset !== target) return [];
  return Array.isArray(state.candles) ? state.candles : [];
}
