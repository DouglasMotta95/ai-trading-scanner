import { canonicalMarket, sameMarket } from './market-session-guard.js';

const finite = value => Number.isFinite(Number(value)) ? Number(value) : null;

export function strongSelectedMarketMismatch({
  candidates = [],
  focusAsset = '',
  now = Date.now(),
  maxAgeMs = 2500,
  minConfidence = 75
} = {}) {
  const focus = canonicalMarket(focusAsset);
  if (!focus) return null;

  const rows = (Array.isArray(candidates) ? candidates : [])
    .map(row => ({
      ...row,
      asset: canonicalMarket(row?.asset),
      confidence: finite(row?.confidence) ?? 0,
      observedAt: finite(row?.observedAt) ?? 0,
      price: finite(row?.price ?? row?.close)
    }))
    .filter(row => row.asset
      && row.selected === true
      && !sameMarket(row.asset, focus)
      && row.confidence >= minConfidence
      && row.price != null && row.price > 0
      && row.observedAt > 0
      && Number(now) >= row.observedAt
      && Number(now) - row.observedAt <= maxAgeMs)
    .sort((a,b) => b.confidence - a.confidence || b.observedAt - a.observedAt);

  if (!rows.length) return null;
  const first = rows[0];
  const secondDifferent = rows.find(row => !sameMarket(row.asset, first.asset));
  if (secondDifferent) {
    const confidenceGap = first.confidence - secondDifferent.confidence;
    const timeGap = first.observedAt - secondDifferent.observedAt;
    if (confidenceGap < 10 && timeGap < 500) return null;
  }
  return first;
}
