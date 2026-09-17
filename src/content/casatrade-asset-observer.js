(() => {
  if (globalThis.__ATS_ASSET_OBSERVER__) return;
  globalThis.__ATS_ASSET_OBSERVER__ = true;

  const protocol = String(location.protocol || '').toLowerCase();
  const opaqueChild = window !== window.top && (!location.hostname || ['about:','blob:','data:'].includes(protocol));
  const directSend = message => {
    const fn = globalThis.__ATS_SEND_MESSAGE__;
    if (typeof fn === 'function') return fn(message);
    return new Promise(resolve => {
      let tries = 0;
      const retry = () => {
        const current = globalThis.__ATS_SEND_MESSAGE__;
        if (typeof current === 'function') current(message).then(resolve).catch(() => resolve(null));
        else if (++tries < 80) setTimeout(retry, 50);
        else resolve(null);
      };
      retry();
    });
  };
  const send = message => opaqueChild
    ? directSend({ type: 'ATS_OPAQUE_FRAME_PROXY', payload: message })
    : directSend(message);

  const clean = value => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  const canonical = value => {
    const raw = clean(value).toUpperCase();
    if (!raw || raw.length > 180) return '';
    const otc = /(?:\(|\b|[_-])OTC(?:\)|\b)?/.test(raw);
    const direct = raw.match(/\b([A-Z0-9]{2,20})\s*[\/_-]\s*([A-Z0-9]{2,12})/);
    if (direct) return `${direct[1]}/${direct[2]}${otc ? ' (OTC)' : ''}`;
    const compact = raw.replace(/\(\s*OTC\s*\)|\bOTC\b/g, '').replace(/[^A-Z0-9]/g, '');
    const quote = ['USDT','USDC','USD','EUR','GBP','JPY','AUD','CAD','CHF','NZD','BRL','BTC','ETH'].find(q => compact.length > q.length && compact.endsWith(q));
    return quote ? `${compact.slice(0, -quote.length)}/${quote}${otc ? ' (OTC)' : ''}` : '';
  };

  const visible = element => {
    if (!(element instanceof Element)) return false;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 8 && rect.height > 8 && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0;
  };

  let cache = [], cacheAt = 0;
  function elements(limit = 7600) {
    const now = Date.now();
    if (cache.length && now - cacheAt < 250) return cache.slice(0, limit);
    const out = [], roots = [document], seen = new Set();
    while (roots.length && out.length < 8200) {
      const root = roots.shift();
      if (!root || seen.has(root)) continue;
      seen.add(root);
      let rows = [];
      try { rows = [...root.querySelectorAll('*')]; } catch {}
      for (const element of rows) {
        out.push(element);
        if (out.length >= 8200) break;
        if (element.shadowRoot) roots.push(element.shadowRoot);
      }
    }
    cache = out;
    cacheAt = now;
    return out.slice(0, limit);
  }

  const elementText = element => clean([
    element?.getAttribute?.('aria-label'),
    element?.getAttribute?.('title'),
    element?.getAttribute?.('data-symbol'),
    element?.getAttribute?.('data-asset'),
    element?.getAttribute?.('data-instrument'),
    element?.getAttribute?.('data-testid'),
    element?.innerText,
    element?.textContent
  ].filter(Boolean).join(' ')).slice(0, 180);

  function ancestry(element) {
    const parts = [];
    let node = element;
    for (let i = 0; node && i < 5; i += 1, node = node.parentElement) {
      parts.push(
        node.id || '',
        typeof node.className === 'string' ? node.className : '',
        node.getAttribute?.('role') || '',
        node.getAttribute?.('data-testid') || '',
        node.getAttribute?.('aria-label') || '',
        node.getAttribute?.('aria-selected') || '',
        node.getAttribute?.('aria-current') || '',
        node.getAttribute?.('data-state') || '',
        node.getAttribute?.('data-active') || ''
      );
    }
    return clean(parts.join(' ')).toLowerCase();
  }

  function chartRect() {
    const rows = [];
    for (const element of elements(5200)) {
      if (!visible(element)) continue;
      const tag = String(element.tagName || '').toLowerCase();
      const meta = `${element.id || ''} ${typeof element.className === 'string' ? element.className : ''} ${element.getAttribute?.('data-testid') || ''}`.toLowerCase();
      if (tag !== 'canvas' && tag !== 'svg' && !/chart|candle|graph|tradingview|plot/.test(meta)) continue;
      const rect = element.getBoundingClientRect();
      if (rect.width < 220 || rect.height < 140) continue;
      let score = rect.width * rect.height;
      if (tag === 'canvas') score *= 1.8;
      if (/chart|candle|tradingview/.test(meta)) score *= 1.3;
      rows.push({ rect, score });
    }
    rows.sort((a, b) => b.score - a.score);
    return rows[0]?.rect || null;
  }

  function nearChartHeader(rect, chart) {
    if (!chart) return false;
    const horizontal = rect.left <= chart.left + Math.max(440, chart.width * .6) && rect.right >= chart.left - 90;
    const vertical = rect.top >= Math.max(0, chart.top - 200) && rect.top <= chart.top + Math.min(190, chart.height * .30);
    return horizontal && vertical;
  }

  function selectedCandidate() {
    const chart = chartRect();
    const rows = [];
    for (const element of elements()) {
      if (!visible(element)) continue;
      const label = elementText(element);
      const asset = canonical(label);
      if (!asset) continue;

      const rect = element.getBoundingClientRect();
      const ctx = ancestry(element);
      const flags = `${element.getAttribute?.('aria-selected') || ''} ${element.getAttribute?.('aria-current') || ''} ${element.getAttribute?.('data-state') || ''} ${element.getAttribute?.('data-active') || ''} ${typeof element.className === 'string' ? element.className : ''}`;
      const selected = /(?:^|\s|[-_])(active|selected|current|checked)(?:\s|[-_]|$)|\btrue\b/i.test(flags);
      const headerScoped = nearChartHeader(rect, chart) || /chart|instrument|symbol|asset|ativo|market|pair/.test(ctx);
      const listOnly = /watchlist|instrument-list|asset-list|search|modal|drawer|dropdown|menu|listbox/.test(ctx) && !selected && !headerScoped;
      if (listOnly) continue;

      let score = 100;
      if (selected) score += 850;
      if (nearChartHeader(rect, chart)) score += 900;
      if (/chart|instrument|symbol|asset|ativo|market|pair/.test(ctx)) score += 300;
      if (/tab/.test(ctx) && selected) score += 300;
      if (/tab/.test(ctx) && !selected) score -= 180;
      if (label.length <= 42) score += 120;
      if (/\bOTC\b/.test(label.toUpperCase())) score += 40;
      if (rect.left < innerWidth * .48 && rect.top < innerHeight * .45) score += 140;
      const size = Number.parseFloat(getComputedStyle(element).fontSize || '0');
      if (size >= 14) score += Math.min(120, Math.round(size * 4));
      rows.push({ asset, score, selected, label });
    }

    rows.sort((a, b) => b.score - a.score || Number(b.selected) - Number(a.selected));
    return rows[0] || null;
  }

  let lastAsset = '', samples = 0, timer = null, lastSentAt = 0;
  function publish(candidate, explicit = false, source = 'visible-chart') {
    const asset = canonical(candidate?.asset || candidate || '');
    if (!asset) return;
    if (asset === lastAsset) samples += 1;
    else { lastAsset = asset; samples = 1; }

    const score = Number(candidate?.score || 0);
    const strong = explicit || score >= 900;
    if (!strong && samples < 2) return;
    const now = Date.now();
    if (!explicit && now - lastSentAt < 350 && samples < 3) return;
    lastSentAt = now;
    send({
      type: 'ATS_VISUAL_FOCUS_V2',
      asset,
      reliable: true,
      chartScoped: true,
      visual: true,
      explicit,
      score: Math.max(explicit ? 1000 : 0, score),
      samples,
      frameRole: location.hostname.includes('casatraders') ? 'trader-frame' : 'casa-chart-frame',
      source
    }).catch(() => {});
  }

  function scan() {
    const candidate = selectedCandidate();
    if (candidate) publish(candidate, false, candidate.selected ? 'visible-selected' : 'visible-chart-header');
  }

  function schedule(delay = 90) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; cacheAt = 0; scan(); }, delay);
  }

  document.addEventListener('pointerup', event => {
    const path = event.composedPath?.() || [event.target];
    for (const node of path) {
      if (!(node instanceof Element) || !visible(node)) continue;
      const asset = canonical(elementText(node));
      if (asset) {
        publish({ asset, score: 1600 }, true, 'user-selection');
        break;
      }
    }
    schedule(80);
    setTimeout(() => schedule(0), 260);
    setTimeout(() => schedule(0), 700);
  }, true);

  new MutationObserver(() => schedule()).observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    characterData: true,
    attributeFilter: ['class','aria-selected','aria-current','data-selected','data-symbol','data-asset','data-state','data-active']
  });

  window.addEventListener('popstate', () => schedule(0), true);
  window.addEventListener('hashchange', () => schedule(0), true);
  scan();
  setTimeout(scan, 350);
  setTimeout(scan, 900);
  setTimeout(scan, 1800);
  setTimeout(function heartbeat() { cacheAt = 0; scan(); setTimeout(heartbeat, 900); }, 900);
})();
