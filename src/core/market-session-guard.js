const clean = value => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
const QUOTES = new Set(['USD','EUR','GBP','JPY','AUD','CAD','CHF','NZD','BRL','HKD','SGD','NOK','SEK','DKK','PLN','CZK','HUF','TRY','MXN','ZAR','INR','CNY','CNH','KRW','THB','MYR','PHP','IDR','VND','TWD','ILS','AED','SAR','QAR','KWD','BHD','OMR','ARS','CLP','COP','PEN','UYU','BOB','PYG','USDT','USDC','BTC','ETH']);
const GENERIC = new Set(['BLITZ','OPTION','OPTIONS','BINARY','BINARIA','BINARIO','DIGITAL','TURBO','CALL','PUT','BUY','SELL','COMPRA','VENDA','TRADE','TRADING','OPERATION','OPERACAO','OPCAO','INFO','FAVORITO','FAVORITES','ATIVO','ASSET','INSTRUMENT','INSTRUMENTO','MARKET','PRECO','PRICE','EXPIRACAO','EXPIRATION','VALOR','SALDO','PAYOUT','LUCRO','LIVE','CONECTAR','ENTRAR','VELA','GRAFICO','GRÁFICO']);

export function canonicalMarket(value = '') {
  const raw = clean(value).toUpperCase();
  if (!raw) return '';
  const otc = /(?:\(|\b|[_-])OTC(?:\)|\b)?/i.test(raw);
  const stripped = raw.replace(/\(\s*OTC\s*\)|\bOTC\b/g, ' ').trim();
  const direct = stripped.match(/\b([A-Z0-9]{2,20})\s*[\/_-]\s*([A-Z0-9]{2,12})/i);
  if (direct) {
    const base = direct[1], quote = direct[2];
    if (!QUOTES.has(quote) || GENERIC.has(base) || GENERIC.has(quote)) return '';
    return `${base}/${quote}${otc ? ' (OTC)' : ''}`;
  }
  const compact = stripped.replace(/[^A-Z0-9]/g, '');
  for (const quote of QUOTES) {
    if (!compact.endsWith(quote) || compact.length <= quote.length + 1) continue;
    const base = compact.slice(0, -quote.length);
    if (/^[A-Z0-9]{2,12}$/.test(base) && !GENERIC.has(base)) return `${base}/${quote}${otc ? ' (OTC)' : ''}`;
  }
  let named = stripped.replace(/(?:^|[\s|•·_-])(BLITZ|OPTION|OPTIONS|BINARY|BINARIA|BINARIO|DIGITAL|TURBO|CALL|PUT)\s*$/i, '').trim();
  named = named.replace(/^\s*(?:ATIVO|ASSET|INSTRUMENTO|INSTRUMENT)\s*[:|-]\s*/i, '').replace(/\s+/g, ' ').trim();
  if (named.length >= 2 && named.length <= 80 && /[A-Z]/.test(named) && !GENERIC.has(named) && !/^[\d\s.,:+_/-]+$/.test(named)) {
    return `${named}${otc ? ' (OTC)' : ''}`;
  }
  return '';
}

export function sameMarket(a, b) {
  const left = canonicalMarket(a);
  return !!left && left === canonicalMarket(b);
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
