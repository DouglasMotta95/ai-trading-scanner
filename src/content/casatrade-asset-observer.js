(() => {
  if (globalThis.__ATS_ASSET_OBSERVER__) return;
  globalThis.__ATS_ASSET_OBSERVER__ = true;

  const send = message => {
    const fn = globalThis.__ATS_SEND_MESSAGE__;
    if (typeof fn === 'function') return fn(message);
    return new Promise(resolve => {
      let tries = 0;
      const retry = () => {
        const current = globalThis.__ATS_SEND_MESSAGE__;
        if (typeof current === 'function') current(message).then(resolve).catch(() => resolve(null));
        else if (++tries < 50) setTimeout(retry, 50);
        else resolve(null);
      };
      retry();
    });
  };

  const clean = value => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  const canonical = value => {
    const raw = clean(value).toUpperCase();
    if (!raw || raw.length > 96) return '';
    const otc = /(?:\(|\b|[_-])OTC(?:\)|\b)?/.test(raw);
    const match = raw.match(/\b([A-Z0-9]{2,20})\s*[\/_-]\s*([A-Z0-9]{2,12})/);
    return match ? `${match[1]}/${match[2]}${otc ? ' (OTC)' : ''}` : '';
  };
  const visible = element => {
    if (!(element instanceof Element)) return false;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 8 && rect.height > 8 && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0;
  };
  const ownText = element => {
    if (!(element instanceof Element)) return '';
    const direct = [
      element.getAttribute?.('aria-label'),
      element.getAttribute?.('title'),
      element.getAttribute?.('data-symbol'),
      element.getAttribute?.('data-asset'),
      element.getAttribute?.('data-testid')
    ].filter(Boolean).join(' ');
    const text = clean(element.textContent || '');
    return clean(`${direct} ${text.length <= 80 ? text : ''}`);
  };
  const singleAsset = value => {
    const text = clean(value);
    if (!text || text.length > 96) return '';
    const matches = [...text.toUpperCase().matchAll(/\b([A-Z0-9]{2,20})\s*[\/_-]\s*([A-Z0-9]{2,12})(?:\s*\(\s*OTC\s*\))?/g)]
      .map(match => canonical(match[0]))
      .filter(Boolean);
    const unique = [...new Set(matches)];
    return unique.length === 1 ? unique[0] : '';
  };

  let lastAsset = '';
  let samples = 0;
  let timer = null;

  function publish(asset, explicit = false, source = 'visible-chart') {
    asset = canonical(asset);
    if (!asset) return;
    if (asset === lastAsset) samples += 1;
    else { lastAsset = asset; samples = 1; }
    if (!explicit && samples < 2) return;
    send({
      type: 'ATS_VISUAL_FOCUS_V2',
      asset,
      reliable: true,
      chartScoped: true,
      visual: true,
      explicit,
      score: explicit ? 100 : 94,
      samples,
      frameRole: location.hostname.includes('casatraders') ? 'trader-frame' : 'casa-chart-frame',
      source
    }).catch(() => {});
  }

  function selectedTabCandidate() {
    const selectors = [
      '[role="tab"][aria-selected="true"]',
      '[aria-current="true"]',
      '[data-selected="true"]',
      '[data-state="active"][role="tab"]'
    ];
    for (const element of document.querySelectorAll(selectors.join(','))) {
      if (!visible(element)) continue;
      const asset = singleAsset(ownText(element));
      if (asset) return asset;
    }
    return '';
  }

  function visibleChartCandidate() {
    const rows = [];
    const elements = document.querySelectorAll('[data-symbol],[data-asset],[data-testid],h1,h2,h3,h4,button,[role="button"],[role="tab"],span,div');
    const width = Math.max(1, window.innerWidth || document.documentElement.clientWidth || 1);
    const height = Math.max(1, window.innerHeight || document.documentElement.clientHeight || 1);
    let inspected = 0;
    for (const element of elements) {
      if (++inspected > 2600 || !visible(element)) continue;
      const text = ownText(element);
      const asset = singleAsset(text);
      if (!asset) continue;
      const rect = element.getBoundingClientRect();
      if (rect.width > width * .55 || rect.height > 100) continue;
      const flags = `${element.getAttribute?.('aria-selected') || ''} ${element.getAttribute?.('aria-current') || ''} ${element.getAttribute?.('data-state') || ''} ${element.className || ''}`.toLowerCase();
      let score = 0;
      if (rect.left < width * .45) score += 35;
      if (rect.top > 55 && rect.top < Math.min(height * .42, 280)) score += 42;
      if (/true|active|selected|current/.test(flags)) score += 38;
      if (element.matches('h1,h2,h3,h4,[data-symbol],[data-asset],[data-testid*="symbol" i],[data-testid*="asset" i]')) score += 34;
      if (element.matches('[role="tab"]') && !/true|active|selected|current/.test(flags)) score -= 24;
      if (text.length <= 28) score += 12;
      rows.push({ asset, score, top: rect.top });
    }
    rows.sort((a, b) => b.score - a.score || b.top - a.top);
    return rows[0]?.score >= 45 ? rows[0].asset : '';
  }

  function scan() {
    const chart = visibleChartCandidate();
    const selected = selectedTabCandidate();
    publish(chart || selected, false, chart ? 'visible-chart-label' : 'selected-chart-tab');
  }

  function schedule(delay = 90) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; scan(); }, delay);
  }

  document.addEventListener('pointerup', event => {
    const target = event.target instanceof Element
      ? event.target.closest('[role="tab"],[data-symbol],[data-asset],[data-testid*="asset" i],[data-testid*="symbol" i],button')
      : null;
    if (target && visible(target)) {
      const asset = singleAsset(ownText(target));
      if (asset) publish(asset, true, 'user-chart-selection');
    }
    schedule(180);
    setTimeout(scan, 480);
  }, true);

  new MutationObserver(() => schedule()).observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['class','aria-selected','aria-current','data-selected','data-state','data-symbol','data-asset']
  });

  window.addEventListener('popstate', () => schedule(80), true);
  window.addEventListener('hashchange', () => schedule(80), true);
  scan();
  setTimeout(scan, 500);
  setTimeout(scan, 1400);
  setTimeout(function heartbeat() { scan(); setTimeout(heartbeat, 1200); }, 1200);
})();
