const CASATRADE_HOSTS = new Set([
  'trade.casatrade.com'
]);

const CASA_TRADE = {
  id: 'casatrade',
  name: 'CasaTrade',
  hosts: [...CASATRADE_HOSTS],
  selectors: {
    asset: [
      '[data-testid*="asset"]',
      '[data-testid*="instrument"]',
      '[class*="asset"]',
      '[class*="instrument"]'
    ],
    price: [
      '[data-testid*="price"]',
      '[class*="price"]',
      '[class*="quote"]'
    ],
    amount: [
      'input[data-testid*="amount"]',
      'input[name*="amount"]',
      'input[class*="amount"]'
    ],
    timeframe: [
      '[data-testid*="timeframe"]',
      '[data-testid*="candle"]',
      '[class*="timeframe"]'
    ],
    expiration: [
      '[data-testid*="expiration"]',
      '[data-testid*="expiry"]',
      '[class*="expiration"]'
    ]
  },
  timeframePatterns: [/^S(?:5|15|30)$/i, /^M(?:1|2|5|15)$/i, /^H(?:1)$/i]
};

export function canonicalAsset(value = '') {
  let s = String(value || '').trim().toUpperCase();
  if (!s) return '';
  const otc = /(?:\(|\b|[_-])OTC(?:\)|\b)?/.test(s);
  s = s
    .replace(/\(OTC\)|\bOTC\b/g, '')
    .replace(/^FRX[:_-]?/, '')
    .replace(/\s+/g, '')
    .replace(/_/g, '/')
    .replace(/-/g, '/')
    .replace(/^\/+|\/+$/g, '')
    .replace(/\/{2,}/g, '/');

  if (!s.includes('/')) {
    const quotes = ['USDT','USDC','USD','EUR','GBP','JPY','AUD','CAD','CHF','NZD','BRL','BTC','ETH'];
    const quote = quotes.find(x => s.length > x.length && s.endsWith(x));
    if (quote) s = `${s.slice(0, -quote.length)}/${quote}`;
    else if (/^[A-Z]{6}$/.test(s)) s = `${s.slice(0, 3)}/${s.slice(3)}`;
  }
  return s ? `${s}${otc ? ' (OTC)' : ''}` : '';
}

function normalizeHost(host = '') {
  return String(host || '').trim().toLowerCase().replace(/\.$/, '');
}

export function isCasaTradeHost(host = '') {
  const normalized = normalizeHost(host);
  return CASATRADE_HOSTS.has(normalized);
}

export function detectPlatform(host = '') {
  return isCasaTradeHost(host) ? CASA_TRADE : null;
}

export function platformRegistry() {
  return [CASA_TRADE];
}

export function getPlatform(id = '') {
  return String(id || '').toLowerCase() === 'casatrade' ? CASA_TRADE : null;
}