const CASATRADE_HOSTS = new Set([
  'casatrade.com',
  'www.casatrade.com',
  'app.casatrade.com',
  'trade.casatrade.com',
  'casatrade.io',
  'www.casatrade.io',
  'app.casatrade.io',
  'trade.casatrade.io'
]);

const CASA_TRADE = {
  id: 'casatrade',
  name: 'CasaTrade',
  hosts: [...CASATRADE_HOSTS],
  hostRoots: ['casatrade.com', 'casatrade.io'],
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

const PLATFORMS = Object.freeze([CASA_TRADE]);

function normalizeHost(host = '') {
  return String(host || '').trim().toLowerCase().replace(/\.$/, '');
}

function platformMatchesHost(platform, host = '') {
  const normalized = normalizeHost(host);
  if (!normalized) return false;
  const roots = Array.isArray(platform?.hostRoots) ? platform.hostRoots : [];
  if (roots.some(root => normalized === root || normalized.endsWith(`.${root}`))) return true;
  return (platform?.hosts || []).some(candidate => normalizeHost(candidate) === normalized);
}

export function isCasaTradeHost(host = '') {
  return platformMatchesHost(getPlatform('casatrade'), host);
}

export function detectPlatform(host = '') {
  return PLATFORMS.find(platform => platformMatchesHost(platform, host)) || null;
}

export function platformRegistry() {
  return [...PLATFORMS];
}

export function getPlatform(id = '') {
  const normalized = String(id || '').trim().toLowerCase();
  return PLATFORMS.find(platform => String(platform?.id || '').toLowerCase() === normalized) || null;
}
