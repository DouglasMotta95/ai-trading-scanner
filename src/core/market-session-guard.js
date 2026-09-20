const clean = value => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();

export function canonicalMarket(value = '') {
  const raw = clean(value).toUpperCase();
  if (!raw) return '';
  const otc = /(?:\(|\b|[_-])OTC(?:\)|\b)?/i.test(raw);
  const stripped = raw.replace(/\(\s*OTC\s*\)|\bOTC\b/g, ' ').trim();
  const direct = stripped.match(/\b([A-Z0-9]{2,20})\s*[\/_-]\s*([A-Z0-9]{2,12})/i);
  if (direct) return `${direct[1]}/${direct[2]}${otc ? ' (OTC)' : ''}`;
  const compact = stripped.replace(/[^A-Z0-9]/g, '');
  for (const quote of ['USDT','USDC','USD','EUR','GBP','JPY','CAD','AUD','CHF','NZD','BRL','BTC','ETH']) {
    if (!compact.endsWith(quote) || compact.length <= quote.length + 1) continue;
    const base = compact.slice(0, -quote.length);
    if (/^[A-Z0-9]{2,12}$/.test(base)) return `${base}/${quote}${otc ? ' (OTC)' : ''}`;
  }
  return '';
}

export function sameMarket(a, b) {
  const left = canonicalMarket(a);
  return !!left && left === canonicalMarket(b);
}

export function confirmedMarket(state = {}) {
  return canonicalMarket(
    state?.diagnostics?.marketSession?.confirmedAsset
    || state?.asset
    || ''
  );
}

export function shouldResetForFocusedAsset(state = {}, incomingAsset = '') {
  const confirmed = confirmedMarket(state);
  const incoming = canonicalMarket(incomingAsset);
  return !!confirmed && !!incoming && confirmed !== incoming;
}

const finite = value => Number.isFinite(Number(value)) ? Number(value) : null;

export function marketScaleCompatible(price, candles = [], maxRatio = 20) {
  const quote = finite(price);
  if (quote == null || quote <= 0) return false;
  const closes = (Array.isArray(candles) ? candles : [])
    .slice(-10)
    .map(row => finite(row?.close))
    .filter(value => value != null && value > 0);
  if (!closes.length) return true;
  const sorted = [...closes].sort((a,b) => a-b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const ratio = Math.max(quote, median) / Math.max(1e-12, Math.min(quote, median));
  return Number.isFinite(ratio) && ratio <= maxRatio;
}

export function validateMarketBundle({ focusAsset, candidateAsset, price, candles = [], requireCandles = true } = {}) {
  if (!sameMarket(focusAsset, candidateAsset)) return { ok: false, reason: 'asset_identity_mismatch' };
  const quote = finite(price);
  if (quote == null || quote <= 0) return { ok: false, reason: 'invalid_price' };
  const complete = (Array.isArray(candles) ? candles : []).filter(row =>
    ['open','high','low','close'].every(key => finite(row?.[key]) != null)
  );
  if (requireCandles && complete.length < 2) return { ok: false, reason: 'insufficient_asset_history' };
  if (!marketScaleCompatible(quote, complete)) return { ok: false, reason: 'price_history_scale_mismatch' };
  return { ok: true, asset: canonicalMarket(focusAsset), price: quote, candles: complete };
}
