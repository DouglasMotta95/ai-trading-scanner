(() => {
  if (globalThis.__ATS_ACCOUNT_METRICS_OBSERVER__) return;
  globalThis.__ATS_ACCOUNT_METRICS_OBSERVER__ = true;

  const host = String(location.hostname || '').toLowerCase().replace(/\.$/, '');
  const allowed = value => value === 'casatrade.com' || value.endsWith('.casatrade.com') || value === 'casatrade.io' || value.endsWith('.casatrade.io') || value === 'casatraders.online' || value.endsWith('.casatraders.online') || value === 'ivcasatraders.online' || value.endsWith('.ivcasatraders.online');
  if (!allowed(host)) return;

  const clean = value => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  const visible = el => {
    if (!el || !(el instanceof Element)) return false;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0;
  };
  const parseNumber = value => {
    const raw = clean(value).replace(/\s/g, '');
    if (!raw) return null;
    let s = raw.replace(/[^\d,.-]/g, '');
    if (!s) return null;
    if (s.includes(',') && s.includes('.')) s = s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
    else if (s.includes(',')) s = s.replace(',', '.');
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  };
  const currencyFrom = text => /R\$/i.test(text) ? 'BRL' : /€/.test(text) ? 'EUR' : /£/.test(text) ? 'GBP' : /\$/.test(text) ? 'USD' : null;
  const BALANCE_RE = /\b(saldo|balance|banca|conta\s+real|real\s+account|wallet|funds|equity)\b/i;
  const STAKE_RE = /\b(valor|amount|invest|investimento|investment|stake|entrada|aposta)\b/i;
  const PAYOUT_RE = /\b(payout|retorno|rendimento|return|lucro|profit)\b/i;

  function deepElements(limit = 5000) {
    const out = [];
    const roots = [document];
    const seen = new Set();
    while (roots.length && out.length < limit) {
      const root = roots.shift();
      if (!root || seen.has(root)) continue;
      seen.add(root);
      let nodes = [];
      try { nodes = [...root.querySelectorAll('*')]; } catch {}
      for (const el of nodes) {
        out.push(el);
        if (out.length >= limit) break;
        if (el.shadowRoot) roots.push(el.shadowRoot);
      }
    }
    return out;
  }

  const metaText = el => clean([
    el?.getAttribute?.('aria-label'), el?.getAttribute?.('title'), el?.getAttribute?.('placeholder'),
    el?.getAttribute?.('data-testid'), el?.getAttribute?.('data-name'), el?.getAttribute?.('name'),
    el?.id, el?.className
  ].filter(Boolean).join(' '));

  function localText(el, levels = 2) {
    const parts = [clean(el?.textContent || el?.innerText || ''), metaText(el)];
    let parent = el?.parentElement;
    for (let i = 0; parent && i < levels; i += 1, parent = parent.parentElement) {
      parts.push(clean(parent.textContent || parent.innerText || '').slice(0, 240), metaText(parent));
    }
    return clean(parts.join(' '));
  }

  function moneyFromText(text, labelRe) {
    const source = clean(text);
    const label = source.match(labelRe);
    if (!label) return null;
    const after = source.slice((label.index || 0) + label[0].length);
    const money = after.match(/(?:R\$|US\$|\$|€|£)?\s*-?\d[\d.,\s]*/);
    if (!money) return null;
    const value = parseNumber(money[0]);
    if (value == null || Math.abs(value) > 1e9) return null;
    return { value, currency: currencyFrom(money[0]) || currencyFrom(source) };
  }

  function payoutFromText(text) {
    const source = clean(text);
    if (!PAYOUT_RE.test(source)) return null;
    const match = source.match(/(-?\d{1,3}(?:[.,]\d+)?)\s*%/);
    const value = match ? parseNumber(match[1]) : null;
    return value != null && value >= 0 && value <= 100 ? value : null;
  }

  function labeledCandidate(labelRe) {
    const nodes = deepElements(5000);
    let best = null;
    let seen = 0;
    for (const el of nodes) {
      if (++seen > 1800) break;
      if (!visible(el)) continue;
      const own = clean(el.textContent || el.innerText || '');
      const context = localText(el, 2);
      if ((!own && !context) || own.length > 180 || !labelRe.test(context)) continue;
      const areas = [own, context, clean(el.parentElement?.textContent), clean(el.parentElement?.parentElement?.textContent)].filter(x => x && x.length <= 320);
      for (let depth = 0; depth < areas.length; depth++) {
        const parsed = moneyFromText(areas[depth], labelRe);
        if (!parsed) continue;
        const score = 10 - depth * 2 + (parsed.currency ? 3 : 0) + (el.matches('strong,b') ? 1 : 0);
        if (!best || score > best.score) best = { ...parsed, score };
      }
    }
    return best;
  }

  function stakeFromInput() {
    const fields = deepElements(5000).filter(el => el.matches?.('input,textarea,[contenteditable="true"]'));
    let best = null;
    let seen = 0;
    for (const el of fields) {
      if (++seen > 250 || !visible(el)) continue;
      const meta = localText(el, 2);
      if (!STAKE_RE.test(meta)) continue;
      const raw = 'value' in el ? el.value : el.textContent;
      const value = parseNumber(raw);
      if (value == null || value < 0 || value > 1e8) continue;
      const score = 14 + (currencyFrom(meta) ? 2 : 0);
      if (!best || score > best.score) best = { value, currency: currencyFrom(meta), score };
    }
    return best;
  }

  function topBarBalanceCandidate() {
    let best = null;
    let seen = 0;
    const moneyToken = /(?:R\$|US\$|\$|€|£)\s*-?\d[\d.,\s]*/;
    for (const el of deepElements(5000)) {
      if (++seen > 5000 || !visible(el)) continue;
      const own = clean(el.textContent || el.innerText || '');
      if (!own || own.length > 48) continue;
      const match = own.match(moneyToken);
      if (!match) continue;
      const value = parseNumber(match[0]);
      if (value == null || value < 0 || value > 1e9) continue;
      const rect = el.getBoundingClientRect();
      const context = localText(el, 1).toLowerCase();
      if (/lucro|profit|payout|retorno|return|comprar|buy|vender|sell|valor|amount|invest|expira|expiry/.test(context)) continue;
      let score = 0;
      if (rect.top >= 0 && rect.top <= Math.max(220, innerHeight * .20)) score += 8;
      if (rect.left >= innerWidth * .48) score += 5;
      if (/deposit|depositar|withdraw|sacar|wallet|saldo|balance|conta/.test(context)) score += 10;
      if (/R\$|US\$|\$|€|£/.test(match[0])) score += 3;
      if (value >= 10) score += 1;
      if (!best || score > best.score) best = { value, currency: currencyFrom(match[0]) || currencyFrom(context), score };
    }
    return best && best.score >= 11 ? best : null;
  }

  function payoutCandidate() {
    const nodes = deepElements(5000);
    let best = null;
    let seen = 0;
    for (const el of nodes) {
      if (++seen > 1400 || !visible(el)) continue;
      const text = clean(el.textContent);
      if (!text || text.length > 120) continue;
      const value = payoutFromText(text);
      if (value == null) continue;
      const score = 10 + (/payout/i.test(text) ? 2 : 0);
      if (!best || score > best.score) best = { value, score };
    }
    return best;
  }

  let lastKey = '';
  let lastSent = 0;
  let timer = 0;
  function scan() {
    timer = 0;
    const balance = labeledCandidate(BALANCE_RE) || topBarBalanceCandidate();
    const stake = stakeFromInput() || labeledCandidate(STAKE_RE);
    const payout = payoutCandidate();
    if (!balance && !stake && !payout) return;
    const snapshot = {
      balance: balance?.value ?? null,
      stake: stake?.value ?? null,
      payoutPct: payout?.value ?? null,
      currency: balance?.currency || stake?.currency || null,
      confidence: {
        balance: balance?.score || 0,
        stake: stake?.score || 0,
        payout: payout?.score || 0
      },
      source: 'platform-dom-labelled',
      observedAt: Date.now()
    };
    const key = JSON.stringify([snapshot.balance, snapshot.stake, snapshot.payoutPct, snapshot.currency]);
    const now = Date.now();
    if (key === lastKey && now - lastSent < 5000) return;
    lastKey = key;
    lastSent = now;
    chrome.runtime.sendMessage({ type: 'ATS_ACCOUNT_METRICS', snapshot }).catch(() => {});
  }
  function schedule(delay = 180) {
    if (timer) return;
    timer = setTimeout(scan, delay);
  }

  new MutationObserver(() => schedule(350)).observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['value','aria-label'] });
  document.addEventListener('input', () => schedule(40), true);
  document.addEventListener('click', () => schedule(120), true);
  setInterval(() => schedule(0), 2500);
  schedule(250);
})();