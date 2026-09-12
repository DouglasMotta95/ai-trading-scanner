const allowedTransports = new Set(['ws', 'fetch', 'xhr']);
let lastRun = 0;
const num = v => v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null;
const clean = v => String(v ?? '').trim();
const normAsset = v => {
  let s = clean(v).toUpperCase();
  const otc = /(?:\(|\b|[_-])OTC(?:\)|\b)?/.test(s);
  s = s.replace(/\(OTC\)|\bOTC\b/g, '').replace(/^FRX[:_-]?/, '').replace(/\s+/g, '').replace(/_/g, '/').replace(/-/g, '/').replace(/^\/+|\/+$/g, '').replace(/\/{2,}/g, '/');
  if (!s.includes('/')) {
    const quotes = ['USDT','USDC','USD','EUR','GBP','JPY','AUD','CAD','CHF','NZD','BRL','BTC','ETH'];
    const q = quotes.find(x => s.length > x.length && s.endsWith(x));
    if (q) s = `${s.slice(0, -q.length)}/${q}`;
    else if (/^[A-Z]{6}$/.test(s)) s = `${s.slice(0, 3)}/${s.slice(3)}`;
  }
  return s ? `${s}${otc ? ' (OTC)' : ''}` : '';
};
const normTf = v => {
  const s = clean(v).toUpperCase().replace(/\s+/g, '');
  if (/^\d+M$/.test(s)) return `M${s.replace('M', '')}`;
  if (/^\d+S$/.test(s)) return `S${s.replace('S', '')}`;
  if (/^M\d+$/.test(s) || /^S\d+$/.test(s) || /^H\d+$/.test(s)) return s;
  return s || null;
};
const normExp = v => {
  const s = clean(v).toLowerCase().replace(/\s+/g, '');
  let m = s.match(/^(\d+)s$/); if (m) return `${Number(m[1])}s`;
  m = s.match(/^(\d+)m(?:in)?$/); if (m) return Number(m[1]) === 1 ? '60s' : `${Number(m[1])}m`;
  return s || null;
};

function sanitizeRecentCandles(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const out = {};
  for (const [rawAsset, rows] of Object.entries(input).slice(0, 80)) {
    const asset = normAsset(rawAsset);
    if (!asset || !Array.isArray(rows)) continue;
    const cleanRows = rows.slice(-240).map(r => {
      let time = num(r?.time ?? r?.timestamp);
      if (time != null && time > 0 && time < 1e12) time *= 1000;
      const open = num(r?.open), high = num(r?.high), low = num(r?.low), close = num(r?.close);
      if (![time, open, high, low, close].every(Number.isFinite)) return null;
      return { time, open, high, low, close, timeframe: normTf(r?.timeframe) };
    }).filter(Boolean).sort((a, b) => a.time - b.time);
    if (cleanRows.length) out[asset] = cleanRows;
  }
  return out;
}

async function keepRealFeedContext(payload = {}, sender = {}) {
  if (Date.now() - lastRun < 180) return;
  lastRun = Date.now();
  const { scannerState = {}, settings = {} } = await chrome.storage.local.get(['scannerState', 'settings']);
  if (settings.runtimePaused) return;
  if (scannerState.targetTabId && sender?.tab?.id && scannerState.targetTabId !== sender.tab.id) return;
  const recentCandles = sanitizeRecentCandles(payload.recentCandles || {});
  const candidates = Array.isArray(payload.candidates) ? payload.candidates.slice(0, 180).filter(c => {
    const price = num(c?.price) ?? ((num(c?.bid) != null && num(c?.ask) != null) ? (num(c.bid) + num(c.ask)) / 2 : null);
    return normAsset(c?.asset) && price != null && price > 0 && allowedTransports.has(clean(c?.transport));
  }) : [];
  const latestNetwork = {
    ...(scannerState.diagnostics?.network || {}),
    messages: payload.messages || {},
    connections: payload.connections || {},
    endpoints: Array.isArray(payload.endpoints) ? payload.endpoints.slice(-30) : [],
    keys: Array.isArray(payload.keys) ? payload.keys.slice(0, 180) : [],
    candidates,
    candidateCount: candidates.length,
    recentCandles,
    feedQuality: Number(payload.feedQuality || 0),
    parser: payload.parser || {},
    primaryTransport: payload.primaryTransport || null,
    lastSeen: Date.now()
  };
  const latest = (await chrome.storage.local.get('scannerState')).scannerState || scannerState;
  await chrome.storage.local.set({
    scannerState: {
      ...latest,
      marketHistory: recentCandles,
      diagnostics: { ...(latest.diagnostics || {}), network: latestNetwork }
    }
  });
}

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type === 'ATS_NETWORK_DIAGNOSTIC') {
    setTimeout(() => keepRealFeedContext(message.payload || {}, sender).catch(() => {}), 40);
  }
});
