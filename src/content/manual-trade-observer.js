(() => {
  if (globalThis.__ATS_MANUAL_TRADE_OBSERVER__) return;
  globalThis.__ATS_MANUAL_TRADE_OBSERVER__ = true;

  const host = String(location.hostname || '').toLowerCase().replace(/\.$/, '');
  const allowed = value => value === 'casatrade.com' || value.endsWith('.casatrade.com') || value === 'casatrade.io' || value.endsWith('.casatrade.io') || value === 'casatraders.online' || value.endsWith('.casatraders.online') || value === 'ivcasatraders.online' || value.endsWith('.ivcasatraders.online');
  if (!allowed(host)) return;

  const visible = el => {
    if (!el || !(el instanceof Element)) return false;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width >= 28 && rect.height >= 18 && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0;
  };
  const clean = value => String(value || '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
  const buyTokens = ['comprar','compra','buy','call','alta','higher','up'];
  const sellTokens = ['vender','venda','sell','put','baixa','lower','down'];

  function textOf(el) {
    return clean([
      el.textContent,
      el.getAttribute?.('aria-label'),
      el.getAttribute?.('title'),
      el.getAttribute?.('data-testid'),
      el.getAttribute?.('name'),
      el.className
    ].filter(Boolean).join(' '));
  }

  function tokenScore(text, tokens) {
    let score = 0;
    for (const token of tokens) {
      if (new RegExp(`(^|[^a-z])${token.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}([^a-z]|$)`, 'i').test(text)) score += token.length >= 5 ? 5 : 3;
    }
    return score;
  }

  function classify(el) {
    if (!el || !visible(el)) return null;
    if (el.closest?.('#ats-analysis-visual-overlay-v2,[id^="ats-"]')) return null;
    const text = textOf(el);
    if (!text) return null;
    const buy = tokenScore(text, buyTokens);
    const sell = tokenScore(text, sellTokens);
    if (Math.max(buy, sell) < 4 || buy === sell) return null;
    return buy > sell ? 'BUY' : 'SELL';
  }

  let lastKey = '';
  let lastAt = 0;
  document.addEventListener('click', event => {
    const target = event.target instanceof Element ? event.target.closest('button,[role="button"],input[type="button"],input[type="submit"],a') : null;
    if (!target) return;
    const direction = classify(target);
    if (!direction) return;
    const now = Date.now();
    const label = clean(target.textContent || target.getAttribute('aria-label') || target.getAttribute('title') || '').slice(0, 100);
    const key = `${direction}|${label}`;
    if (key === lastKey && now - lastAt < 700) return;
    lastKey = key;
    lastAt = now;
    chrome.runtime.sendMessage({ type: 'ATS_MANUAL_TRADE_CLICK', direction, clickedAt: now, label }).catch(() => {});
  }, true);
})();
