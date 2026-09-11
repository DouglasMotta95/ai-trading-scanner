(() => {
  if (globalThis.__ATS_GENERIC_ADAPTER__) return;
  globalThis.__ATS_GENERIC_ADAPTER__ = true;

  let platform = null;
  let settings = {};
  let networkState = {};
  let lastNetworkSeen = 0;
  let timer = null;
  let inspecting = false;
  let lastDebug = '';

  const compile = (source, flags = '') => {
    if (!source) return null;
    try { return new RegExp(source, flags); } catch { return null; }
  };
  const pick = s => {
    if (!s) return { value: null, error: null };
    try {
      return { value: document.querySelector(s)?.textContent?.trim() || null, error: null };
    } catch (e) {
      return { value: null, error: String(e?.message || 'invalid selector') };
    }
  };
  const text = () => (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 80000);
  const normTf = v => {
    const x = String(v || '').trim();
    if (!x) return null;
    const u = x.toUpperCase();
    if (/^\d+S$/.test(u)) return 'S' + u.replace('S', '');
    return /^\d/.test(u)
      ? u.replace(/^1M$/, 'M1').replace(/^5M$/, 'M5').replace(/^15M$/, 'M15').replace(/^30M$/, 'M30').replace(/^1H$/, 'H1').replace(/^4H$/, 'H4')
      : u;
  };
  const normAsset = v => String(v || '').trim().toUpperCase().replace(/\s/g, '').replace(/-/g, '/');
  const num = v => {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    const s = String(v ?? '').trim().replace(/\s/g, '').replace(/[^\d,.-]/g, '');
    if (!s) return null;
    let n = s;
    if (n.includes(',') && n.includes('.')) {
      n = n.lastIndexOf(',') > n.lastIndexOf('.') ? n.replace(/\./g, '').replace(',', '.') : n.replace(/,/g, '');
    } else n = n.replace(',', '.');
    const x = Number(n);
    return Number.isFinite(x) ? x : null;
  };
  const normExp = (n, u) => {
    n = Number(n);
    if (!Number.isFinite(n) || n <= 0) return null;
    u = String(u || '').toLowerCase();
    return /seg|^s$/.test(u) ? `${n}s` : /min|^m$/.test(u) ? `${n}m` : null;
  };
  const detectExpiration = t => {
    const m = String(t || '').match(/(?:EXPIRA(?:ÇÃO|CAO)|EXPIRY|EXPIRATION)\s*[:\-]?\s*(\d{1,3})\s*(SEG(?:UNDOS?)?|S|MIN(?:UTOS?)?|M)\b/i);
    return m ? normExp(m[1], m[2]) : null;
  };
  const detectInstrument = t => /\bBLITZ\b/i.test(t) ? 'blitz' : /\b(?:BINÁRIA|BINARIA|BINARY)\b/i.test(t) ? 'binary' : /\bTURBO\b/i.test(t) ? 'turbo' : /\bCFD\b/i.test(t) ? 'cfd' : 'unknown';
  const allMatches = (source, flags, t, limit = 100) => {
    if (!source) return [];
    try {
      const f = [...new Set((String(flags || '') + 'g').split(''))].join('');
      const r = new RegExp(source, f);
      const out = [];
      let m;
      while ((m = r.exec(t)) && out.length < limit) {
        if (m[0]) out.push(m[0]);
        if (m[0] === '') r.lastIndex++;
      }
      return out;
    } catch { return []; }
  };
  const selectors = () => ({ ...platform.defaultSelectors, ...(settings.selectorsByPlatform?.[platform.id] || {}) });

  function structuredNetworkQuote(domAsset) {
    const age = Date.now() - Number(networkState?.lastSeen || 0);
    if (!Number.isFinite(age) || age < 0 || age > 6000) return null;
    const allowedTransports = new Set(['ws', 'fetch', 'xhr']);
    const candidates = (Array.isArray(networkState?.candidates) ? networkState.candidates : []).map(c => {
      const bid = num(c?.bid);
      const ask = num(c?.ask);
      let price = num(c?.price);
      if (price == null && bid != null && ask != null) price = (bid + ask) / 2;
      return {
        ...c,
        asset: normAsset(c?.asset),
        price,
        bid,
        ask,
        timeframe: normTf(c?.timeframe),
        expiration: c?.expiration ? String(c.expiration).trim() : null
      };
    }).filter(c => c.asset && c.price != null && c.price > 0 && allowedTransports.has(c.transport) && Number(c.seenCount || 0) >= 2 && Date.now() - Number(c.observedAt || 0) <= 6000);

    if (!candidates.length) return null;
    const wanted = normAsset(domAsset);
    if (wanted) {
      const exact = candidates.find(c => c.asset === wanted);
      return exact || null;
    }
    return candidates.length === 1 ? candidates[0] : null;
  }

  async function inspect() {
    if (!platform || inspecting) return;
    inspecting = true;
    try {
      const overrides = settings.selectorsByPlatform?.[platform.id] || {};
      const sel = selectors();
      const patterns = {
        price: compile(platform.patterns?.price, platform.patternFlags?.price || ''),
        asset: compile(platform.patterns?.asset, platform.patternFlags?.asset || ''),
        timeframe: compile(platform.patterns?.timeframe, platform.patternFlags?.timeframe || '')
      };
      const t = text();
      const aSel = pick(sel.asset);
      const tfSel = pick(sel.timeframe);
      const pSel = pick(sel.price);
      const assets = [...new Set(allMatches(platform.patterns?.asset, platform.patternFlags?.asset || '', t).map(normAsset).filter(Boolean))].slice(0, 100);
      const rawAsset = aSel.value || patterns.asset?.exec(t)?.[0] || assets[0] || null;
      const rawTf = tfSel.value || patterns.timeframe?.exec(t)?.[0] || null;

      let domPrice = pSel.value && patterns.price ? patterns.price.exec(pSel.value)?.[0] : pSel.value || null;
      const fallbackPrices = [];
      if (!domPrice && patterns.price) {
        const nodes = document.querySelectorAll('span,strong,b,p,[class*="price" i],[class*="quote" i]');
        for (let i = 0; i < Math.min(nodes.length, 1500); i++) {
          const v = (nodes[i].textContent || '').trim();
          const m = patterns.price.exec(v);
          if (m && v.length < 40) fallbackPrices.push(m[0]);
          if (fallbackPrices.length >= 8) break;
        }
      }
      domPrice = domPrice || fallbackPrices[0] || null;

      const domAsset = rawAsset ? normAsset(rawAsset) : null;
      const networkQuote = structuredNetworkQuote(domAsset);
      const structured = !!networkQuote;
      const asset = networkQuote?.asset || domAsset;
      const price = networkQuote?.price ?? num(domPrice);
      const timeframe = normTf(rawTf) || networkQuote?.timeframe || null;
      const expiration = detectExpiration(t) || networkQuote?.expiration || null;
      const instrumentType = detectInstrument(t);
      const missing = [!asset ? 'asset' : null, price == null ? 'price' : null, !timeframe ? 'timeframe' : null].filter(Boolean);
      const selectorErrors = { asset: aSel.error, timeframe: tfSel.error, price: pSel.error };
      const invalidSelectors = Object.entries(selectorErrors).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
      const diagKey = [...missing, ...invalidSelectors].join('|');
      if (diagKey && diagKey !== lastDebug) {
        console.debug(`[ATS ${platform.name}] captura incompleta:`, diagKey);
        lastDebug = diagKey;
      }

      const domCandidates = assets.map(a => ({
        asset: a,
        price: a === domAsset && domPrice != null ? num(domPrice) : null,
        timeframe,
        expiration,
        source: 'dom'
      }));
      chrome.runtime.sendMessage({
        type: 'ATS_DOM_CATALOG',
        payload: { candidates: domCandidates, assetCount: assets.length, timeframe, expiration, instrumentType }
      }).catch(() => {});

      const rawServerTime = num(networkQuote?.timestamp);
      const serverTime = rawServerTime && rawServerTime > 1e12 ? rawServerTime : null;
      const snapshot = {
        platformId: platform.id,
        platformName: platform.name,
        adapterVersion: chrome.runtime.getManifest().version,
        connection: 'online',
        url: location.origin + location.pathname,
        asset,
        timeframe,
        price,
        marketType: /\bOTC\b/i.test(t) ? 'otc' : 'unknown',
        instrumentType,
        expiration,
        serverTime,
        candles: [],
        ticks: price != null ? [{ price, at: serverTime || Date.now() }] : [],
        capabilities: {
          ...platform.capabilities,
          structuredQuotes: structured,
          candles: false,
          expiration: !!expiration,
          multiAsset: Number(networkState?.candidateCount || 0) > 1
        },
        diagnostics: {
          capture: structured ? 'network-structured+dom-context' : Object.values(overrides).some(Boolean) ? 'platform-selectors+fallback' : 'registry-defaults+fallback',
          structuredSource: structured ? networkQuote?.transport || 'network' : null,
          networkQuoteMatched: structured,
          networkQuoteSeenCount: Number(networkQuote?.seenCount || 0),
          missing,
          invalidSelectors,
          selectorConfig: { price: !!sel.price, asset: !!sel.asset, timeframe: !!sel.timeframe },
          host: location.hostname,
          domAssets: assets.length,
          domNodes: document.getElementsByTagName('*').length,
          canvases: document.querySelectorAll('canvas').length,
          svgs: document.querySelectorAll('svg').length,
          chartCandidates: document.querySelectorAll('canvas,svg,[class*="chart" i],[id*="chart" i]').length,
          priceCandidates: fallbackPrices.length,
          networkCandidateCount: Number(networkState?.candidateCount || 0),
          networkAgeMs: structured ? Date.now() - Number(networkState.lastSeen) : null,
          privacy: 'No cookies, credentials, tokens or balances collected'
        }
      };
      chrome.runtime.sendMessage({ type: 'ATS_PLATFORM_SNAPSHOT', payload: snapshot }).catch(() => {});
    } finally {
      inspecting = false;
    }
  }

  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(inspect, 500);
  };

  async function init() {
    try {
      const r = await chrome.runtime.sendMessage({ type: 'ATS_GET_PLATFORM_CONFIG', host: location.hostname });
      platform = r?.platform || null;
      if (!platform) {
        console.debug('[ATS] host sem adapter registrado:', location.hostname);
        return;
      }

      try {
        const stored = await chrome.storage.local.get(['settings', 'scannerState']);
        settings = stored.settings || {};
        networkState = stored.scannerState?.diagnostics?.network || {};
        lastNetworkSeen = Number(networkState?.lastSeen || 0);
      } catch {}

      chrome.storage.onChanged.addListener(c => {
        if (c.settings) settings = c.settings.newValue || {};
        if (c.scannerState) {
          const nextNetwork = c.scannerState.newValue?.diagnostics?.network || {};
          const seen = Number(nextNetwork?.lastSeen || 0);
          networkState = nextNetwork;
          if (seen && seen !== lastNetworkSeen) {
            lastNetworkSeen = seen;
            schedule();
          }
        }
      });

      const start = () => {
        if (!document.documentElement) return setTimeout(start, 50);
        new MutationObserver(schedule).observe(document.documentElement, { subtree: true, childList: true, characterData: true });
        inspect();
        setInterval(inspect, 3000);
      };
      start();
      window.addEventListener('load', inspect, { once: true });
    } catch (e) {
      console.debug('[ATS] adapter init failed:', e?.message || e);
    }
  }

  init();
})();
