(() => {
  const FOCUS_READER_BUILD = 'focused-asset-v2-chart-header-named-asset-v7';
  if (globalThis.__ATS_FOCUSED_ASSET_TRACKER_V2_BUILD__ === FOCUS_READER_BUILD) return;
  globalThis.__ATS_FOCUSED_ASSET_TRACKER_V2_BUILD__ = FOCUS_READER_BUILD;
  globalThis.__ATS_FOCUSED_ASSET_TRACKER_V2__ = true;
  globalThis.__ATS_FOCUSED_ASSET_TRACKER__ = true;

  const clean = value => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  const host = String(location.hostname || '').toLowerCase().replace(/\.$/, '');
  const traderHost = value => value === 'casatraders.online' || value.endsWith('.casatraders.online') || value === 'ivcasatraders.online' || value.endsWith('.ivcasatraders.online');
  const casaHost = value => value === 'casatrade.com' || value.endsWith('.casatrade.com') || value === 'casatrade.io' || value.endsWith('.casatrade.io');
  if (!traderHost(host) && !casaHost(host)) return;
  const frameRole = traderHost(host) ? 'trader-frame' : 'casa-chart-frame';

  // OTC and regular quotes are different live markets.
  const QUOTES = new Set(['USDT','USDC','USD','EUR','GBP','JPY','AUD','CAD','CHF','NZD','BRL','BTC','ETH']);
  const pairRe = /\b([A-Z0-9]{2,20})\s*[\/_-]\s*([A-Z0-9]{2,12})(?:\s*\(\s*OTC\s*\)|\s+OTC)?/gi;
  const compactFxRe = /\b([A-Z]{3})([A-Z]{3})(?:\s*\(\s*OTC\s*\)|[_-]?OTC)?\b/gi;

  function assetsIn(value = '') {
    const raw = clean(value).toUpperCase();
    if (!raw || raw.length > 180) return [];
    const out = [];
    const seen = new Set();
    const add = (base, quote, otc) => {
      if (!QUOTES.has(quote)) return;
      const asset = `${base}/${quote}${otc ? ' (OTC)' : ''}`;
      if (!seen.has(asset)) { seen.add(asset); out.push(asset); }
    };
    for (const match of raw.matchAll(pairRe)) add(match[1], match[2], /OTC/i.test(match[0]));
    if (!out.length) for (const match of raw.matchAll(compactFxRe)) add(match[1], match[2], /OTC/i.test(match[0]));
    return out;
  }

  const AMBIGUOUS_NAMED = new Set([
    'EURO','DOLLAR','DÓLAR','USD','EUR','GBP','JPY','AUD','CAD','CHF','NZD','BRL',
    'BUY','SELL','COMPRA','VENDA','BLITZ','DIGITAL','INFO','OTC'
  ]);
  function namedChartAsset(value = '') {
    const raw = clean(value).normalize('NFKC');
    if (!raw || raw.length > 64 || !/\(\s*OTC\s*\)/i.test(raw)) return '';
    const name = raw.replace(/\(\s*OTC\s*\)/ig, '').replace(/\s+/g, ' ').trim();
    const upper = name.toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9 ._-]{2,30}$/i.test(name)) return '';
    if (AMBIGUOUS_NAMED.has(upper)) return '';
    if (/\b(?:PORTF[ÓO]LIO|HIST[ÓO]RICO|TABELA|PROMO[CÇ][AÃ]O|AN[ÁA]LISE|VALOR|EXPIRA[CÇ][AÃ]O|LUCRO)\b/i.test(name)) return '';
    return `${upper} (OTC)`;
  }

  const canonicalAsset = value => assetsIn(value)[0] || namedChartAsset(value) || '';
  const identity = value => canonicalAsset(value);
  const sameAsset = (a, b) => !!identity(a) && identity(a) === identity(b);
  const visible = el => {
    if (!el || !(el instanceof Element)) return false;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0;
  };

  let elementCache = [];
  let elementCacheAt = 0;
  function invalidateElements() { elementCacheAt = 0; }
  function deepElements(limit = 7000) {
    const now = Date.now();
    if (elementCache.length && now - elementCacheAt < 450) return elementCache.slice(0, limit);
    const out = [];
    const roots = [document];
    const seen = new Set();
    while (roots.length && out.length < 7000) {
      const root = roots.shift();
      if (!root || seen.has(root)) continue;
      seen.add(root);
      let nodes = [];
      try { nodes = [...root.querySelectorAll('*')]; } catch {}
      for (const node of nodes) {
        out.push(node);
        if (out.length >= 7000) break;
        if (node.shadowRoot) roots.push(node.shadowRoot);
      }
    }
    elementCache = out;
    elementCacheAt = now;
    return out.slice(0, limit);
  }

  function chartRect() {
    const rows = [];
    for (const el of deepElements(5000)) {
      if (!visible(el)) continue;
      const tag = String(el.tagName || '').toLowerCase();
      const meta = `${el.className || ''} ${el.id || ''} ${el.getAttribute?.('data-testid') || ''}`.toLowerCase();
      if (tag !== 'canvas' && tag !== 'svg' && !/chart|candle|graph|tradingview|plot/.test(meta)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 180 || r.height < 120) continue;
      let score = r.width * r.height;
      if (tag === 'canvas') score *= 1.8;
      if (/chart|candle|tradingview/.test(meta)) score *= 1.3;
      rows.push({ rect: r, score });
    }
    rows.sort((a, b) => b.score - a.score);
    return rows[0]?.rect || null;
  }

  function selectionEvidence(el) {
    let score = 0;
    let explicit = false;
    let rejected = false;
    let node = el;
    for (let depth = 0; node && depth < 4; depth++, node = node.parentElement) {
      const weight = depth === 0 ? 1 : depth === 1 ? .7 : depth === 2 ? .45 : .25;
      const ariaSelected = String(node.getAttribute?.('aria-selected') || '').toLowerCase();
      const ariaCurrent = String(node.getAttribute?.('aria-current') || '').toLowerCase();
      const dataState = String(node.getAttribute?.('data-state') || '').toLowerCase();
      const dataActive = String(node.getAttribute?.('data-active') || '').toLowerCase();
      const cls = String(node.className || '');
      if (ariaSelected === 'true') { score += 700 * weight; explicit = true; }
      if (ariaSelected === 'false' && depth === 0) { score -= 600; rejected = true; }
      if (ariaCurrent && ariaCurrent !== 'false') { score += 520 * weight; explicit = true; }
      if (dataActive === 'true' || dataActive === '1') { score += 500 * weight; explicit = true; }
      if (/^(active|selected|current|checked)$/.test(dataState)) { score += 480 * weight; explicit = true; }
      if (/(?:^|[\s_-])(active|selected|current|checked)(?:$|[\s_-])/i.test(cls)) {
        score += 250 * weight;
        if (depth <= 1) explicit = true;
      }
    }
    return { score, explicit, rejected };
  }

  function contextOf(el) {
    const parts = [];
    let node = el;
    for (let i = 0; node && i < 4; i++, node = node.parentElement) {
      parts.push(String(node.id || ''), String(node.className || ''), node.getAttribute?.('role') || '', node.getAttribute?.('data-testid') || '', node.getAttribute?.('aria-label') || '');
    }
    return parts.join(' ').toLowerCase();
  }

  function nearChart(rect, chart) {
    if (!chart) return false;
    const padX = Math.max(80, chart.width * .18);
    const top = Math.max(0, chart.top - Math.max(160, chart.height * .28));
    const bottom = chart.top + Math.min(150, chart.height * .28);
    return rect.right >= chart.left - padX && rect.left <= chart.right + padX && rect.bottom >= top && rect.top <= bottom;
  }

  function chartHeaderWinner(chart) {
    if (!chart) return null;
    const rows = [];
    const headerTop = Math.max(0, chart.top - 140);
    const headerBottom = chart.top + Math.min(180, chart.height * .24);
    const headerRight = chart.left + chart.width * .68;

    for (const el of deepElements(6500)) {
      if (!visible(el)) continue;
      const text = elementAssetText(el);
      if (!text || text.length > 64) continue;
      const assets = assetsIn(text);
      const named = assets.length ? '' : namedChartAsset(text);
      if (assets.length !== 1 && !named) continue;

      const rect = el.getBoundingClientRect();
      if (rect.bottom < headerTop || rect.top > headerBottom) continue;
      if (rect.left > headerRight || rect.right < chart.left - 120) continue;

      const context = contextOf(el);
      // The open-market tab strip can show several symbols at once. However,
      // responsive CasaTrade layouts can wrap the actual chart title in a
      // container whose class also contains "tab". Geometry decides: a symbol
      // physically attached to the chart header is still allowed to own focus.
      const tabLike = /watchlist|asset-list|instrument-list|listbox|search|history|portfolio|ranking|modal|drawer|dropdown|menu|tablist|asset-tab|instrument-tab|(?:^|[\s_-])tabs?(?:$|[\s_-])/.test(context);
      const physicallyInChartHeader = rect.top >= chart.top - 35
        && rect.top <= chart.top + Math.min(170, chart.height * .28)
        && rect.left <= chart.left + chart.width * .58;
      if (tabLike && !physicallyInChartHeader) continue;

      const selection = selectionEvidence(el);
      if (selection.rejected) continue;
      let score = 4000 + selection.score;
      if (/chart|tradingview|instrument|symbol|asset|header/.test(context)) score += 500;
      if (text.length <= 36) score += 200;
      score -= Math.max(0, rect.top - chart.top) * .5;
      rows.push({
        asset: assets[0] || named,
        score,
        explicit: true,
        interaction: interactionFresh(assets[0] || named),
        chartScoped: true,
        chartHits: 3,
        hits: 1,
        top: rect.top,
        left: rect.left,
        source: 'visible-chart-header'
      });
    }
    rows.sort((a,b) => b.score - a.score || a.top - b.top || a.left - b.left);
    if (!rows.length) return null;
    const first = rows[0];
    const second = rows.find(row => !sameAsset(row.asset, first.asset));
    if (second && Number(first.score) - Number(second.score) < 450) return null;
    return first;
  }

  const INTERACTION_TRANSITION_MS = 8000;
  let recentInteraction = { asset: '', at: 0 };
  const interactionFresh = asset => sameAsset(recentInteraction.asset, asset) && Date.now() - Number(recentInteraction.at || 0) < INTERACTION_TRANSITION_MS;

  function elementAssetText(el) {
    return clean([
      el?.getAttribute?.('aria-label'), el?.getAttribute?.('title'),
      el?.getAttribute?.('data-symbol'), el?.getAttribute?.('data-asset'), el?.getAttribute?.('data-instrument'),
      el?.getAttribute?.('data-testid'), el?.innerText, el?.textContent
    ].filter(Boolean).join(' ')).slice(0, 180);
  }

  function touchedAsset(event) {
    const path = typeof event?.composedPath === 'function' ? event.composedPath() : [event?.target];
    for (const node of path.slice(0, 8)) {
      if (!(node instanceof Element) || !visible(node)) continue;
      const text = elementAssetText(node);
      const assets = assetsIn(text);
      if (assets.length === 1) return assets[0];
      const named = namedChartAsset(text);
      if (named) return named;
    }
    return '';
  }

  function scanWinner() {
    const chart = chartRect();
    const header = chartHeaderWinner(chart);
    if (header?.asset) return { ...header, chartFound: true };
    const rows = [];
    for (const el of deepElements()) {
      if (!visible(el)) continue;
      const text = elementAssetText(el);
      if (!text || text.length > 180) continue;
      const assets = assetsIn(text);
      if (assets.length !== 1) continue;
      const asset = assets[0];
      const rect = el.getBoundingClientRect();
      const selection = selectionEvidence(el);
      if (selection.rejected) continue;
      const context = contextOf(el);
      const chartScoped = nearChart(rect, chart) || /chart|tradingview|instrument|symbol|asset|header/.test(context);
      const listContext = /watchlist|asset-list|instrument-list|listbox|search|history|portfolio|ranking|modal|drawer|dropdown|menu/.test(context);
      const tabContext = /(?:^|[\s_-])tabs?(?:$|[\s_-])|tablist|asset-tab|instrument-tab/.test(context);
      const interaction = interactionFresh(asset);
      // A visible dropdown/watchlist or an inactive market tab can contain many
      // symbols around the chart. Only its selected/current row or the row the
      // user just touched may own focus.
      if ((listContext || tabContext) && !selection.explicit && !interaction) continue;
      if (!chartScoped) continue;
      let score = selection.score;
      if (chartScoped) score += 520;
      if (chart && nearChart(rect, chart)) score += 480;
      if (/chart|tradingview|instrument|symbol|header/.test(context)) score += 180;
      if (interaction) score += 900;
      if (text.length <= 40) score += 70;
      rows.push({ asset, score, explicit: selection.explicit, interaction, chartScoped, top: rect.top, left: rect.left });
    }

    const grouped = new Map();
    for (const row of rows) {
      const id = identity(row.asset);
      const current = grouped.get(id) || { asset: row.asset, score: -Infinity, explicit: false, interaction: false, chartHits: 0, hits: 0, top: row.top, left: row.left };
      current.score = Math.max(current.score, row.score);
      current.explicit ||= row.explicit;
      current.interaction ||= row.interaction;
      current.chartHits += row.chartScoped ? 1 : 0;
      current.hits += 1;
      current.top = Math.min(current.top, row.top);
      current.left = Math.min(current.left, row.left);
      grouped.set(id, current);
    }

    const winners = [...grouped.values()].map(row => ({ ...row, score: row.score + Math.min(150, row.chartHits * 35) }));
    winners.sort((a, b) => Number(b.interaction) - Number(a.interaction)
      || Number(b.explicit) - Number(a.explicit)
      || b.chartHits - a.chartHits || b.score - a.score || a.top - b.top || a.left - b.left);
    let first = winners[0] || null;
    let second = winners[1] || null;

    // Immediately after a user taps a different asset, the old chart header can
    // remain in the DOM for a few render frames. During that transition the
    // user's touched market is authoritative and the stale header/tab may not
    // roll focus back to the previous asset.
    const interactionAge = Date.now() - Number(recentInteraction.at || 0);
    if (recentInteraction.asset && interactionAge >= 0 && interactionAge < 3500) {
      const touched = winners.find(row => sameAsset(row.asset, recentInteraction.asset));
      if (touched) {
        first = { ...touched, interaction: true, explicit: true, score: Math.max(3000, Number(touched.score || 0)) };
        second = winners.find(row => !sameAsset(row.asset, first.asset)) || null;
      } else {
        first = {
          asset: recentInteraction.asset,
          score: 3000,
          explicit: true,
          interaction: true,
          chartScoped: true,
          chartHits: 1,
          hits: 1,
          top: 0,
          left: 0
        };
        second = winners[0] || null;
      }
    }

    if (!first || first.chartHits < 1) return null;
    if (second && !sameAsset(first.asset, second.asset)) {
      const gap = Number(first.score || 0) - Number(second.score || 0);
      const minimumGap = first.interaction ? 70 : first.explicit ? 120 : 280;
      if (gap < minimumGap) return null;
    }
    return { ...first, chartFound: !!chart };
  }

  let candidate = '';
  let candidateSince = 0;
  let candidateSamples = 0;
  let lastPublished = '';
  let lastPublishedAt = 0;
  let scanTimer = null;
  let queuedForce = false;
  let scanning = false;

  function sendFocus(common) {
    globalThis.__ATS_FOCUSED_ASSET_VALUE__ = common.asset;
    globalThis.__ATS_FOCUSED_ASSET_META__ = common;
    try { chrome.runtime.sendMessage({ type: 'ATS_VISUAL_FOCUS_V2', ...common }, () => void chrome.runtime?.lastError); } catch {}
  }

  function noteInteractionHint(asset, at = Date.now()) {
    if (!asset) return;
    recentInteraction = { asset, at };

    // Do not wait for the React/canvas tree to finish repainting before telling
    // the session owner that the user selected another market.
    sendFocus({
      asset,
      score: 5000,
      samples: 1,
      stableFor: 0,
      reliable: true,
      visual: true,
      explicit: true,
      interactionHint: true,
      interactionAt: at,
      chartScoped: true,
      chartFound: true,
      frameHost: host,
      frameRole,
      at,
      source: 'user-selected-transition'
    });
    lastPublished = asset;
    lastPublishedAt = at;
    candidate = asset;
    candidateSince = at;
    candidateSamples = 1;
  }

  function publish(force = false) {
    if (scanning) {
      queuedForce ||= force;
      return;
    }
    scanning = true;
    try {
      const winner = scanWinner();
      if (!winner?.asset) return;
      const now = Date.now();
      if (sameAsset(candidate, winner.asset)) candidateSamples += 1;
      else { candidate = winner.asset; candidateSince = now; candidateSamples = 1; }
      const stableFor = Math.max(0, now - candidateSince);
      const reliable = winner.interaction || winner.explicit || (candidateSamples >= 2 && stableFor >= 220) || (candidateSamples >= 3);
      if (!reliable) return;
      if (!force && sameAsset(lastPublished, winner.asset) && now - lastPublishedAt < 650) return;
      lastPublished = winner.asset;
      lastPublishedAt = now;

      const common = {
        asset: winner.asset,
        score: Number(winner.score || 0),
        samples: candidateSamples,
        stableFor,
        reliable: true,
        visual: true,
        explicit: winner.explicit === true,
        interactionHint: winner.interaction === true,
        interactionAt: winner.interaction ? Number(recentInteraction.at || now) : null,
        chartScoped: true,
        chartFound: winner.chartFound === true,
        frameHost: host,
        frameRole,
        at: now,
        source: winner.source || (winner.interaction ? 'chart-frame-user-confirmed' : winner.explicit ? 'chart-frame-explicit' : 'chart-frame-scoped')
      };
      sendFocus(common);
    } finally {
      scanning = false;
      if (queuedForce) {
        queuedForce = false;
        schedulePublish(90, true);
      }
    }
  }

  function schedulePublish(delay = 110, force = false) {
    queuedForce ||= force;
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      const shouldForce = queuedForce;
      queuedForce = false;
      publish(shouldForce);
    }, delay);
  }

  const observer = new MutationObserver(() => schedulePublish(160, false));
  try { observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true }); } catch {}
  const noteInteraction = event => {
    const asset = touchedAsset(event);
    const now = Date.now();
    if (asset && (!sameAsset(recentInteraction.asset, asset) || now - Number(recentInteraction.at || 0) > 250)) {
      noteInteractionHint(asset, now);
    }
    invalidateElements();
    schedulePublish(70, true);
  };
  document.addEventListener('pointerup', noteInteraction, true);
  document.addEventListener('touchend', noteInteraction, true);
  document.addEventListener('click', noteInteraction, true);
  globalThis.__ATS_FORCE_FOCUSED_ASSET_SCAN__ = () => {
    invalidateElements();
    schedulePublish(0, true);
  };

  chrome.runtime?.onMessage?.addListener?.(message => {
    if (message?.type !== 'ATS_FORCE_MARKET_RESYNC') return false;
    invalidateElements();
    schedulePublish(0, true);
    try { globalThis.__ATS_FORCE_CHART_MARKET_SCAN__?.(); } catch {}
    try { globalThis.__ATS_FORCE_MARKET_CLOCK_SCAN__?.(); } catch {}
    try { globalThis.__ATS_FORCE_EMBEDDED_FEED_REPLAY__?.(); } catch {}
    return false;
  });
  setInterval(() => schedulePublish(0, false), 600);
  setTimeout(() => { invalidateElements(); publish(true); }, 250);
})();
