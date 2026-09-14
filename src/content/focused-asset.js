(() => {
  if (window.__ATS_FOCUSED_ASSET_TRACKER__) return;
  window.__ATS_FOCUSED_ASSET_TRACKER__ = true;

  const QUOTES = new Set(['USDT','USDC','USD','EUR','GBP','JPY','AUD','CAD','CHF','NZD','BRL','BTC','ETH']);
  const RELIABLE_SCORE = 120;
  const CONSISTENT_SAMPLES = 2;
  const CONSISTENT_MS = 300;
  const USER_SELECTION_MS = 3500;
  const clean = value => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();

  function canonicalAsset(value = '') {
    let raw = clean(value).toUpperCase();
    if (!raw || raw.length > 90) return '';
    const otc = /(?:\(|\b|[_-])OTC(?:\)|\b)?/.test(raw);
    raw = raw.replace(/^FRX[:_-]?/, '').replace(/^OTC[:_-]?/, '');
    let s = raw
      .replace(/\(\s*OTC\s*\)|\bOTC\b/g, '')
      .replace(/\s+/g, '')
      .replace(/_/g, '/')
      .replace(/-/g, '/')
      .replace(/:+/g, '/')
      .replace(/^\/+|\/+$/g, '')
      .replace(/\/{2,}/g, '/');

    if (!s.includes('/')) {
      const quote = [...QUOTES].find(q => s.length > q.length && s.endsWith(q));
      if (quote) s = `${s.slice(0, -quote.length)}/${quote}`;
      else if (/^[A-Z]{6}$/.test(s)) s = `${s.slice(0, 3)}/${s.slice(3)}`;
    }

    const match = s.match(/^([A-Z0-9]{2,16})\/([A-Z0-9]{2,12})$/);
    if (!match || !QUOTES.has(match[2])) return '';
    return `${match[1]}/${match[2]}${otc ? ' (OTC)' : ''}`;
  }

  const assetIdentity = value => canonicalAsset(value).replace(/\s*\(OTC\)\s*$/, '');
  const sameAsset = (a, b) => {
    const left = assetIdentity(a);
    const right = assetIdentity(b);
    return !!left && !!right && left === right;
  };

  const pairRe = /\b([A-Z0-9]{2,16})\s*[\/_-]\s*(USDT|USDC|USD|EUR|GBP|JPY|AUD|CAD|CHF|NZD|BRL|BTC|ETH)(?:\s*\(\s*OTC\s*\)|\s+OTC)?/i;

  function visible(el) {
    if (!el || !(el instanceof Element)) return false;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0;
  }

  const classHasState = value => /(?:^|[\s_-])(active|selected|current|checked)(?:$|[\s_-])/i.test(String(value || ''));

  function selectionEvidence(el) {
    let score = 0;
    let explicit = false;
    let rejected = false;
    let node = el;
    for (let depth = 0; node && depth < 3; depth++, node = node.parentElement) {
      const weight = depth === 0 ? 1 : depth === 1 ? 0.62 : 0.32;
      const ariaSelected = String(node.getAttribute?.('aria-selected') || '').toLowerCase();
      const ariaCurrent = String(node.getAttribute?.('aria-current') || '').toLowerCase();
      const dataState = String(node.getAttribute?.('data-state') || '').toLowerCase();
      const dataActive = String(node.getAttribute?.('data-active') || '').toLowerCase();
      const role = String(node.getAttribute?.('role') || '').toLowerCase();
      const className = String(node.className || '');

      if (ariaSelected === 'true') { score += 520 * weight; explicit = true; }
      if (ariaSelected === 'false') { score -= 420 * weight; rejected = depth === 0 || rejected; }
      if (ariaCurrent && ariaCurrent !== 'false') { score += 360 * weight; explicit = true; }
      if (dataActive === 'true' || dataActive === '1') { score += 360 * weight; explicit = true; }
      if (/^(active|selected|current|checked)$/.test(dataState)) { score += 330 * weight; explicit = true; }
      if (/^(inactive|closed|disabled)$/.test(dataState)) { score -= 260 * weight; rejected = depth === 0 || rejected; }
      if (classHasState(className)) { score += 180 * weight; if (depth <= 1) explicit = true; }
      if (role === 'tab') score += 55 * weight;
    }
    return { score, explicit, rejected };
  }

  function contextFlags(el) {
    const bits = [];
    let node = el;
    for (let i = 0; node && i < 6; i++, node = node.parentElement) {
      bits.push(
        String(node.id || ''),
        String(node.className || ''),
        node.getAttribute?.('role') || '',
        node.getAttribute?.('data-testid') || '',
        node.getAttribute?.('aria-label') || ''
      );
    }
    return bits.join(' ').toLowerCase();
  }

  function assetFromElement(start) {
    let node = start instanceof Element ? start : null;
    for (let i = 0; node && i < 5; i++, node = node.parentElement) {
      const text = clean(node.getAttribute?.('aria-label') || node.getAttribute?.('title') || node.innerText || node.textContent || '');
      if (!text || text.length > 160) continue;
      const match = text.match(pairRe);
      const asset = match ? canonicalAsset(match[0]) : '';
      if (asset) return { asset, element: node, text };
    }
    return null;
  }

  function focusedAssetCandidate() {
    const rows = [];
    let nodes = [];
    try {
      nodes = document.querySelectorAll('[aria-selected],[aria-current],[data-state],[data-active],[role="tab"],button,span,strong,b,div,p');
    } catch {}

    for (const el of nodes) {
      if (!visible(el)) continue;
      const text = clean(el.getAttribute?.('aria-label') || el.innerText || el.textContent || '');
      if (!text || text.length > 120) continue;
      const match = text.match(pairRe);
      if (!match) continue;
      const asset = canonicalAsset(match[0]);
      if (!asset) continue;

      const rect = el.getBoundingClientRect();
      const selection = selectionEvidence(el);
      const context = contextFlags(el);
      let score = selection.score;

      if (text.length <= 34) score += 35;
      if (rect.top >= 0 && rect.top <= innerHeight * 0.42) score += 35;
      if (rect.left >= 0 && rect.left <= innerWidth * 0.82) score += 20;
      if (/chart|trade|trading|instrument|asset|symbol|tab|header|market/.test(context)) score += 95;
      if (/watchlist|watch-list|asset-list|instrument-list|listbox|search|history|histor|portfolio|leader|ranking|modal|drawer|dropdown|menu/.test(context)) {
        score -= selection.explicit ? 95 : 260;
      }
      if (selection.rejected) score -= 180;

      rows.push({ asset, score, top: rect.top, left: rect.left, explicit: selection.explicit, source: 'chart-header' });
    }

    rows.sort((a, b) => Number(b.explicit) - Number(a.explicit) || b.score - a.score || a.top - b.top || a.left - b.left);
    return rows[0] || null;
  }

  let candidateAsset = '';
  let candidateSince = 0;
  let candidateSamples = 0;
  let lastSentAsset = '';
  let lastSentAt = 0;
  let userSelection = null;

  function chooseCandidate() {
    const scanned = focusedAssetCandidate();
    const now = Date.now();
    if (userSelection && now - userSelection.at <= USER_SELECTION_MS) {
      if (!scanned || sameAsset(scanned.asset, userSelection.asset) || !scanned.explicit) {
        return { asset: userSelection.asset, score: Math.max(900, Number(scanned?.score || 0)), explicit: true, source: 'user-selection' };
      }
    }
    return scanned;
  }

  function publish(force = false) {
    const candidate = chooseCandidate();
    if (!candidate?.asset) return;

    const now = Date.now();
    if (sameAsset(candidateAsset, candidate.asset)) {
      candidateSamples += 1;
    } else {
      candidateAsset = candidate.asset;
      candidateSince = now;
      candidateSamples = 1;
    }

    const stableFor = Math.max(0, now - candidateSince);
    const reliable = candidate.source === 'user-selection'
      || candidate.explicit === true
      || Number(candidate.score || 0) >= RELIABLE_SCORE
      || (candidateSamples >= CONSISTENT_SAMPLES && stableFor >= CONSISTENT_MS);
    const previousGlobal = canonicalAsset(globalThis.__ATS_FOCUSED_ASSET_VALUE__ || '');

    globalThis.__ATS_FOCUSED_ASSET_META__ = {
      asset: candidate.asset,
      score: Number(candidate.score || 0),
      samples: candidateSamples,
      stableFor,
      reliable,
      visual: true,
      at: now,
      source: candidate.source || 'chart-header'
    };

    if (reliable || sameAsset(previousGlobal, candidate.asset)) {
      globalThis.__ATS_FOCUSED_ASSET_VALUE__ = candidate.asset;
    }

    if (!force && sameAsset(candidate.asset, lastSentAsset) && now - lastSentAt < 700) return;
    lastSentAsset = candidate.asset;
    lastSentAt = now;
    chrome.runtime.sendMessage({
      type: 'ATS_FOCUSED_ASSET',
      asset: candidate.asset,
      score: Number(candidate.score || 0),
      samples: candidateSamples,
      stableFor,
      reliable,
      visual: true,
      source: candidate.source || 'chart-header',
      at: now
    }).catch(() => {});
  }

  function rememberUserSelection(event) {
    const target = event?.target instanceof Element ? event.target : null;
    if (!target) return;
    const actionLabel = clean(target.getAttribute?.('aria-label') || target.getAttribute?.('title') || '');
    if (/fechar|close|remover|remove|delete|excluir/i.test(actionLabel)) return;
    const hit = assetFromElement(target);
    if (!hit?.asset) return;
    userSelection = { asset: hit.asset, at: Date.now() };
    candidateAsset = hit.asset;
    candidateSince = Date.now();
    candidateSamples = Math.max(candidateSamples, 2);
    publish(true);
  }

  document.addEventListener('pointerup', rememberUserSelection, true);
  document.addEventListener('click', rememberUserSelection, true);
  const observer = new MutationObserver(() => publish(false));
  try { observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true }); } catch {}
  setInterval(() => publish(false), 300);
  publish(true);
})();
