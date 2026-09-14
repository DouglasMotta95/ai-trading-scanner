(() => {
  if (globalThis.__ATS_FOCUSED_ASSET_TRACKER_V2__) return;
  globalThis.__ATS_FOCUSED_ASSET_TRACKER_V2__ = true;
  globalThis.__ATS_FOCUSED_ASSET_TRACKER__ = true;

  const clean = value => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  const host = String(location.hostname || '').toLowerCase().replace(/\.$/, '');
  const casaHost = value => value === 'casatrade.com' || value.endsWith('.casatrade.com') || value === 'casatrade.io' || value.endsWith('.casatrade.io');
  const traderHost = value => value === 'casatraders.online' || value.endsWith('.casatraders.online') || value === 'ivcasatraders.online' || value.endsWith('.ivcasatraders.online');
  if (!casaHost(host) && !traderHost(host)) return;

  const pairRe = /\b([A-Z0-9]{2,20})\s*[\/_-]\s*([A-Z0-9]{2,12})(?:\s*\(\s*OTC\s*\)|\s+OTC)?/i;
  const compactFxRe = /\b([A-Z]{3})([A-Z]{3})(?:\s*\(\s*OTC\s*\)|[_-]?OTC)?\b/i;

  function canonicalAsset(value = '') {
    const raw = clean(value).toUpperCase();
    if (!raw || raw.length > 100) return '';
    const otc = /(?:\(|\b|[_-])OTC(?:\)|\b)?/i.test(raw);
    const direct = raw.match(pairRe);
    if (direct) return `${direct[1]}/${direct[2]}${otc ? ' (OTC)' : ''}`;
    const compact = raw.match(compactFxRe);
    if (compact) return `${compact[1]}/${compact[2]}${otc ? ' (OTC)' : ''}`;
    return '';
  }

  const identity = value => canonicalAsset(value).replace(/\s*\(OTC\)\s*$/i, '');
  const sameAsset = (a, b) => !!identity(a) && identity(a) === identity(b);
  const visible = el => {
    if (!el || !(el instanceof Element)) return false;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0;
  };

  function deepElements(limit = 9000) {
    const out = [];
    const roots = [document];
    const seen = new Set();
    while (roots.length && out.length < limit) {
      const root = roots.shift();
      if (!root || seen.has(root)) continue;
      seen.add(root);
      let nodes = [];
      try { nodes = [...root.querySelectorAll('*')]; } catch {}
      for (const node of nodes) {
        out.push(node);
        if (out.length >= limit) break;
        if (node.shadowRoot) roots.push(node.shadowRoot);
      }
    }
    return out;
  }

  function selectionEvidence(el) {
    let score = 0;
    let explicit = false;
    let rejected = false;
    let node = el;
    for (let depth = 0; node && depth < 4; depth++, node = node.parentElement) {
      const weight = depth === 0 ? 1 : depth === 1 ? .68 : depth === 2 ? .42 : .24;
      const ariaSelected = String(node.getAttribute?.('aria-selected') || '').toLowerCase();
      const ariaCurrent = String(node.getAttribute?.('aria-current') || '').toLowerCase();
      const dataState = String(node.getAttribute?.('data-state') || '').toLowerCase();
      const dataActive = String(node.getAttribute?.('data-active') || '').toLowerCase();
      const cls = String(node.className || '');
      if (ariaSelected === 'true') { score += 650 * weight; explicit = true; }
      if (ariaSelected === 'false' && depth === 0) { score -= 480; rejected = true; }
      if (ariaCurrent && ariaCurrent !== 'false') { score += 460 * weight; explicit = true; }
      if (dataActive === 'true' || dataActive === '1') { score += 440 * weight; explicit = true; }
      if (/^(active|selected|current|checked)$/.test(dataState)) { score += 430 * weight; explicit = true; }
      if (/^(inactive|disabled|closed)$/.test(dataState) && depth === 0) { score -= 360; rejected = true; }
      if (/(?:^|[\s_-])(active|selected|current|checked)(?:$|[\s_-])/i.test(cls)) {
        score += 230 * weight;
        if (depth <= 1) explicit = true;
      }
    }
    return { score, explicit, rejected };
  }

  function contextOf(el) {
    const parts = [];
    let node = el;
    for (let i = 0; node && i < 5; i++, node = node.parentElement) {
      parts.push(String(node.id || ''), String(node.className || ''), node.getAttribute?.('role') || '', node.getAttribute?.('data-testid') || '', node.getAttribute?.('aria-label') || '');
    }
    return parts.join(' ').toLowerCase();
  }

  function assetFromPath(event) {
    const path = typeof event?.composedPath === 'function' ? event.composedPath() : [event?.target];
    for (const node of path) {
      if (!(node instanceof Element)) continue;
      const action = clean(`${node.getAttribute?.('aria-label') || ''} ${node.getAttribute?.('title') || ''}`);
      if (/fechar|close|remover|remove|delete|excluir/i.test(action)) return '';
      const text = clean(`${node.getAttribute?.('aria-label') || ''} ${node.getAttribute?.('title') || ''} ${node.innerText || node.textContent || ''}`);
      const asset = canonicalAsset(text);
      if (asset) return asset;
    }
    return '';
  }

  function scanWinner() {
    const rows = [];
    for (const el of deepElements()) {
      if (!visible(el)) continue;
      const text = clean(el.getAttribute?.('aria-label') || el.getAttribute?.('title') || el.innerText || el.textContent || '');
      if (!text || text.length > 120) continue;
      const asset = canonicalAsset(text);
      if (!asset) continue;
      const rect = el.getBoundingClientRect();
      const selection = selectionEvidence(el);
      const context = contextOf(el);
      const role = String(el.getAttribute?.('role') || '').toLowerCase();
      let score = selection.score;
      if (text.length <= 38) score += 55;
      if (rect.top >= 0 && rect.top <= innerHeight * .46) score += 55;
      if (rect.left >= 0 && rect.left <= innerWidth * .86) score += 25;
      if (/chart|trade|trading|instrument|asset|symbol|tab|header|market/.test(context)) score += 125;
      if (role === 'tab') score += 65;
      if (/watchlist|watch-list|asset-list|instrument-list|listbox|search|history|histor|portfolio|leader|ranking|modal|drawer|dropdown|menu/.test(context)) score -= selection.explicit ? 80 : 330;
      if (selection.rejected) score -= 260;
      rows.push({ asset, score, explicit: selection.explicit, top: rect.top, left: rect.left });
    }
    rows.sort((a, b) => Number(b.explicit) - Number(a.explicit) || b.score - a.score || a.top - b.top || a.left - b.left);
    return rows[0] || null;
  }

  let lastInteractionAt = 0;
  let lastPublished = '';
  let lastPublishedAt = 0;
  let candidate = '';
  let candidateSince = 0;
  let candidateSamples = 0;

  function send(asset, { source, explicit, score, force = false } = {}) {
    if (!asset) return;
    const now = Date.now();
    if (sameAsset(candidate, asset)) candidateSamples += 1;
    else { candidate = asset; candidateSince = now; candidateSamples = 1; }
    const stableFor = Math.max(0, now - candidateSince);
    const reliable = explicit === true || score >= 180 || candidateSamples >= 2;
    if (!reliable) return;

    globalThis.__ATS_FOCUSED_ASSET_VALUE__ = asset;
    globalThis.__ATS_FOCUSED_ASSET_META__ = { asset, score, samples: candidateSamples, stableFor, reliable: true, visual: true, source, explicit: explicit === true, at: now };
    if (!force && sameAsset(lastPublished, asset) && now - lastPublishedAt < 650) return;
    lastPublished = asset;
    lastPublishedAt = now;

    const common = { asset, score, samples: candidateSamples, stableFor, reliable: true, visual: true, explicit: explicit === true, at: now };
    try { chrome.runtime.sendMessage({ type: 'ATS_VISUAL_FOCUS_V2', ...common, source }, () => void chrome.runtime?.lastError); } catch {}
    const legacySource = source === 'interaction' || source === 'interaction-scan' ? 'user-selection' : 'chart-header';
    try { chrome.runtime.sendMessage({ type: 'ATS_FOCUSED_ASSET', ...common, source: legacySource, explicit: explicit === true || legacySource === 'user-selection' }, () => void chrome.runtime?.lastError); } catch {}
  }

  function publishScan(force = false) {
    const winner = scanWinner();
    if (!winner?.asset) return;
    const interactionFresh = Date.now() - lastInteractionAt < 1400;
    send(winner.asset, {
      source: interactionFresh ? 'interaction-scan' : 'visual-scan',
      explicit: winner.explicit || interactionFresh,
      score: Number(winner.score || 0),
      force
    });
  }

  function onInteraction(event) {
    lastInteractionAt = Date.now();
    const direct = assetFromPath(event);
    if (direct) send(direct, { source: 'interaction', explicit: true, score: 1000, force: true });
    setTimeout(() => publishScan(true), 0);
    setTimeout(() => publishScan(true), 90);
    setTimeout(() => publishScan(true), 260);
  }

  document.addEventListener('pointerup', onInteraction, true);
  document.addEventListener('touchend', onInteraction, true);
  document.addEventListener('click', onInteraction, true);
  const observer = new MutationObserver(() => publishScan(false));
  try { observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true }); } catch {}
  setInterval(() => publishScan(false), 350);
  publishScan(true);
})();
