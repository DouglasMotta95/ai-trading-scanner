(() => {
  if (globalThis.__ATS_EXPIRATION_PROBE__) return;
  globalThis.__ATS_EXPIRATION_PROBE__ = true;
  const sendMessage = globalThis.__ATS_SEND_MESSAGE__;
  if (typeof sendMessage !== 'function') return;

  const clean = value => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  const fold = value => clean(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const visible = el => {
    if (!el || !(el instanceof Element)) return false;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
  };
  function roots() {
    const out = [document], queue = [document], seen = new Set();
    while (queue.length && out.length < 80) {
      const root = queue.shift();
      if (!root || seen.has(root)) continue;
      seen.add(root);
      let rows = [];
      try { rows = [...root.querySelectorAll('*')]; } catch {}
      for (const el of rows) if (el.shadowRoot) { out.push(el.shadowRoot); queue.push(el.shadowRoot); }
    }
    return out;
  }
  function elements() {
    const out = [];
    for (const root of roots()) {
      try { out.push(...root.querySelectorAll('button,input,select,[role="button"],[role="combobox"],[aria-selected="true"],[data-state="active"],span,div')); } catch {}
      if (out.length > 7000) break;
    }
    return out.slice(0, 7000);
  }
  function text(el) {
    if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement) return clean(el.value || el.selectedOptions?.[0]?.textContent || '');
    return clean(el.getAttribute?.('aria-valuetext') || el.getAttribute?.('aria-label') || el.getAttribute?.('title') || el.innerText || el.textContent || '');
  }
  function context(el) {
    const parts = [text(el), el?.id, el?.className, el?.getAttribute?.('data-testid')];
    let p = el?.parentElement;
    for (let i = 0; p && i < 2; i++, p = p.parentElement) parts.push(clean(p.innerText || p.textContent || '').slice(0, 180));
    return fold(parts.filter(Boolean).join(' '));
  }
  function expirationValue(raw = '') {
    const spaced = fold(raw);
    const labeled = spaced.match(/(?:expiracao|expiry|expiration|duracao|duration|tempo da operacao|tempo de operacao)[^0-9]{0,36}(\d{1,4})\s*(s|seg|segundo|segundos|m|min|minuto|minutos)\b/);
    if (labeled) {
      const amount = Number(labeled[1]);
      return /^(m|min|minuto|minutos)$/.test(labeled[2]) ? `${amount * 60}s` : `${amount}s`;
    }
    const s = spaced.replace(/\s+/g, '');
    let m = s.match(/^(\d{1,4})(?:s|seg|segundo|segundos)$/); if (m) return `${Number(m[1])}s`;
    m = s.match(/^(\d{1,3})(?:m|min|minuto|minutos)$/); if (m) return `${Number(m[1]) * 60}s`;
    m = s.match(/^(\d{1,3}):([0-5]\d)$/); if (m) return `${Number(m[1]) * 60 + Number(m[2])}s`;
    return null;
  }
  function timeframeValue(raw = '') {
    const s = clean(raw).toUpperCase().replace(/\s+/g, '');
    let m = s.match(/^M(\d{1,3})$/) || s.match(/^(\d{1,3})M$/); if (m && Number(m[1]) > 0) return `M${Number(m[1])}`;
    m = s.match(/^S(\d{1,5})$/) || s.match(/^(\d{1,5})S$/); if (m && Number(m[1]) > 0) return `S${Number(m[1])}`;
    return null;
  }
  function scan() {
    let exp = null, tf = null;
    for (const el of elements()) {
      if (!visible(el)) continue;
      const own = text(el);
      if (!own || own.length > 90) continue;
      const ctx = context(el);
      const controlLike = el.matches?.('button,input,select,[role="button"],[role="combobox"],[aria-selected="true"],[data-state="active"]');
      if (!exp && /expira|expiry|expiration|duracao|duration|tempo da operacao|tempo de operacao/.test(ctx)) {
        // CasaTrade often renders the label and value in sibling nodes
        // ("Expiração" + "5 seg"). Read the labelled container too, but only
        // inside expiration semantics so candle countdowns cannot be mistaken.
        const value = expirationValue(own) || expirationValue(ctx);
        if (value && (controlLike || own.length <= 64 || /expira|expiry|expiration|duracao|duration/.test(ctx))) {
          exp = { value, score: controlLike ? 99 : /expira|expiry|expiration|duracao|duration/.test(fold(own)) ? 94 : 90 };
        }
      }
      if (!tf && /timeframe|periodo|period|vela|candle/.test(ctx)) {
        const value = timeframeValue(own);
        if (value && (controlLike || /selected|active|current|true/.test(ctx))) tf = { value, score: controlLike ? 94 : 75 };
      }
      if (exp && tf) break;
    }
    if (!exp) {
      const body = clean(document.body?.innerText || document.body?.textContent || '');
      const value = expirationValue(body.slice(0, 30000));
      if (value) exp = { value, score: 88 };
    }
    if (!exp && !tf) return null;
    return {
      amount: null,
      expiration: exp?.value || null,
      timeframe: tf?.value || null,
      confidence: { amount: 0, expiration: exp?.score || 0, timeframe: tf?.score || 0 },
      source: 'casatrade-expiration-probe',
      observedAt: Date.now()
    };
  }

  let last = '';
  let lastSentAt = 0;
  async function publish(force = false) {
    const snapshot = scan();
    if (!snapshot) return;
    const key = JSON.stringify([snapshot.expiration, snapshot.timeframe]);
    const now = Date.now();
    // The background intentionally clears platform controls on an asset/session
    // reset. Re-publish unchanged CasaTrade controls as a heartbeat so a stable
    // "5 seg" value is restored after switching the active market.
    if (!force && key === last && now - lastSentAt < 900) return;
    last = key;
    lastSentAt = now;
    await sendMessage({ type: 'ATS_PLATFORM_CONTROLS_OBSERVED', snapshot });
  }
  new MutationObserver(() => publish(false).catch(() => {})).observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });
  document.addEventListener('click', () => setTimeout(() => publish(true).catch(() => {}), 80), true);
  setInterval(() => publish(true).catch(() => {}), 1200);
  publish(true).catch(() => {});
})();
