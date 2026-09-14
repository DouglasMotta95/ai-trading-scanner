const num = value => value == null || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null;
const clean = value => String(value ?? '').trim();
const MIN_ANALYST_CANDLES = 2;

export const normMarketAsset = value => clean(value).toUpperCase()
  .replace(/\s+/g, ' ')
  .replace(/\s*\(\s*OTC\s*\)\s*$/, ' (OTC)')
  .trim();

const identity = value => normMarketAsset(value).replace(/\s*\(OTC\)\s*$/, '');
export const sameMarketAsset = (a, b) => {
  const left = identity(a);
  const right = identity(b);
  return !!left && !!right && left === right;
};

const rowPrice = row => {
  const direct = num(row?.price);
  if (direct != null && direct > 0) return direct;
  const bid = num(row?.bid);
  const ask = num(row?.ask);
  if (bid != null && ask != null && bid > 0 && ask > 0) return (bid + ask) / 2;
  return null;
};

function networkRows(state = {}, now = Date.now()) {
  const network = state?.diagnostics?.network || {};
  const fallbackSeen = Number(network.lastSeen || 0);
  return (Array.isArray(network.candidates) ? network.candidates : []).map(row => ({
    ...row,
    asset: normMarketAsset(row?.asset),
    price: rowPrice(row),
    observedAt: Number(row?.observedAt || fallbackSeen || 0),
    confidence: Number(row?.confidence || 0),
    seenCount: Number(row?.seenCount || 0)
  })).filter(row => row.asset && row.price != null && row.price > 0 && row.observedAt > 0 && now - row.observedAt < 15000);
}

const strongNetwork = row => !!row && (
  row.selected === true
  || Number(row.confidence || 0) >= 82
  || Number(row.seenCount || 0) >= 2
);

function bestNetwork(state = {}, preferredAsset = '', now = Date.now()) {
  const preferred = normMarketAsset(preferredAsset);
  let rows = networkRows(state, now);
  if (preferred) rows = rows.filter(row => sameMarketAsset(row.asset, preferred));
  rows.sort((a, b) =>
    Number(b.selected === true) - Number(a.selected === true)
    || Number(b.confidence || 0) - Number(a.confidence || 0)
    || Number(b.seenCount || 0) - Number(a.seenCount || 0)
    || Number(b.observedAt || 0) - Number(a.observedAt || 0)
  );
  const row = rows[0] || null;
  return preferred || strongNetwork(row) ? row : null;
}

function catalogRows(state = {}, now = Date.now()) {
  const seenAt = Number(state?.diagnostics?.domCatalog?.lastSeen || 0);
  if (!seenAt || now - seenAt > 5000) return [];
  return (Array.isArray(state?.marketCatalog?.lines) ? state.marketCatalog.lines : []).map(row => ({
    ...row,
    asset: normMarketAsset(row?.asset),
    price: rowPrice(row)
  })).filter(row => row.asset && row.price != null && row.price > 0);
}

function bestCatalog(state = {}, preferredAsset = '', now = Date.now()) {
  const preferred = normMarketAsset(preferredAsset);
  const rows = catalogRows(state, now);
  if (preferred) return rows.find(row => sameMarketAsset(row.asset, preferred)) || null;
  return rows[0] || null;
}

function focusedEvidence(state = {}, now = Date.now(), stableMs = 2000) {
  const meta = state?.diagnostics?.focusedAsset || {};
  const asset = normMarketAsset(meta.asset);
  const at = Number(meta.at || 0);
  const since = Number(meta.stableSince || at || 0);
  const fresh = !!asset && at > 0 && now - at < 5000;
  const stable = fresh && since > 0 && now - since >= stableMs;
  const visual = fresh && (meta.visual === true || ['chart-header','user-selection'].includes(clean(meta.source)));
  const reliable = fresh && (meta.reliable === true || visual || Number(meta.score || 0) >= 90 || stable);
  return { asset, meta, fresh, stable, visual, reliable, authoritative: fresh && !!asset };
}

