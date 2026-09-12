(() => {
  if (globalThis.__ATS_GENERIC_ADAPTER__) return;
  globalThis.__ATS_GENERIC_ADAPTER__ = true;

  let platform = null;
  let settings = {};
  let networkState = {};
  let timer = null;
  let inspecting = false;
  let lastDebug = '';
  let lastAsset = null;

  const clean = v => String(v ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  const fold = v => clean(v).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const visible = el => {
    if (!el || !(el instanceof Element)) return false;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity || 1) > 0;
  };
  const num = v => {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    let s = clean(v).replace(/[^\d,.-]/g, '');
    if (!s) return null;
    if (s.includes(',') && s.includes('.')) s = s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
    else s = s.replace(',', '.');
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  };
  const canonicalAsset = v => {
    let raw = clean(v).toUpperCase();
    if (!raw || raw.length > 64) return '';
    const otc = /(?:\(|\b|[_-])OTC(?:\)|\b)?/.test(raw);
    let s = raw.replace(/\(OTC\)|\bOTC\b/g, '').replace(/^FRX[:_-]?/, '').replace(/\s+/g, '').replace(/_/g, '/').replace(/-/g, '/');
    s = s.replace(/^\/+|\/+$/g, '').replace(/\/{2,}/g, '/');
    if (!s.includes('/')) {
      const quotes = ['USDT', 'USDC', 'USD', 'EUR', 'GBP', 'JPY', 'AUD', 'CAD', 'CHF', 'NZD', 'BRL', 'BTC', 'ETH'];
      const quote = quotes.find(q => s.length > q.length && s.endsWith(q));
      if (quote) s = `${s.slice(0, -quote.length)}/${quote}`;
      else if (/^[A-Z]{6}$/.test(s)) s = `${s.slice(0, 3)}/${s.slice(3)}`;
    }
    if (!/^[A-Z0-9]{2,16}\/[A-Z0-9]{2,12}$/.test(s)) return '';
    return `${s}${otc ? ' (OTC)' : ''}`;
  };
  const normalizeTf = v => {
    const s = clean(v).toUpperCase().replace(/\s+/g, '');
    if (!s) return null;
    let m = s.match(/^(?:M)?(1|2|5|15|30)(?:M|MIN)?$/); if (m) return `M${m[1]}`;
    m = s.match(/^(?:S)?(5|15|30)(?:S|SEG)?$/); if (m && /S|SEG/.test(s)) return `S${m[1]}`;
    if (/^(H1|1H|60M|60MIN)$/.test(s)) return 'H1';
    if (/^(H4|4H)$/.test(s)) return 'H4';
    return /^D1$/.test(s) ? 'D1' : null;
  };
  const normalizeExp = v => {
    const s = clean(v).toLowerCase().replace(/\s+/g, '');
    let m = s.match(/^(\d{1,4})(?:s|seg|segundos?)$/); if (m) return `${Number(m[1])}s`;
    m = s.match(/^(\d{1,3})(?:m|min|minutos?)$/); if (m) return Number(m[1]) === 1 ? '60s' : `${Number(m[1])}m`;
    return null;
  };
  const instrumentFrom = v => {
    const s = fold(v);
    if (/\bblitz\b/.test(s)) return 'blitz';
    if (/\bbinaria\b|\bbinary\b/.test(s)) return 'binary';
    if (/\bturbo\b/.test(s)) return 'turbo';
    if (/\bcfd\b/.test(s)) return 'cfd';
    return 'unknown';
  };
  const compile = (source, flags = '') => { try { return source ? new RegExp(source, flags) : null; } catch { return null; } };
  const unique = arr => [...new Set(arr.filter(Boolean))];
  const pageText = () => clean(document.body?.innerText || document.body?.textContent || '').slice(0, 150000);

  const selectorList = key => {
    const override = settings.selectorsByPlatform?.[platform.id]?.[key];
    if (override) return [override];
    return unique([platform.defaultSelectors?.[key], ...(platform.selectorCandidates?.[key] || [])]);
  };
  const selectorNodes = key => {
    const out = [];
    for (const selector of selectorList(key)) {
      try {
        for (const el of document.querySelectorAll(selector)) if (visible(el)) out.push(el);
      } catch {}
    }
    return [...new Set(out)].slice(0, 200);
  };
  const textOf = el => el instanceof HTMLInputElement || el instanceof HTMLSelectElement ? clean(el.value || el.selectedOptions?.[0]?.textContent || '') : clean(el.innerText || el.textContent || '');
  const activeWeight = el => {
    const aria = el.getAttribute?.('aria-selected');
    const state = el.getAttribute?.('data-state');
    const cls = String(el.className || '');
    return aria === 'true' || state === 'active' || /active|selected|current/i.test(cls) ? 30 : 0;
  };

  const assetRegex = /\b(?:[A-Z0-9]{2,16}\s*[\/_-]\s*[A-Z0-9]{2,12}|[A-Z]{6})(?:\s*\(?OTC\)?)?\b/gi;
  const assetsIn = text => {
    const out = [];
    for (const m of String(text || '').matchAll(assetRegex)) {
      const a = canonicalAsset(m[0]);
      if (a) out.push(a);
      if (out.length >= 150) break;
    }
    return unique(out);
  };
  const scanDomAssets = () => {
    const map = new Map();
    const selectors = 'button,[role="tab"],[role="option"],[aria-selected],[data-state],a,span,strong,b,div,li,svg text';
    const nodes = document.querySelectorAll(selectors);
    for (let i = 0; i < Math.min(nodes.length, 5000); i++) {
      const el = nodes[i];
      if (!visible(el)) continue;
      const t = textOf(el);
      if (!t || t.length > 80) continue;
      for (const asset of assetsIn(t)) {
        const rect = el.getBoundingClientRect();
        let score = activeWeight(el) + (rect.top >= 0 && rect.top < innerHeight * .35 ? 12 : 0) + (/otc/i.test(t) ? 3 : 0);
        if (/portfolio|historico|histórico|chat|suporte/i.test(fold(t))) score -= 10;
        const prev = map.get(asset);
        if (!prev || score > prev.score) map.set(asset, { asset, score, el, text: t });
      }
    }
    return [...map.values()].sort((a, b) => b.score - a.score);
  };
  const selectedAsset = domAssets => {
    for (const el of selectorNodes('asset')) {
      const list = assetsIn(textOf(el));
      if (list[0]) return list[0];
    }
    const strong = domAssets.find(x => x.score >= 25);
    return strong?.asset || domAssets[0]?.asset || null;
  };

  const selectedTimeframe = () => {
    const candidates = [...selectorNodes('timeframe'), ...document.querySelectorAll('[aria-selected="true"],[data-state="active"],button,[role="button"]')];
    for (const el of candidates) {
      if (!visible(el)) continue;
      const t = textOf(el);
      if (t.length > 40) continue;
      const tf = normalizeTf(t);
      if (tf) return tf;
    }
    const m = pageText().match(/(?:TIMEFRAME|PER[IÍ]ODO|VELA)\s*[:\-]?\s*(S(?:5|15|30)|M(?:1|2|5|15|30)|(?:1|2|5|15|30)\s*(?:MIN|M)|(?:5|15|30)\s*(?:SEG|S))/i);
    return m ? normalizeTf(m[1]) : null;
  };
  const selectedExpiration = () => {
    for (const el of selectorNodes('expiration')) {
      const t = textOf(el);
      const exp = normalizeExp(t.match(/\d+\s*(?:s|seg(?:undos?)?|m|min(?:utos?)?)/i)?.[0] || t);
      if (exp) return exp;
    }
    const m = pageText().match(/(?:EXPIRA(?:ÇÃO|CAO)|EXPIRY|DURA(?:ÇÃO|CAO))\s*[:\-]?\s*(\d{1,4})\s*(S|SEG(?:UNDOS?)?|M|MIN(?:UTOS?)?)/i);
    return m ? normalizeExp(`${m[1]}${m[2]}`) : null;
  };

  const networkCandidates = () => (Array.isArray(networkState?.candidates) ? networkState.candidates : []).map(c => ({
    ...c,
    asset: canonicalAsset(c.asset),
    price: num(c.price) ?? (num(c.bid) != null && num(c.ask) != null ? (num(c.bid) + num(c.ask)) / 2 : null),
    timeframe: normalizeTf(c.timeframe),
    expiration: normalizeExp(c.expiration),
    confidence: Number(c.confidence || 0),
    seenCount: Number(c.seenCount || 0),
    observedAt: Number(c.observedAt || 0)
  })).filter(c => c.asset && c.price != null && c.price > 0);
  const structuredNetworkQuote = activeAsset => {
    const t = Date.now();
    const fresh = networkCandidates().filter(c => ['ws', 'fetch', 'xhr'].includes(c.transport) && c.seenCount >= 2 && t - c.observedAt <= 6500 && c.confidence >= 45);
    if (!fresh.length) return null;
    const wanted = canonicalAsset(activeAsset);
    if (wanted) {
      const exact = fresh.find(c => c.asset === wanted);
      if (exact) return exact;
      const noOtc = wanted.replace(/ \(OTC\)$/, '');
      const compatible = fresh.find(c => c.asset.replace(/ \(OTC\)$/, '') === noOtc);
      if (compatible) return compatible;
    }
    const selected = fresh.find(c => c.selected);
    if (selected) return selected;
    return fresh.length === 1 ? fresh[0] : null;
  };
  const historyFor = asset => {
    const history = networkState?.recentCandles || {};
    const wanted = canonicalAsset(asset);
    const key = Object.keys(history).find(k => canonicalAsset(k) === wanted || canonicalAsset(k).replace(/ \(OTC\)$/, '') === wanted.replace(/ \(OTC\)$/, ''));
    return key && Array.isArray(history[key]) ? history[key].slice(-120) : [];
  };

  const nearbyPrice = (assetEntry, patterns) => {
    const direct = selectorNodes('price');
    for (const el of direct) {
      const n = num(textOf(el));
      if (n != null && n > 0) return n;
    }
    if (assetEntry?.el) {
      let p = assetEntry.el;
      for (let depth = 0; depth < 4 && p; depth++, p = p.parentElement) {
        const nodes = p.querySelectorAll?.('span,strong,b,p,div,[class*="price" i],[class*="quote" i]') || [];
        for (let i = 0; i < Math.min(nodes.length, 120); i++) {
          const t = textOf(nodes[i]);
          if (t.length > 40) continue;
          const m = patterns.price?.exec(t);
          const n = num(m?.[0] || t);
          if (n != null && n > 0 && String(n).length >= 3) return n;
        }
      }
    }
    const nodes = document.querySelectorAll('span,strong,b,p,[class*="price" i],[class*="quote" i],[class*="rate" i],svg text');
    for (let i = 0; i < Math.min(nodes.length, 2500); i++) {
      const t = textOf(nodes[i]);
      if (!t || t.length > 32) continue;
      const m = patterns.price?.exec(t);
      if (!m) continue;
      const n = num(m[0]);
      if (n != null && n > 0) return n;
    }
    return null;
  };

  async function inspect() {
    if (!platform || inspecting) return;
    inspecting = true;
    try {
      const patterns = {
        price: compile(platform.patterns?.price, platform.patternFlags?.price || 'i'),
        asset: compile(platform.patterns?.asset, platform.patternFlags?.asset || 'i'),
        timeframe: compile(platform.patterns?.timeframe, platform.patternFlags?.timeframe || 'i')
      };
      const domAssets = scanDomAssets();
      const activeDomAsset = selectedAsset(domAssets) || lastAsset;
      const netQuote = structuredNetworkQuote(activeDomAsset);
      const asset = netQuote?.asset || activeDomAsset || null;
      if (asset) lastAsset = asset;
      const domEntry = domAssets.find(x => x.asset === activeDomAsset) || domAssets[0] || null;
      const price = netQuote?.price ?? nearbyPrice(domEntry, patterns);
      const timeframe = selectedTimeframe() || netQuote?.timeframe || null;
      const expiration = selectedExpiration() || netQuote?.expiration || null;
      const contextText = clean([domEntry?.el?.parentElement?.innerText, domEntry?.text, pageText().slice(0, 20000)].filter(Boolean).join(' '));
      const instrumentType = netQuote?.instrumentType || instrumentFrom(contextText);
      const marketType = /\(OTC\)/i.test(asset || '') || netQuote?.marketType === 'otc' || /\bOTC\b/i.test(domEntry?.text || '') ? 'otc' : 'regular';
      const structured = !!netQuote;
      const history = historyFor(asset);
      const networkAll = networkCandidates();
      const catalogAssets = unique([...domAssets.map(x => x.asset), ...networkAll.map(x => x.asset)]).slice(0, 150);
      const domCandidates = catalogAssets.map(a => {
        const n = networkAll.find(x => x.asset === a);
        return {
          asset: a,
          price: n?.price ?? (a === activeDomAsset ? price : null),
          bid: n?.bid ?? null,
          ask: n?.ask ?? null,
          timeframe: n?.timeframe || timeframe,
          expiration: n?.expiration || expiration,
          payout: n?.payout ?? null,
          transport: n?.transport || 'dom',
          seenCount: n?.seenCount || 1,
          observedAt: n?.observedAt || Date.now(),
          confidence: n?.confidence || (domAssets.some(x => x.asset === a) ? 35 : 20),
          source: n ? 'network' : 'dom'
        };
      });
      chrome.runtime.sendMessage({
        type: 'ATS_DOM_CATALOG',
        payload: { candidates: domCandidates, assetCount: catalogAssets.length, timeframe, expiration, instrumentType, marketType }
      }).catch(() => {});

      const rawServerTime = num(netQuote?.timestamp);
      const serverTime = rawServerTime && rawServerTime > 1e12 ? rawServerTime : null;
      const missing = [!asset ? 'asset' : null, price == null ? 'price' : null, !timeframe ? 'timeframe' : null].filter(Boolean);
      const capture = structured ? 'websocket-estruturado+contexto-dom' : catalogAssets.length ? 'dom+rede-provisória' : 'mapeando-plataforma';
      const diagKey = `${capture}|${missing.join(',')}|${catalogAssets.length}`;
      if (diagKey !== lastDebug) {
        console.debug(`[ATS ${platform.name}] ${capture}`, { asset, timeframe, expiration, assets: catalogAssets.length, missing });
        lastDebug = diagKey;
      }
      const networkQuality = Number(networkState?.feedQuality || 0);
      const snapshot = {
        platformId: platform.id,
        platformName: platform.name,
        adapterVersion: chrome.runtime.getManifest().version,
        connection: 'online',
        url: location.origin + location.pathname,
        asset,
        timeframe,
        price,
        marketType,
        instrumentType,
        expiration,
        serverTime,
        candles: history,
        ticks: price != null ? [{ price, at: serverTime || Date.now() }] : [],
        capabilities: {
          ...platform.capabilities,
          structuredQuotes: structured,
          candles: history.length >= 3,
          expiration: !!expiration,
          multiAsset: catalogAssets.length > 1
        },
        diagnostics: {
          capture,
          structuredSource: structured ? netQuote?.transport || 'network' : null,
          networkQuoteMatched: structured,
          networkQuoteSeenCount: Number(netQuote?.seenCount || 0),
          networkConfidence: Number(netQuote?.confidence || 0),
          networkQuality,
          missing,
          host: location.hostname,
          domAssets: domAssets.length,
          catalogAssets: catalogAssets.length,
          domNodes: document.getElementsByTagName('*').length,
          canvases: document.querySelectorAll('canvas').length,
          svgs: document.querySelectorAll('svg').length,
          candleHistory: history.length,
          networkCandidateCount: networkAll.length,
          networkAgeMs: structured ? Date.now() - Number(netQuote.observedAt || 0) : null,
          privacy: 'Sem cookies, credenciais, tokens, headers ou saldo.'
        }
      };
      chrome.runtime.sendMessage({ type: 'ATS_PLATFORM_SNAPSHOT', payload: snapshot }).catch(() => {});
    } finally {
      inspecting = false;
    }
  }

  const schedule = (delay = 180) => { clearTimeout(timer); timer = setTimeout(inspect, delay); };

  async function init() {
    try {
      const r = await chrome.runtime.sendMessage({ type: 'ATS_GET_PLATFORM_CONFIG', host: location.hostname });
      platform = r?.platform || null;
      if (!platform) return;
      const stored = await chrome.storage.local.get(['settings', 'scannerState']).catch(() => ({}));
      settings = stored.settings || {};
      networkState = stored.scannerState?.diagnostics?.network || {};
      chrome.storage.onChanged.addListener(changes => {
        if (changes.settings) settings = changes.settings.newValue || {};
        if (changes.scannerState) {
          const next = changes.scannerState.newValue?.diagnostics?.network || {};
          const changed = Number(next.lastSeen || 0) !== Number(networkState.lastSeen || 0) || Number(next.candidateCount || 0) !== Number(networkState.candidateCount || 0);
          networkState = next;
          if (changed) schedule(80);
        }
      });
      const start = () => {
        if (!document.documentElement) return setTimeout(start, 50);
        new MutationObserver(() => schedule(160)).observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class', 'aria-selected', 'data-state'] });
        inspect();
        setInterval(inspect, 1800);
      };
      start();
      addEventListener('focus', () => schedule(40));
      addEventListener('load', () => schedule(40), { once: true });
    } catch (e) {
      console.debug('[ATS] falha ao iniciar adapter:', e?.message || e);
    }
  }

  init();
})();
