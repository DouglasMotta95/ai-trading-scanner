(() => {
  if (window.__ATS_FOCUSED_ASSET_TRACKER__) return;
  window.__ATS_FOCUSED_ASSET_TRACKER__ = true;

  const QUOTES = new Set(['USDT','USDC','USD','EUR','GBP','JPY','AUD','CAD','CHF','NZD','BRL','BTC','ETH']);
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

  const pairRe = /\b([A-Z0-9]{2,16})\s*[\/_-]\s*(USDT|USDC|USD|EUR|GBP|JPY|AUD|CAD|CHF|NZD|BRL|BTC|ETH)(?:\s*\(\s*OTC\s*\)|\s+OTC)?/i;

  function visible(el) {
    if (!el || !(el instanceof Element)) return false;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0;
  }

  function activeFlags(el) {
    const bits = [];
    let node = el;
    for (let i = 0; node && i < 4; i++, node = node.parentElement) {
      bits.push(
        node.getAttribute?.('aria-selected') || '',
        node.getAttribute?.('aria-current') || '',
        node.getAttribute?.('data-state') || '',
        node.getAttribute?.('data-active') || '',
        String(node.className || '')
      );
    }
    return bits.join(' ');
  }

  function contextFlags(el) {
    const bits = [];
    let node = el;
    for (let i = 0; node && i < 6; i++, node = node.parentElement) {
      bits.push(
        String(node.id || ''),
        String(node.className || ''),
        node.getAttribute?.('role') || '',
        node.getAttribute?.('data-testid') || ''
      );
    }
    return bits.join(' ').toLowerCase();
  }

  function focusedAsset() {
    const rows = [];
    let nodes = [];
    try {
      nodes = document.querySelectorAll('[aria-selected],[aria-current],[data-state],[data-active],[role="tab"],button,span,strong,b,div,p');
    } catch {}

    for (const el of nodes) {
      if (!visible(el)) continue;
      const text = clean(el.innerText || el.textContent || el.getAttribute?.('aria-label') || '');
      if (!text || text.length > 120) continue;
      const match = text.match(pairRe);
      if (!match) continue;
      const asset = canonicalAsset(match[0]);
      if (!asset) continue;

      const rect = el.getBoundingClientRect();
      const flags = activeFlags(el);
      const context = contextFlags(el);
      let score = 0;

      if (/true|active|selected|current|checked|open/i.test(flags)) score += 220;
      if (/\(OTC\)/i.test(text)) score += 22;
      if (text.length <= 34) score += 24;

      // CasaTrade chart header / selected instrument tab area.
      if (rect.top >= innerHeight * 0.05 && rect.top <= innerHeight * 0.36) score += 70;
      if (rect.left >= 0 && rect.left <= innerWidth * 0.72) score += 35;
      if (rect.top >= innerHeight * 0.14 && rect.top <= innerHeight * 0.32 && rect.left <= innerWidth * 0.62) score += 55;

      if (/chart|trade|instrument|asset|symbol|tab|header/.test(context)) score += 28;
      if (/watch|list|search|history|histor|portfolio|leader|ranking|modal|drawer|dropdown/.test(context)) score -= 85;

      rows.push({ asset, score, top: rect.top, left: rect.left });
    }

    rows.sort((a, b) => b.score - a.score || a.top - b.top || a.left - b.left);
    return rows[0]?.asset || '';
  }

  let lastAsset = '';
  let lastSentAt = 0;

  function publish(force = false) {
    const asset = focusedAsset();
    if (!asset) return;
    const now = Date.now();
    if (!force && asset === lastAsset && now - lastSentAt < 1000) return;
    lastAsset = asset;
    lastSentAt = now;
    chrome.runtime.sendMessage({ type: 'ATS_FOCUSED_ASSET', asset, at: now }).catch(() => {});
  }

  const observer = new MutationObserver(() => publish(false));
  try { observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true }); } catch {}
  setInterval(() => publish(false), 350);
  publish(true);
})();
