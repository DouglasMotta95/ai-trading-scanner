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
      try { out.push(...root.querySelectorAll('*')); } catch {}
      if (out.length > 9000) break;
    }
    return out.slice(0, 9000);
  }
  function text(el) {
    if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement) return clean(el.value || el.selectedOptions?.[0]?.textContent || '');
    return clean(el.getAttribute?.('aria-valuetext') || el.getAttribute?.('aria-label') || el.getAttribute?.('title') || el.innerText || el.textContent || '');
  }
  function context(el) {
    const parts = [text(el), el?.id, el?.className, el?.getAttribute?.('data-testid')];
    let p = el?.parentElement;
    for (let i = 0; p && i < 4; i++, p = p.parentElement) parts.push(clean(p.innerText || p.textContent || '').slice(0, 420));
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
  function expirationAroundLabel(raw = '') {
    const body = fold(raw);
    if (!body) return null;
    for (const marker of ['expiracao', 'expiry', 'expiration']) {
      let from = 0;
      for (let attempt = 0; attempt < 12; attempt += 1) {
        const index = body.indexOf(marker, from);
        if (index < 0) break;

        // Normal DOM order: "Expiração" then the observed value.
        const after = body.slice(index, Math.min(body.length, index + 360));
        const direct = expirationValue(after);
        if (direct) return direct;

        // Responsive/embedded layouts can visually place the label before its
        // value while DOM/text order is reversed (for example "1 min Expiração").
        // Only accept a real duration token immediately around an explicit
        // expiration label; never synthesize a default 60-second value.
        const before = body.slice(Math.max(0, index - 180), index);
        const matches = [...before.matchAll(/(?:^|[^0-9])((?:\d{1,3}:[0-5]\d)|(?:\d{1,4}\s*(?:s|seg|segundo|segundos|m|min|minuto|minutos)))\b/g)];
        const token = matches.at(-1)?.[1] || '';
        const reversed = expirationValue(token);
        if (reversed) return reversed;

        from = index + marker.length;
      }
    }
    return null;
  }

  function bodyExpiration() {
    const raw = clean(document.body?.innerText || document.body?.textContent || '');
    if (!raw) return null;
    const body = fold(raw.slice(0, 220000));
    return expirationAroundLabel(body);
  }

  function nearbyExpiration(all = []) {
    const labels = all.filter(el => {
      if (!visible(el)) return false;
      const own = fold(text(el));
      return own && own.length <= 160 && /expiracao|expiry|expiration/.test(own);
    });
    if (!labels.length) return null;

    const candidates = [];
    for (const label of labels) {
      let parent = label;
      for (let depth = 0; parent && depth < 9; depth += 1, parent = parent.parentElement) {
        const combined = clean(parent.innerText || parent.textContent || '');
        if (combined && combined.length <= 1800) {
          const value = expirationAroundLabel(combined);
          if (value) candidates.push({ value, score: 100 - depth * 2 });
        }
      }

      const lr = label.getBoundingClientRect();
      for (const el of all) {
        if (el === label || !visible(el)) continue;
        const own = text(el);
        if (!own || own.length > 48) continue;
        const value = expirationValue(own);
        if (!value) continue;
        const r = el.getBoundingClientRect();
        const vertical = Math.abs((r.top + r.bottom) / 2 - (lr.top + lr.bottom) / 2);
        // Measure the actual gap between the label and value, regardless
        // of which side the responsive layout places the value on.
        const horizontal = r.right < lr.left ? lr.left - r.right : r.left > lr.right ? r.left - lr.right : 0;
        const sameControlBand = vertical <= 120 && horizontal <= 520;
        if (!sameControlBand) continue;
        const distance = horizontal + vertical * 1.5;
        candidates.push({ value, score: Math.max(91, 99 - distance / 80) });
      }
    }

    candidates.sort((a, b) => b.score - a.score);
    return candidates[0] || null;
  }

  function timeframeValue(raw = '') {
    const s = clean(raw).toUpperCase().replace(/\s+/g, '');
    let m = s.match(/^M(\d{1,3})$/) || s.match(/^(\d{1,3})M$/); if (m && Number(m[1]) > 0) return `M${Number(m[1])}`;
    m = s.match(/^S(\d{1,5})$/) || s.match(/^(\d{1,5})S$/); if (m && Number(m[1]) > 0) return `S${Number(m[1])}`;
    return null;
  }
  function scan() {
    let exp = null, tf = null;
    const all = elements();
    for (const el of all) {
      if (!visible(el)) continue;
      const own = text(el);
      if (!own || own.length > 160) continue;
      const ctx = context(el);
      const controlLike = el.matches?.('button,input,select,[role="button"],[role="combobox"],[aria-selected="true"],[data-state="active"]');
      if (!exp && /expira|expiry|expiration|duracao|duration|tempo da operacao|tempo de operacao/.test(ctx)) {
        // CasaTrade often renders the label and value in sibling nodes
        // ("Expiração" + "1 min"). Read the labelled container too, but only
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
      const nearby = nearbyExpiration(all);
      if (nearby?.value) exp = nearby;
    }
    if (!exp) {
      const value = bodyExpiration();
      if (value) exp = { value, score: 96 };
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
