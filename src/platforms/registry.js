export const PLATFORM_ADAPTERS = [
  {
    id: 'casatrade',
    name: 'CasaTrade',
    hosts: ['casatrade.com', 'casatrade.io'],
    status: 'beta',
    defaultSelectors: {
      asset: '[data-testid*="asset" i],[data-testid*="symbol" i],[class*="asset" i],[class*="symbol" i],[class*="instrument" i],[role="tab"][aria-selected="true"],[data-state="active"]',
      price: '[data-testid*="price" i],[data-testid*="quote" i],[class*="price" i],[class*="quote" i],[class*="rate" i],[class*="current" i][class*="price" i]',
      timeframe: '[data-testid*="timeframe" i],[data-testid*="period" i],[class*="timeframe" i],[class*="period" i],[aria-label*="timeframe" i],[aria-label*="período" i],[aria-label*="vela" i]',
      expiration: '[data-testid*="expir" i],[class*="expir" i],[aria-label*="expira" i],[aria-label*="expiry" i]',
      amount: '[data-testid*="amount" i],[data-testid*="stake" i],[class*="amount" i] input,[class*="stake" i] input,input[aria-label*="valor" i],input[placeholder*="valor" i]'
    },
    selectorCandidates: {
      asset: [
        '[role="tab"][aria-selected="true"]', '[role="option"][aria-selected="true"]', '[data-state="active"]',
        '[class*="active" i][class*="asset" i]', '[class*="selected" i][class*="asset" i]',
        '[class*="active" i][class*="symbol" i]', '[class*="selected" i][class*="symbol" i]',
        '[data-testid*="asset" i]', '[data-testid*="symbol" i]', '[class*="asset" i]', '[class*="symbol" i]'
      ],
      price: [
        '[data-testid*="price" i]', '[data-testid*="quote" i]', '[class*="current-price" i]',
        '[class*="last-price" i]', '[class*="price" i]', '[class*="quote" i]', '[class*="rate" i]'
      ],
      timeframe: [
        '[data-testid*="timeframe" i]', '[data-testid*="period" i]', '[aria-label*="timeframe" i]',
        '[aria-label*="período" i]', '[aria-label*="periodo" i]', '[aria-label*="vela" i]',
        '[class*="timeframe" i]', '[class*="period" i]'
      ],
      expiration: [
        '[data-testid*="expiration" i]', '[data-testid*="expiry" i]', '[aria-label*="expira" i]',
        '[aria-label*="expiry" i]', '[class*="expiration" i]', '[class*="expiry" i]', '[class*="expir" i]'
      ],
      amount: [
        'input[data-testid*="amount" i]', 'input[data-testid*="stake" i]', 'input[aria-label*="valor" i]',
        'input[placeholder*="valor" i]', '[class*="amount" i] input', '[class*="stake" i] input'
      ]
    },
    patterns: {
      price: '(?<!\\d)[-+]?\\d{1,7}(?:[.,]\\d{2,8})(?!\\d)',
      asset: '\\b(?:[A-Z0-9]{2,12}\\s*[\\/_-]\\s*[A-Z0-9]{2,12}|[A-Z]{6})(?:\\s*(?:\\(|-|_)?OTC\\)?)?\\b',
      timeframe: '\\b(?:S(?:5|15|30)|M(?:1|2|5|15|30)|H(?:1|4)|D1|(?:5|15|30)\\s*(?:S|SEG)|(?:1|2|5|15|30)\\s*(?:M|MIN)|1\\s*H)\\b',
      expiration: '\\b(?:EXPIRA(?:ÇÃO|CAO)|EXPIRY|EXPIRATION|DURAÇÃO|DURACAO)\\s*[:\\-]?\\s*(?:5|15|30|60)\\s*(?:S|SEG(?:UNDOS?)?)|\\b(?:1|2|5|15|30)\\s*(?:M|MIN(?:UTOS?)?)\\b'
    },
    patternFlags: { price: 'i', asset: 'i', timeframe: 'i', expiration: 'i' },
    capabilities: { structuredQuotes: false, candles: false, expiration: false, multiAsset: false }
  },
  {
    id: 'generic',
    name: 'Generic Web Trader',
    hosts: [],
    status: 'stub',
    defaultSelectors: { price: '', asset: '', timeframe: '', expiration: '', amount: '' },
    selectorCandidates: { asset: [], price: [], timeframe: [], expiration: [], amount: [] },
    patterns: {
      price: '(?<!\\d)[-+]?\\d{1,7}(?:[.,]\\d{2,8})(?!\\d)',
      asset: '\\b[A-Z0-9]{2,12}\\s*[\\/_-]\\s*[A-Z0-9]{2,12}\\b',
      timeframe: '\\b(?:S(?:5|15|30)|M(?:1|2|5|15|30)|H(?:1|4)|D1)\\b',
      expiration: ''
    },
    patternFlags: { price: 'i', asset: 'i', timeframe: 'i', expiration: 'i' },
    capabilities: { structuredQuotes: false, candles: false, expiration: false, multiAsset: false }
  }
];

const hostMatch = (host, base) => host === base || host.endsWith(`.${base}`);

export function detectPlatform(host = '') {
  const value = String(host || globalThis.location?.hostname || '').toLowerCase();
  return PLATFORM_ADAPTERS.find(p => p.hosts?.some(h => hostMatch(value, String(h).toLowerCase()))) || null;
}

export function getPlatform(id) {
  return PLATFORM_ADAPTERS.find(p => p.id === id) || null;
}

export function selectorsFor(platformId, settings = {}) {
  const p = getPlatform(platformId);
  const overrides = settings.selectorsByPlatform?.[platformId] || {};
  return {
    price: overrides.price ?? p?.defaultSelectors?.price ?? '',
    asset: overrides.asset ?? p?.defaultSelectors?.asset ?? '',
    timeframe: overrides.timeframe ?? p?.defaultSelectors?.timeframe ?? '',
    expiration: overrides.expiration ?? p?.defaultSelectors?.expiration ?? '',
    amount: overrides.amount ?? p?.defaultSelectors?.amount ?? ''
  };
}

export function canonicalAsset(value = '') {
  let s = String(value || '').toUpperCase().replace(/\s+/g, '').replace(/[()]/g, '');
  const otc = /(?:^|[_-])OTC$|OTC$/.test(s);
  s = s.replace(/(?:[_-])?OTC$/, '').replace(/^FRX/, '');
  s = s.replace(/_/g, '/').replace(/-/g, '/');
  if (!s.includes('/')) {
    const quotes = ['USDT', 'USDC', 'USD', 'EUR', 'GBP', 'JPY', 'AUD', 'CAD', 'CHF', 'NZD', 'BRL', 'BTC', 'ETH'];
    const quote = quotes.find(q => s.length > q.length && s.endsWith(q));
    if (quote) s = `${s.slice(0, -quote.length)}/${quote}`;
    else if (/^[A-Z]{6}$/.test(s)) s = `${s.slice(0, 3)}/${s.slice(3)}`;
  }
  return s ? `${s}${otc ? ' (OTC)' : ''}` : '';
}

export function normalizeMarket(raw = {}) {
  const price = Number(String(raw.price ?? '').replace(',', '.'));
  return {
    platformId: raw.platformId || null,
    platformName: raw.platformName || null,
    asset: canonicalAsset(raw.asset || '') || null,
    timeframe: raw.timeframe || null,
    price: Number.isFinite(price) ? price : null,
    timestamp: raw.timestamp || Date.now(),
    candles: Array.isArray(raw.candles) ? raw.candles : []
  };
}
