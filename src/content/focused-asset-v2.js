(() => {
  // Restartable reader: a newly loaded extension must replace the previous
  // in-page tracker even when the CasaTrade tab itself was not reloaded.
  try { globalThis.__ATS_FOCUSED_ASSET_TRACKER_V2_RUNTIME__?.teardown?.(); } catch {}
  globalThis.__ATS_FOCUSED_ASSET_TRACKER_V2__ = true;
  globalThis.__ATS_FOCUSED_ASSET_TRACKER__ = true;

  const clean = value => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  const host = String(location.hostname || '').toLowerCase().replace(/\.$/, '');
  const traderHost = value => value === 'casatraders.online' || value.endsWith('.casatraders.online') || value === 'ivcasatraders.online' || value.endsWith('.ivcasatraders.online');
  const casaHost = value => value === 'casatrade.com' || value.endsWith('.casatrade.com') || value === 'casatrade.io' || value.endsWith('.casatrade.io');
  if (!traderHost(host) && !casaHost(host)) return;
  const frameRole = traderHost(host) ? 'trader-frame' : 'casa-chart-frame';

  // OTC and regular quotes are different live markets.
  const QUOTES = new Set(['USD','EUR','GBP','JPY','AUD','CAD','CHF','NZD','BRL','HKD','SGD','NOK','SEK','DKK','PLN','CZK','HUF','TRY','MXN','ZAR','INR','CNY','CNH','KRW','THB','MYR','PHP','IDR','VND','TWD','ILS','AED','SAR','QAR','KWD','BHD','OMR','ARS','CLP','COP','PEN','UYU','BOB','PYG','BTC','ETH','USDT','USDC']);
  const pairRe = /\b([A-Z0-9]{2,20})\s*[\/_-]\s*([A-Z0-9]{2,12})(?:\s*\(\s*OTC\s*\)|\s+OTC)?/gi;
  const GENERIC_ASSET_TOKENS = new Set(['BLITZ','OPTION','OPTIONS','BINARY','BINARIA','BINARIO','DIGITAL','TURBO','CALL','PUT','BUY','SELL','COMPRA','VENDA','TRADE','TRADING','OPERATION','OPERACAO','OPCAO','INFO','FAVORITO','FAVORITES','ATIVO','ASSET','INSTRUMENT','INSTRUMENTO','MARKET','PRECO','PRICE','EXPIRACAO','EXPIRATION','VALOR','SALDO','PAYOUT','LUCRO','LIVE','CONECTAR','ENTRAR','VELA','GRAFICO','GRÁFICO']);
  const INSTRUMENT_WORDS = GENERIC_ASSET_TOKENS;
  const compactFxRe = /\b([A-Z]{3})([A-Z]{3})(?:\s*\(\s*OTC\s*\)|[_-]?OTC)?\b/gi;

  function assetsIn(value = '') {
    const raw = clean(value).toUpperCase();
    if (!raw || raw.length > 180) return [];
    const out = [];
    const seen = new Set();
    const add = (base, quote, otc) => {
      if (!QUOTES.has(quote) || GENERIC_ASSET_TOKENS.has(String(base).toUpperCase()) || GENERIC_ASSET_TOKENS.has(String(quote).toUpperCase())) return;
      const asset = `${base}/${quote}${otc ? ' (OTC)' : ''}`;
      if (!seen.has(asset)) { seen.add(asset); out.push(asset); }
    };
    for (const match of raw.matchAll(pairRe)) add(match[1], match[2], /OTC/i.test(match[0]));
    if (!out.length) for (const match of raw.matchAll(compactFxRe)) add(match[1], match[2], /OTC/i.test(match[0]));
    return out;
  }

  function namedInstrumentFromText(value = '') {
    let raw = clean(value).toUpperCase();
    if (!raw || raw.length > 64) return '';
    const otc = /\bOTC\b|\(\s*OTC\s*\)/i.test(raw);
    raw = raw.replace(/\(\s*OTC\s*\)/gi, ' ').replace(/\bOTC\b/gi, ' ').trim();
    raw = raw.replace(/(?:^|[\s|•·_-])(BLITZ|OPTION|OPTIONS|BINARY|BINARIA|BINARIO|DIGITAL|TURBO|CALL|PUT)\s*$/i, '').trim();
    raw = raw.replace(/^(?:ATIVO|ASSET|INSTRUMENTO|INSTRUMENT)\s*[:|-]\s*/i, '').trim();
    raw = raw.replace(/\s+/g, ' ').replace(/^[|•·\-_:]+|[|•·\-_:]+$/g, '').trim();
    if (!raw || raw.length < 2 || INSTRUMENT_WORDS.has(raw)) return '';
    if (/^(?:S|M|H)\d{1,4}$/.test(raw)) return '';
    if (!/[A-Z]/.test(raw) || /^[\d\s.,:+_/-]+$/.test(raw)) return '';
    if (/^(?:\d+\s*(?:SEG|SEC|MIN|MINUTO|MINUTOS|S|M|H)|\d{1,2}:\d{2})$/i.test(raw)) return '';
    const tokens = raw.split(/\s+/).filter(Boolean);
    if (tokens.length === 1 && INSTRUMENT_WORDS.has(tokens[0])) return '';
    return `${raw}${otc ? ' (OTC)' : ''}`;
  }

  function assetOptions(value = '', allowNamed = false) {
    const pairs = assetsIn(value);
    if (pairs.length) return pairs;
    if (!allowNamed) return [];
    const named = namedInstrumentFromText(value);
    return named ? [named] : [];
  }

  const canonicalAsset = value => assetOptions(value, true)[0] || '';
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

  // CasaTrade mobile/tablet can render the active instrument label in the shell
  // while the chart canvas lives in a child frame. In that layout chartRect()
  // is unavailable in the shell, so use the visual chart-header position as
  // strong evidence. This intentionally excludes the very top tab strip.
  function chartHeaderGeometry(rect, text = '') {
    if (!rect || !text || text.length > 48) return false;
    // Tablet CasaTrade places the real chart instrument header noticeably
    // higher than desktop. Keep the browser/tab strip excluded, but include the
    // ~125px+ chart-header band seen in video 15319.
    const minTop = Math.max(90, innerHeight * .08);
    const maxTop = Math.max(360, innerHeight * .58);
    return rect.top >= minTop
      && rect.top <= maxTop
      && rect.left >= 0
      && rect.left <= innerWidth * .82
      && rect.width <= innerWidth * .80;
  }

  const INTERACTION_TRANSITION_MS = 5000;
  let recentInteraction = { asset: '', at: 0 };
  let lastChartContextSignature = '';
  const interactionFresh = asset => sameAsset(recentInteraction.asset, asset) && Date.now() - Number(recentInteraction.at || 0) < INTERACTION_TRANSITION_MS;

  function elementAssetValues(el) {
    return [
      el?.getAttribute?.('data-symbol'),
      el?.getAttribute?.('data-asset'),
      el?.getAttribute?.('data-instrument'),
      el?.getAttribute?.('aria-label'),
      el?.getAttribute?.('title'),
      el?.innerText,
      el?.textContent
    ].map(clean).filter(value => value && value.length <= 120);
  }

  function elementAssetText(el) {
    return clean(elementAssetValues(el).join(' ')).slice(0, 180);
  }

  function touchedAsset(event) {
    const path = typeof event?.composedPath === 'function' ? event.composedPath() : [event?.target];
    for (const node of path.slice(0, 8)) {
      if (!(node instanceof Element) || !visible(node)) continue;
      const candidates = [];
      for (const rawText of elementAssetValues(node)) {
        for (const asset of assetOptions(rawText, true)) if (!candidates.includes(asset)) candidates.push(asset);
      }
      if (candidates.length === 1) return candidates[0];
    }
    return '';
  }

  function scanWinner() {
    const chart = chartRect();
    const contextSignatureNow = chart
      ? [chart.left, chart.top, chart.width, chart.height].map(value => Math.round(Number(value || 0) / 24)).join(':')
      : '';
    const contextChanged = !!lastChartContextSignature && !!contextSignatureNow && contextSignatureNow !== lastChartContextSignature;
    if (contextSignatureNow) lastChartContextSignature = contextSignatureNow;
    const rows = [];
    const rawCandidateRows = [];
    const rawCandidateAssets = new Set();
    for (const el of deepElements()) {
      if (!visible(el)) continue;
      const text = elementAssetText(el);
      if (!text || text.length > 180) continue;
      const candidates = [];
      for (const rawText of elementAssetValues(el)) {
        for (const asset of assetOptions(rawText, true)) if (!candidates.includes(asset)) candidates.push(asset);
      }
      if (candidates.length !== 1) continue;
      const asset = candidates[0];
      const rect = el.getBoundingClientRect();
      const selection = selectionEvidence(el);
      const context = contextOf(el);
      const geometricHeader = chartHeaderGeometry(rect, text);
      const directChart = !!chart && nearChart(rect, chart);
      const chartScoped = directChart || geometricHeader || /chart|tradingview|instrument|symbol|asset|header/.test(context);
      const listContext = /watchlist|asset-list|instrument-list|listbox|search|history|portfolio|ranking|modal|drawer|dropdown|menu/.test(context);
      const interaction = interactionFresh(asset);
      const rawScore = selection.score
        + (chartScoped ? 520 : 0)
        + (geometricHeader ? 900 : 0)
        + (directChart ? 480 : 0)
        + (/chart|tradingview|instrument|symbol|header/.test(context) ? 180 : 0)
        + (interaction ? 900 : 0)
        + (text.length <= 40 ? 70 : 0);
      const rejectionReasons = [];
      if (selection.rejected === true) rejectionReasons.push('selection-rejected');
      if (listContext && !selection.explicit && !interaction && !geometricHeader) {
        rejectionReasons.push('list-context-without-selection');
      }
      if (!chartScoped) rejectionReasons.push('not-chart-scoped');
      rawCandidateRows.push({
        asset,
        score: rawScore,
        blockedBySelection: selection.rejected === true,
        rejectionReasons,
        chartScoped,
        directChart,
        geometricHeader,
        explicit: selection.explicit === true,
        interaction: interaction === true
      });
      rawCandidateAssets.add(asset);
      if (selection.rejected) continue;
      // A visible dropdown/watchlist can contain dozens of symbols over the chart.
      // The chart-header geometry is allowed through because CasaTrade tablet
      // layouts often place the current asset inside a generic tabs/list shell.
      if (listContext && !selection.explicit && !interaction && !geometricHeader) continue;
      if (!chartScoped) continue;
      let score = selection.score;
      if (chartScoped) score += 520;
      if (geometricHeader) score += 900;
      if (chart && nearChart(rect, chart)) score += 480;
      if (/chart|tradingview|instrument|symbol|header/.test(context)) score += 180;
      if (interaction) score += 900;
      if (text.length <= 40) score += 70;
      rows.push({ asset, score, explicit: selection.explicit, interaction, chartScoped, directChart, geometricHeader, top: rect.top, left: rect.left });
    }

    rawCandidateRows.sort((a, b) => Number(b.score || 0) - Number(a.score || 0));
    const rawWinner = rawCandidateRows[0] || null;
    const rejectedTextCandidates = rawCandidateRows
      .filter(row => Array.isArray(row.rejectionReasons) && row.rejectionReasons.length)
      .slice(0, 16)
      .map(row => ({ asset: row.asset || '', reasons: [...row.rejectionReasons] }));
    lastScanDiagnostics = {
      rawWinnerAsset: rawWinner?.asset || '',
      rawWinnerScore: Number(rawWinner?.score || 0),
      rawCandidateCount: rawCandidateRows.length,
      uniqueTextCandidateCount: rawCandidateAssets.size,
      hasTextCandidate: rawCandidateRows.length > 0,
      rawCandidateAssets: [...rawCandidateAssets].slice(0, 16),
      rejectedTextCandidates,
      winner: { asset: '', blocked: true, blockedReason: 'scan-pending' },
      chartFound: !!chart,
      contextChanged,
      at: Date.now()
    };

    const grouped = new Map();
    for (const row of rows) {
      const id = identity(row.asset);
      const current = grouped.get(id) || { asset: row.asset, score: -Infinity, explicit: false, interaction: false, chartHits: 0, directChartHits: 0, geometricHits: 0, geometricHeader: false, hits: 0, top: row.top, maxTop: row.top, left: row.left, bands: new Set() };
      current.score = Math.max(current.score, row.score);
      current.explicit ||= row.explicit;
      current.interaction ||= row.interaction;
      current.geometricHeader ||= row.geometricHeader;
      current.chartHits += row.chartScoped ? 1 : 0;
      current.directChartHits += row.directChart ? 1 : 0;
      current.geometricHits += row.geometricHeader ? 1 : 0;
      current.hits += 1;
      current.top = Math.min(current.top, row.top);
      current.maxTop = Math.max(current.maxTop, row.top);
      current.left = Math.min(current.left, row.left);
      current.bands.add(Math.round(Number(row.top || 0) / 28));
      grouped.set(id, current);
    }

    const winners = [...grouped.values()].map(row => ({
      ...row,
      bandCount: row.bands?.size || 0,
      repeatedVisual: (row.bands?.size || 0) >= 2 && Number(row.maxTop || 0) - Number(row.top || 0) >= 24,
      score: row.score + Math.min(180, row.chartHits * 35) + Math.min(140, Math.max(0, (row.bands?.size || 0) - 1) * 70)
    }));
    // A current explicit DOM selection outranks an older click hint. This
    // prevents the previous asset from winning for several seconds after a tab switch.
    winners.sort((a, b) => Number(b.interaction) - Number(a.interaction)
      || Number(b.explicit) - Number(a.explicit)
      || Number(b.repeatedVisual) - Number(a.repeatedVisual)
      || Number(b.bandCount || 0) - Number(a.bandCount || 0)
      || b.directChartHits - a.directChartHits
      || b.chartHits - a.chartHits || b.score - a.score || b.maxTop - a.maxTop || a.left - b.left);
    const first = winners[0] || null;
    const second = winners[1] || null;
    if (!first) {
      return {
        asset: '', blocked: true, blockedReason: 'no-chart-scoped-candidate',
        chartFound: !!chart, chartHits: 0, directChartHits: 0, geometricHits: 0,
        ambiguityCount: 0, runnerUpAsset: null, runnerUpGap: null,
        explicit: false, interaction: false, repeatedVisual: false, bandCount: 0,
        contextChanged
      };
    }
    if (first.chartHits < 1) {
      return {
        ...first, blocked: true, blockedReason: 'chartScoped=false',
        chartFound: !!chart, ambiguityCount: 0, runnerUpAsset: null, runnerUpGap: null
      };
    }

    let runnerUpGap = null;
    const ambiguousAssets = winners.filter(row => !sameAsset(row.asset, first.asset));
    const rival = second && !sameAsset(first.asset, second.asset) ? second : null;
    const repeatedWins = first.repeatedVisual === true
      && (!rival || Number(first.bandCount || 0) > Number(rival.bandCount || 0));
    const directChartWins = Number(first.directChartHits || 0) > 0
      && Number(first.directChartHits || 0) > Number(rival?.directChartHits || 0);
    const geometricChartWins = Number(first.geometricHits || 0) > 0
      && Number(first.geometricHits || 0) > Number(rival?.geometricHits || 0);
    const chartEvidenceWins = directChartWins || geometricChartWins;

    if (rival) {
      runnerUpGap = Number(first.score || 0) - Number(rival.score || 0);
      const minimumGap = first.interaction ? 70 : first.explicit ? 120 : (repeatedWins || chartEvidenceWins || first.geometricHeader || Number(first.directChartHits || 0) > 0) ? 40 : 280;
      if (runnerUpGap < minimumGap && !repeatedWins && !chartEvidenceWins) {
        return {
          ...first,
          blocked: true,
          blockedReason: 'ambiguityCount>0-and-runnerUpGap-insufficient',
          chartFound: !!chart,
          ambiguityCount: ambiguousAssets.length,
          runnerUpAsset: rival.asset,
          runnerUpGap,
          repeatedWins,
          chartEvidenceWins,
          contextChanged
        };
      }

      // Internal CasaTrade tabs/watchlists may expose several symbols even with
      // only one browser tab open. Do not treat those labels as equal market
      // authorities when one symbol is uniquely bound to the real chart/header.
      if (!first.interaction && !first.explicit && !repeatedWins && !chartEvidenceWins
        && !first.geometricHeader && Number(first.directChartHits || 0) <= 0) {
        return {
          ...first,
          blocked: true,
          blockedReason: 'ambiguityCount>0-without-chart-authority',
          chartFound: !!chart,
          ambiguityCount: ambiguousAssets.length,
          runnerUpAsset: rival.asset,
          runnerUpGap,
          repeatedWins,
          chartEvidenceWins
        };
      }
    }

    return {
      ...first,
      blocked: false,
      chartFound: !!chart,
      ambiguityCount: ambiguousAssets.length,
      runnerUpAsset: rival?.asset || null,
      runnerUpGap,
      repeatedWins,
      chartEvidenceWins,
      contextChanged
    };
  }

  let candidate = '';
  let candidateSince = 0;
  let candidateSamples = 0;
  let lastPublished = '';
  let lastPublishedAt = 0;
  let scanTimer = null;
  let queuedForce = false;
  let scanning = false;

  let lastReliableAsset = '';
  let lastScanDiagnostics = {
    rawWinnerAsset: '',
    rawWinnerScore: 0,
    rawCandidateCount: 0,
    uniqueTextCandidateCount: 0,
    hasTextCandidate: false,
    rawCandidateAssets: [],
    winner: { asset: '', blocked: true, blockedReason: 'not-scanned' },
    at: 0
  };
  function sendFocus(common) {
    if (common?.asset && common?.reliable === true) {
      lastReliableAsset = common.asset;
      globalThis.__ATS_FOCUSED_ASSET_VALUE__ = common.asset;
      globalThis.__ATS_FOCUSED_ASSET_META__ = common;
    } else {
      globalThis.__ATS_FOCUSED_ASSET_DIAGNOSTIC__ = common;
    }
    try { chrome.runtime.sendMessage({ type: 'ATS_VISUAL_FOCUS_V2', ...common }, () => void chrome.runtime?.lastError); } catch {}
  }

  window.addEventListener('message', event => {
    const data = event.data;
    if (!data || data.source !== 'ATS_NETWORK_ASSET_FALLBACK_REQUEST' || !data.requestId) return;
    const meta = globalThis.__ATS_FOCUSED_ASSET_META__ || null;
    const rawWinnerAsset = String(lastScanDiagnostics?.rawWinnerAsset || '').trim();
    const asset = rawWinnerAsset || String(lastReliableAsset || globalThis.__ATS_FOCUSED_ASSET_VALUE__ || '').trim();
    const authoritative = meta?.reliable === true
      && meta?.visualAuthority !== false
      && meta?.chartScoped === true
      && meta?.trustedChartFrame === true
      && asset === String(lastReliableAsset || globalThis.__ATS_FOCUSED_ASSET_VALUE__ || '').trim();
    try {
      window.postMessage({
        source: 'ATS_FOCUSED_ASSET_FALLBACK_RESPONSE',
        requestId: data.requestId,
        payload: {
          asset,
          confidenceLevel: authoritative ? 'high' : 'low',
          lowConfidence: authoritative !== true,
          reliable: authoritative,
          source: authoritative ? 'focused-asset-v2' : 'focused-asset-v2-raw-fallback',
          frameHost: host,
          frameRole,
          rawWinnerAsset,
          winner: { ...(lastScanDiagnostics?.winner || {}) },
          rawCandidateCount: Number(lastScanDiagnostics?.rawCandidateCount || 0),
          uniqueTextCandidateCount: Number(lastScanDiagnostics?.uniqueTextCandidateCount || 0),
          hasTextCandidate: lastScanDiagnostics?.hasTextCandidate === true,
          rawCandidateAssets: Array.isArray(lastScanDiagnostics?.rawCandidateAssets) ? lastScanDiagnostics.rawCandidateAssets.slice(0, 16) : [],
          at: Date.now()
        }
      }, '*');
    } catch {}
  });

  window.addEventListener('message', event => {
    const data = event.data;
    if (!data || data.source !== 'ATS_EXPIRATION_DIAGNOSTIC_REQUEST' || !data.requestId) return;
    const diagnostics = lastScanDiagnostics || {};
    const rawWinnerAsset = String(diagnostics.rawWinnerAsset || '').trim();
    const winner = {
      ...(diagnostics.winner || {}),
      asset: String(diagnostics.winner?.asset || rawWinnerAsset || '').trim(),
      blocked: diagnostics.winner?.blocked === true,
      blockedReason: String(diagnostics.winner?.blockedReason || '')
    };
    const hasTextCandidate = diagnostics.hasTextCandidate === true;
    try {
      window.postMessage({
        source: 'ATS_FOCUSED_ASSET_DIAGNOSTIC_SNAPSHOT',
        requestId: data.requestId,
        payload: {
          frameHost: host, frameRole, rawWinnerAsset, winner,
          rawCandidateCount: Number(diagnostics.rawCandidateCount || 0),
          uniqueTextCandidateCount: Number(diagnostics.uniqueTextCandidateCount || 0),
          hasTextCandidate,
          rawCandidateAssets: Array.isArray(diagnostics.rawCandidateAssets) ? diagnostics.rawCandidateAssets.slice(0, 16) : [],
          rejectedTextCandidates: Array.isArray(diagnostics.rejectedTextCandidates) ? diagnostics.rejectedTextCandidates.slice(0, 16) : [],
          textFoundButRejected: Array.isArray(diagnostics.rejectedTextCandidates) && diagnostics.rejectedTextCandidates.length > 0,
          textSearchResult: hasTextCandidate ? (winner.blocked ? 'text-found-but-rejected' : 'text-found') : 'no-corresponding-text-found',
          rejectionReason: winner.blocked ? winner.blockedReason : '',
          at: Number(diagnostics.at || 0) || Date.now()
        }
      }, '*');
    } catch {}
  });
  function noteInteractionHint(asset, at = Date.now()) {
    if (!asset) return;
    recentInteraction = { asset, at };
  }

  function publish(force = false) {
    if (scanning) {
      queuedForce ||= force;
      return;
    }
    scanning = true;
    try {
      const winner = scanWinner();
      if (!winner) return;
      const now = Date.now();
      lastScanDiagnostics = {
        ...lastScanDiagnostics,
        winner: {
          asset: winner.asset || '',
          blocked: winner.blocked === true,
          blockedReason: winner.blockedReason || ''
        },
        at: now
      };

      if (winner.contextChanged === true) {
        lastReliableAsset = '';
        try { delete globalThis.__ATS_FOCUSED_ASSET_VALUE__; } catch {}
        try { delete globalThis.__ATS_FOCUSED_ASSET_META__; } catch {}
      }

      if (winner.blocked === true) {
        sendFocus({
          asset: winner.asset || '',
          score: Number(winner.score || 0),
          samples: candidateSamples,
          stableFor: 0,
          reliable: false,
          reliableReason: winner.blockedReason || 'focus-candidate-blocked',
          visual: true,
          explicit: winner.explicit === true,
          interactionHint: winner.interaction === true,
          chartScoped: Number(winner.chartHits || 0) > 0,
          chartFound: winner.chartFound === true,
          directChart: Number(winner.directChartHits || 0) > 0,
          ambiguityCount: Number(winner.ambiguityCount || 0),
          runnerUpAsset: winner.runnerUpAsset || null,
          runnerUpGap: winner.runnerUpGap == null ? null : Number(winner.runnerUpGap),
          repeatedVisual: winner.repeatedVisual === true,
          bandCount: Number(winner.bandCount || 0),
          chartEvidenceWins: winner.chartEvidenceWins === true,
          visualAuthority: false,
          frameHost: host,
          frameRole,
          at: now,
          source: 'chart-frame-focus-diagnostic',
          contextChanged: winner.contextChanged === true
        });
        schedulePublish(450, false);
        return;
      }

      if (!winner.asset) return;
      if (sameAsset(candidate, winner.asset)) candidateSamples += 1;
      else { candidate = winner.asset; candidateSince = now; candidateSamples = 1; }
      const stableFor = Math.max(0, now - candidateSince);
      const reliable = winner.interaction || winner.explicit || (candidateSamples >= 2 && stableFor >= 220) || (candidateSamples >= 3);
      if (!reliable) {
        sendFocus({
          asset: winner.asset,
          score: Number(winner.score || 0),
          samples: candidateSamples,
          stableFor,
          reliable: false,
          reliableReason: 'stability-pending',
          visual: true,
          explicit: winner.explicit === true,
          interactionHint: winner.interaction === true,
          chartScoped: true,
          chartFound: winner.chartFound === true,
          directChart: Number(winner.directChartHits || 0) > 0,
          ambiguityCount: Number(winner.ambiguityCount || 0),
          runnerUpAsset: winner.runnerUpAsset || null,
          runnerUpGap: winner.runnerUpGap == null ? null : Number(winner.runnerUpGap),
          repeatedVisual: winner.repeatedVisual === true,
          bandCount: Number(winner.bandCount || 0),
          chartEvidenceWins: winner.chartEvidenceWins === true,
          visualAuthority: Number(winner.ambiguityCount || 0) === 0
            || winner.interaction === true
            || winner.explicit === true
            || winner.repeatedVisual === true
            || winner.chartEvidenceWins === true,
          frameHost: host,
          frameRole,
          at: now,
          source: 'chart-frame-focus-diagnostic',
          contextChanged: winner.contextChanged === true
        });
        // Do not wait for the next passive interval to prove the boot/switch
        // candidate. Re-scan quickly so the visible CasaTrade asset becomes
        // authoritative well inside the 1.5s synchronization budget.
        schedulePublish(260, false);
        return;
      }
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
        directChart: Number(winner.directChartHits || 0) > 0,
        ambiguityCount: Number(winner.ambiguityCount || 0),
        runnerUpAsset: winner.runnerUpAsset || null,
        runnerUpGap: winner.runnerUpGap == null ? null : Number(winner.runnerUpGap),
        repeatedVisual: winner.repeatedVisual === true,
        bandCount: Number(winner.bandCount || 0),
        chartEvidenceWins: winner.chartEvidenceWins === true,
        visualAuthority: Number(winner.ambiguityCount || 0) === 0
          || winner.interaction === true
          || winner.explicit === true
          || winner.repeatedVisual === true
          || winner.chartEvidenceWins === true,
        frameHost: host,
        frameRole,
        at: now,
        source: winner.interaction
          ? 'chart-frame-user-confirmed'
          : winner.explicit
            ? 'chart-frame-explicit'
            : winner.repeatedVisual
              ? 'chart-frame-repeated-active'
              : winner.chartEvidenceWins
                ? 'chart-frame-direct-active'
                : 'chart-frame-scoped'
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

  const observer = new MutationObserver(() => schedulePublish(120, false));
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
  const intervalId = setInterval(() => schedulePublish(0, false), 450);
  const bootTimer = setTimeout(() => { invalidateElements(); publish(true); }, 80);

  globalThis.__ATS_FORCE_FOCUS_SCAN__ = () => {
    invalidateElements();
    schedulePublish(0, true);
  };
  globalThis.__ATS_FOCUSED_ASSET_TRACKER_V2_RUNTIME__ = {
    version: 'focused-asset-v2-restartable',
    teardown() {
      try { observer.disconnect(); } catch {}
      try { document.removeEventListener('pointerup', noteInteraction, true); } catch {}
      try { document.removeEventListener('touchend', noteInteraction, true); } catch {}
      try { document.removeEventListener('click', noteInteraction, true); } catch {}
      try { clearInterval(intervalId); } catch {}
      try { clearTimeout(bootTimer); } catch {}
      if (scanTimer) { try { clearTimeout(scanTimer); } catch {} }
    }
  };
})();
