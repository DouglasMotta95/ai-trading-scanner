import { assessAssetQuality } from './asset-quality.js';

const num = value => value == null || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null;
const clean = value => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();

export function marketId(value = '') {
  const raw = clean(value).toUpperCase();
  if (!raw) return '';
  const otc = /(?:\(|\b|[_-])OTC(?:\)|\b)?/i.test(raw);
  const pair = raw.match(/\b([A-Z0-9]{2,20})\s*[\/_-]\s*([A-Z0-9]{2,12})/i);
  return pair ? `${pair[1]}/${pair[2]}${otc ? ' (OTC)' : ''}` : '';
}

const sameMarket = (a, b) => !!marketId(a) && marketId(a) === marketId(b);

function candle(raw = {}) {
  let time = num(raw.time ?? raw.timestamp);
  if (time != null && time > 0 && time < 1e12) time *= 1000;
  const open = num(raw.open), high = num(raw.high), low = num(raw.low), close = num(raw.close);
  if (![open, high, low, close].every(Number.isFinite)) return null;
  return { time, open, high, low, close, timeframe: clean(raw.timeframe).toUpperCase() || null };
}

function candlesFor(payload = {}, asset = '') {
  const source = payload.recentCandles || {};
  const key = Object.keys(source).find(value => sameMarket(value, asset));
  if (!key) return [];
  return (Array.isArray(source[key]) ? source[key] : []).map(candle).filter(Boolean).slice(-12);
}

function candidateRows(payload = {}) {
  return (Array.isArray(payload.candidates) ? payload.candidates : []).map(row => {
    const asset = marketId(row?.asset);
    const bid = num(row?.bid), ask = num(row?.ask);
    const price = num(row?.price) ?? (bid != null && ask != null ? (bid + ask) / 2 : null);
    return { asset, price, selected: row?.selected === true, confidence: num(row?.confidence) ?? 0, observedAt: num(row?.observedAt) ?? Date.now() };
  }).filter(row => row.asset && row.price != null && row.price > 0);
}

function rowFrom(payload = {}, candidate = {}, focusedAsset = '') {
  const candles = candlesFor(payload, candidate.asset);
  const quality = assessAssetQuality({ asset: candidate.asset, price: candidate.price, candles });
  const enoughHistory = candles.length >= 3 && quality.score != null;
  return {
    asset: candidate.asset,
    price: candidate.price,
    score: enoughHistory ? quality.score : null,
    status: enoughHistory ? quality.status : 'LOADING',
    label: enoughHistory ? quality.label : 'COLETANDO HISTÓRICO',
    action: enoughHistory ? quality.action : 'ABRA PARA CONFIRMAR',
    context: enoughHistory ? quality.context : `${candles.length}/3 velas mínimas`,
    bias: enoughHistory ? quality.bias : '—',
    focused: sameMarket(candidate.asset, focusedAsset),
    selected: candidate.selected,
    confidence: candidate.confidence,
    candleCount: candles.length,
    observedAt: Math.max(candidate.observedAt || 0, Date.now()),
    actionable: false
  };
}

export function mergeRadarSnapshot(previous = {}, payload = {}, focusedAsset = '', now = Date.now()) {
  const map = new Map();
  for (const row of Array.isArray(previous.rows) ? previous.rows : []) {
    if (!row?.asset) continue;
    if (now - Number(row.observedAt || 0) > 10 * 60 * 1000) continue;
    map.set(marketId(row.asset), { ...row, focused: sameMarket(row.asset, focusedAsset) });
  }
  for (const candidate of candidateRows(payload)) {
    const next = rowFrom(payload, candidate, focusedAsset);
    const key = marketId(next.asset);
    const old = map.get(key) || {};
    map.set(key, { ...old, ...next, observedAt: now });
  }
  const rows = [...map.values()].sort((a, b) => {
    if (a.focused !== b.focused) return Number(b.focused) - Number(a.focused);
    const as = a.score == null ? -1 : Number(a.score);
    const bs = b.score == null ? -1 : Number(b.score);
    return bs - as || Number(b.observedAt || 0) - Number(a.observedAt || 0);
  }).slice(0, 12);
  return {
    rows,
    updatedAt: now,
    note: 'Radar observacional. Somente o ativo aberto e sincronizado pode gerar entrada.'
  };
}

export function topRadarRows(snapshot = {}, limit = 5) {
  return (Array.isArray(snapshot.rows) ? snapshot.rows : []).slice().sort((a, b) => {
    const as = a.score == null ? -1 : Number(a.score);
    const bs = b.score == null ? -1 : Number(b.score);
    return bs - as || Number(b.focused) - Number(a.focused);
  }).slice(0, Math.max(1, limit));
}
