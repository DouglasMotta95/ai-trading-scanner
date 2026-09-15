(() => {
  if (globalThis.__ATS_FOCUSED_ASSET_TRACKER_V2__) return;
  globalThis.__ATS_FOCUSED_ASSET_TRACKER_V2__ = true;
  globalThis.__ATS_FOCUSED_ASSET_TRACKER__ = true;

  const clean = value => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  const host = String(location.hostname || '').toLowerCase().replace(/\.$/, '');
  const traderHost = value => value === 'casatraders.online' || value.endsWith('.casatraders.online') || value === 'ivcasatraders.online' || value.endsWith('.ivcasatraders.online');
  if (!traderHost(host)) return;

  const QUOTES = new Set(['USDT','USDC','USD','EUR','GBP','JPY','AUD','CAD','CHF','NZD','BRL','BTC','ETH']);
  const pairRe = /\b([A-Z0-9]{2,20})\s*[\/_-]\s*([A-Z0-9]{2,12})(?:\s*\(\s*OTC\s*\)|\s+OTC)?/gi;
  const compactFxRe = /\b([A-Z]{3})([A-Z]{3})(?:\s*\(\s*OTC\s*\)|[_-]?OTC)?\b/gi;

  function assetsIn(value = '') {
    const raw = clean(value).toUpperCase();
    if (!raw || raw.length > 160) return [];
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

  const canonicalAsset = value => assetsIn(value)[0] || '';
  // OTC and regular quotes are different live markets. Never collapse them when
  // deciding which chart owns the scanner session.
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

  function scanWinner() {
    const chart = chartRect();
    const rows = [];
    for (const el of deepElements()) {
      if (!visible(el)) continue;
      const text = clean(el.getAttribute?.('aria-label') || el.getAttribute?.('title') || el.innerText || el.textContent || '');
      if (!text || text.length > 72) continue;
      const assets = assetsIn(text);
      if (assets.length !== 1) continue;
      const rect = el.getBoundingClientRect();
      const selection = selectionEvidence(el);
      if (selection.rejected) continue;
      const context = contextOf(el);
      const chartScoped = nearChart(rect, chart) || /chart|tradingview|instrument|symbol|asset|header/.test(context);
      if (!chartScoped && !selection.explicit) continue;
      if (/watchlist|asset-list|instrument-list|listbox|search|history|portfolio|ranking|modal|drawer|dropdown|menu/.test(context) && !selection.explicit) continue;
      let score = selection.score;
      if (chartScoped) score += 520;
      if (chart && nearChart(rect, chart)) score += 480;
      if (/chart|tradingview|instrument|symbol|header/.test(context)) score += 180;
      if (text.length <= 32) score += 70;
      rows.push({ asset: assets[0], score, explicit: selection.explicit, chartScoped, top: rect.top, left: rect.left });
    }

    const grouped = new Map();
    for (const row of rows) {
      const id = identity(row.asset);
      const current = grouped.get(id) || { asset: row.asset, score: -Infinity, explicit: false, chartHits: 0, hits: 0, top: row.top, left: row.left };
      current.score = Math.max(current.score, row.score);
      current.explicit ||= row.explicit;
      current.chartHits += row.chartScoped ? 1 : 0;
      current.hits += 1;
      current.top = Math.min(current.top, row.top);
      current.left = Math.min(current.left, row.left);
      grouped.set(id, current);
    }

    const winners = [...grouped.values()].map(row => ({ ...row, score: row.score + Math.min(150, row.chartHits * 35) }));
    winners.sort((a, b) => Number(b.explicit) - Number(a.explicit) || b.chartHits - a.chartHits || b.score - a.score || a.top - b.top || a.left - b.left);
    const first = winners[0] || null;
    const second = winners[1] || null;
    if (!first) return null;
    if (!first.explicit && first.chartHits < 1) return null;
    if (second && !sameAsset(first.asset, second.asset)) {
      const gap = Number(first.score || 0) - Number(second.score || 0);
      if (gap < (first.explicit ? 120 : 280)) return null;
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
      const reliable = winner.explicit || (candidateSamples >= 2 && stableFor >= 220) || (candidateSamples >= 3);
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
        chartScoped: true,
        chartFound: winner.chartFound === true,
        frameHost: host,
        frameRole: 'trader-frame',
        at: now,
        source: winner.explicit ? 'chart-frame-explicit' : 'chart-frame-scoped'
      };
      globalThis.__ATS_FOCUSED_ASSET_VALUE__ = winner.asset;
      globalThis.__ATS_FOCUSED_ASSET_META__ = common;
      try { chrome.runtime.sendMessage({ type: 'ATS_VISUAL_FOCUS_V2', ...common }, () => void chrome.runtime?.lastError); } catch {}
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

  // Live charts mutate constantly. Coalesce those mutations instead of walking the
  // full DOM for every canvas/label change. Touch/click invalidates the short cache
  // immediately so a real user asset switch is still picked up without delay.
  const observer = new MutationObserver(() => schedulePublish(160, false));
  try { observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true }); } catch {}
  const forceScan = delay => { invalidateElements(); schedulePublish(delay, true); };
  document.addEventListener('pointerup', () => forceScan(70), true);
  document.addEventListener('touchend', () => forceScan(80), true);
  document.addEventListener('click', () => forceScan(80), true);
  setInterval(() => schedulePublish(0, false), 800);
  setTimeout(() => { invalidateElements(); publish(true); }, 250);
})();