export function resolveMarketEvidence(snapshot = {}, state = {}, options = {}) {
  const now = Number(options.now || Date.now());
  const stableMs = Number(options.focusStableMs || 2000);
  const focus = focusedEvidence(state, now, stableMs);

  const rawSnapshotSource = clean(snapshot?.diagnostics?.assetSource);
  const syntheticFocusedPrice = rawSnapshotSource === 'focused-price-fallback';
  const snapshotAsset = syntheticFocusedPrice ? '' : normMarketAsset(snapshot?.asset);
  const snapshotPrice = syntheticFocusedPrice ? null : num(snapshot?.price);

  const focusNetwork = focus.fresh && focus.asset ? bestNetwork(state, focus.asset, now) : null;
  const focusCatalog = focus.fresh && focus.asset ? bestCatalog(state, focus.asset, now) : null;
  const focusCorroborated = focus.fresh && !!focus.asset && (
    sameMarketAsset(snapshotAsset, focus.asset)
    || !!focusNetwork
    || !!focusCatalog
  );

  let asset = '';
  let assetSource = null;
  if (focus.authoritative) {
    asset = focus.asset;
    assetSource = focus.meta?.source === 'user-selection'
      ? 'focused-user-selection'
      : focus.stable
        ? 'focused-stable'
        : focusCorroborated
          ? 'focused-corroborated'
          : 'focused-screen';
  } else if (snapshotAsset) {
    asset = snapshotAsset;
    assetSource = snapshot?.diagnostics?.assetSource || 'snapshot-fallback';
  } else {
    const catalog = bestCatalog(state, '', now);
    const network = bestNetwork(state, '', now);
    if (catalog?.asset) {
      asset = catalog.asset;
      assetSource = 'dom-catalog-fallback';
    } else if (network?.asset) {
      asset = network.asset;
      assetSource = 'network-fallback';
    }
  }

  if (!asset) {
    return {
      asset: null,
      price: null,
      assetSource: null,
      priceSource: null,
      focusAsset: focus.fresh ? focus.asset || null : null,
      focusStable: focus.stable,
      focusReliable: focus.reliable,
      focusCorroborated,
      focusAuthoritative: focus.authoritative,
      reason: syntheticFocusedPrice
        ? 'Ativo/preço não confirmados: preço sem ativo correspondente foi descartado.'
        : 'Ativo não confirmado: aguardando evidência do foco visual, DOM ou feed de rede.'
    };
  }

  const snapshotMatches = !!snapshotAsset && sameMarketAsset(snapshotAsset, asset);
  const catalog = bestCatalog(state, asset, now);
  const network = bestNetwork(state, asset, now);
  const statePrice = sameMarketAsset(state?.asset, asset)
    && Number(state?.lastSeen || 0) > 0
    && now - Number(state.lastSeen) < 8000
    ? num(state?.price)
    : null;

  let price = null;
  let priceSource = null;
  if (snapshotMatches && snapshotPrice != null && snapshotPrice > 0) {
    price = snapshotPrice;
    priceSource = snapshot?.diagnostics?.priceSource || snapshot?.diagnostics?.capture || 'snapshot';
  } else if (catalog?.price != null) {
    price = catalog.price;
    priceSource = catalog.priceSource || catalog.transport || 'dom-catalog';
  } else if (network?.price != null) {
    price = network.price;
    priceSource = `network:${network.transport || network.source || 'quote'}`;
  } else if (statePrice != null && statePrice > 0) {
    price = statePrice;
    priceSource = 'recent-state';
  }

  return {
    asset,
    price,
    assetSource,
    priceSource,
    focusAsset: focus.fresh ? focus.asset || null : null,
    focusStable: focus.stable,
    focusReliable: focus.reliable,
    focusCorroborated,
    focusAuthoritative: focus.authoritative,
    reason: price == null
      ? focus.authoritative
        ? `Ativo ${asset} confirmado na tela. Aguardando cotação real do mesmo ativo.`
        : `Ativo ${asset} identificado, mas ainda não chegou uma cotação real válida.`
      : null
  };
}

export function marketHistoryFor(state = {}, asset = '') {
  const wanted = normMarketAsset(asset);
  if (!wanted) return [];
  const sources = [state?.marketHistory || {}, state?.diagnostics?.network?.recentCandles || {}];
  let best = [];
  for (const source of sources) {
    const key = Object.keys(source || {}).find(candidate => sameMarketAsset(candidate, wanted));
    const rows = key && Array.isArray(source[key]) ? source[key].slice(-120) : [];
    if (rows.length > best.length) best = rows;
  }
  return best;
}

export function acquisitionStage(signal = {}, candleCount = 0) {
  const count = Math.max(0, Number(signal?.candleCount ?? candleCount ?? 0));
  if (count < MIN_ANALYST_CANDLES || signal?.state === 'SEARCHING' || signal?.phase === 'HISTORY') return 'reading_history';
  if (!signal?.currentCandle) return 'analyzing_current';
  return 'diagnosing_next_candle';
}
