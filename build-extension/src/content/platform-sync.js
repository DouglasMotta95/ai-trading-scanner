(() => {
  if (globalThis.__ATS_PLATFORM_SYNC__) return;
  globalThis.__ATS_PLATFORM_SYNC__ = true;

  const host = String(location.hostname || '').toLowerCase().replace(/\.$/, '');
  const isCasaTradeHost = value => value === 'casatrade.com' || value.endsWith('.casatrade.com') || value === 'casatrade.io' || value.endsWith('.casatrade.io');
  if (!isCasaTradeHost(host)) return;

  const clean = v => String(v ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  const fold = v => clean(v).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const num = v => {
    let s = clean(v).replace(/[^\d,.-]/g, '');
    if (!s) return null;
    if (s.includes(',') && s.includes('.')) s = s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
    else s = s.replace(',', '.');
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  };
  const visible = el => {
    if (!el || !(el instanceof Element)) return false;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity || 1) > 0;
  };
  const textOf = el => {
    if (!el) return '';
    if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement) return el.value || el.selectedOptions?.[0]?.textContent || '';
    return el.getAttribute?.('aria-valuetext') || el.getAttribute?.('data-value') || el.innerText || el.textContent || '';
  };
  const financialAction = el => /comprar|vender|buy|sell/.test(fold([
    textOf(el), el?.getAttribute?.('aria-label'), el?.getAttribute?.('title'), el?.className
  ].filter(Boolean).join(' ')));

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
      for (const el of nodes) {
        out.push(el);
        if (out.length >= limit) break;
        if (el.shadowRoot) roots.push(el.shadowRoot);
      }
    }
    return out;
  }

  function fullText() {
    const parts = [document.body?.innerText || document.body?.textContent || ''];
    for (const el of deepElements(2500)) if (el.shadowRoot) parts.push(el.shadowRoot.textContent || '');
    return clean(parts.join(' ')).slice(0, 220000);
  }

  const normTf = v => {
    const s = fold(v).replace(/\s+/g, '');
    let m = s.match(/^m(1|2|5|15|30)$/); if (m) return `M${m[1]}`;
    m = s.match(/^(1|2|5|15|30)(?:m|min|minuto|minutos)$/); if (m) return `M${m[1]}`;
    m = s.match(/^s(5|15|30)$/); if (m) return `S${m[1]}`;
    m = s.match(/^(5|15|30)(?:s|seg|segundo|segundos)$/); if (m) return `S${m[1]}`;
    return /^(h1|1h|60m|60min)$/.test(s) ? 'H1' : null;
  };
  const normExp = v => {
    const s = fold(v).replace(/\s+/g, '');
    let m = s.match(/^(\d{1,4})(?:s|seg|segundo|segundos)$/); if (m) return `${Number(m[1])}s`;
    m = s.match(/^(\d{1,3})(?:m|min|minuto|minutos)$/); if (m) return Number(m[1]) === 1 ? '60s' : `${Number(m[1])}m`;
    m = s.match(/^(\d{1,2}):(\d{2})$/);
    if (m) {
      const seconds = Number(m[1]) * 60 + Number(m[2]);
      return seconds === 60 ? '60s' : seconds < 60 ? `${seconds}s` : seconds % 60 === 0 ? `${seconds / 60}m` : `${seconds}s`;
    }
    return null;
  };

  const ownContext = el => fold([
    textOf(el), el?.getAttribute?.('aria-label'), el?.getAttribute?.('title'), el?.getAttribute?.('placeholder'),
    el?.getAttribute?.('data-testid'), el?.getAttribute?.('data-name'), el?.name, el?.id, el?.className
  ].filter(Boolean).join(' '));
  const localContext = el => {
    const parts = [ownContext(el)];
    let p = el?.parentElement;
    for (let i = 0; i < 2 && p; i++, p = p.parentElement) parts.push(clean(p.innerText || p.textContent || '').slice(0, 220));
    return fold(parts.join(' '));
  };

  function amountCandidate() {
    const rows = [];
    for (const el of deepElements()) {
      if (!visible(el) || financialAction(el)) continue;
      const own = ownContext(el);
      const local = localContext(el);
      if (!/\bvalor\b|amount|stake|investimento|investment/.test(own + ' ' + local)) continue;
      const value = num(textOf(el));
      if (value == null || value <= 0 || value > 100000000) continue;
      let score = /\bvalor\b|amount|stake|investimento|investment/.test(own) ? 80 : 45;
      if (el instanceof HTMLInputElement) score += 35;
      if (/saldo|lucro|profit|retorno|payout/.test(local)) score -= 60;
      rows.push({ el, value, score });
    }
    rows.sort((a, b) => b.score - a.score);
    if (rows[0]) return rows[0];

    const page = fullText();
    const match = page.match(/(?:\bvalor\b|amount|stake|investimento|investment)[^0-9]{0,35}([0-9][0-9.,]*)/i);
    const value = num(match?.[1]);
    return value != null && value > 0 && value <= 100000000 ? { el: null, value, score: 35 } : null;
  }

  function timeframeCandidate() {
    const rows = [];
    for (const el of deepElements()) {
      if (!visible(el) || financialAction(el)) continue;
      const text = clean(textOf(el));
      if (!text || text.length > 24) continue;
      const value = normTf(text);
      if (!value) continue;
      const r = el.getBoundingClientRect();
      const local = localContext(el);
      let score = 0;
      if (el.getAttribute?.('aria-selected') === 'true' || /active|selected|current/i.test(String(el.className || ''))) score += 90;
      if (/vela|timeframe|candle|periodo/.test(local)) score += 35;
      if (r.left < innerWidth * .38) score += 25;
      if (r.top > innerHeight * .15 && r.top < innerHeight * .9) score += 10;
      if (/expira|expiry|duration/.test(local)) score -= 40;
      rows.push({ el, value, score });
    }
    rows.sort((a, b) => b.score - a.score);
    return rows[0] || null;
  }

  function expirationCandidate() {
    const page = fullText();
    const direct = page.match(/(?:EXPIRA(?:ÇÃO|CAO)|EXPIRY|DURATION)[^0-9]{0,40}(\d{1,4})\s*(S|SEG|SEGUNDO|SEGUNDOS|M|MIN|MINUTO|MINUTOS)/i);
    if (direct) {
      const value = normExp(`${direct[1]}${direct[2]}`);
      if (value) return { el: null, value, score: 70 };
    }

    const rows = [];
    for (const el of deepElements()) {
      if (!visible(el) || financialAction(el)) continue;
      const text = clean(textOf(el));
      if (!text || text.length > 80) continue;
      const local = localContext(el);
      if (!/expira|expiry|expiration|duracao|duration/.test(local)) continue;
      const token = text.match(/\d{1,4}\s*(?:s|seg|segundo|segundos|m|min|minuto|minutos)/i)?.[0] ||
        local.match(/\d{1,4}\s*(?:s|seg|segundo|segundos|m|min|minuto|minutos)/i)?.[0];
      const value = normExp(token);
      if (!value) continue;
      let score = /expira|expiry|expiration|duracao|duration/.test(ownContext(el)) ? 80 : 45;
      rows.push({ el, value, score });
    }
    rows.sort((a, b) => b.score - a.score);
    return rows[0] || null;
  }

  function readDom() {
    const amount = amountCandidate();
    const timeframe = timeframeCandidate();
    const expiration = expirationCandidate();
    return {
      amount: amount?.value ?? null,
      timeframe: timeframe?.value || null,
      expiration: expiration?.value || null,
      detected: { amount: amount?.value != null, timeframe: !!timeframe?.value, expiration: !!expiration?.value },
      confidence: { amount: amount?.score || 0, timeframe: timeframe?.score || 0, expiration: expiration?.score || 0 },
      sources: { amount: amount ? 'frame-dom' : null, timeframe: timeframe ? 'frame-dom' : null, expiration: expiration ? 'frame-dom' : null },
      at: Date.now()
    };
  }

  const localCount = observed => Number(!!observed?.detected?.amount) + Number(!!observed?.detected?.timeframe) + Number(!!observed?.detected?.expiration);

  async function read(seed = null) {
    const observed = seed || readDom();
    const state = await chrome.runtime.sendMessage({ type: 'ATS_GET_STATE' }).catch(() => null);
    if (!state || state.platformId !== 'casatrade' || state.connection !== 'online') return observed;
    if (!observed.timeframe) {
      const tf = normTf(state.timeframe);
      if (tf) { observed.timeframe = tf; observed.sources.timeframe = 'capture'; }
    }
    if (!observed.expiration) {
      const exp = normExp(state.expiration);
      if (exp) { observed.expiration = exp; observed.sources.expiration = 'capture'; }
    }
    observed.at = Date.now();
    return observed;
  }

  const fire = el => { for (const type of ['input','change','blur']) el?.dispatchEvent?.(new Event(type, { bubbles: true })); };
  const setAmount = (el, value) => {
    if (!el) return false;
    const formatted = String(Number(value));
    if (el instanceof HTMLInputElement) {
      const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value') || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
      try { desc?.set ? desc.set.call(el, formatted) : (el.value = formatted); } catch { el.value = formatted; }
      fire(el);
      return true;
    }
    if (el.getAttribute?.('contenteditable') === 'true') {
      el.textContent = formatted;
      fire(el);
      return true;
    }
    return false;
  };
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

  async function setChoice(kind, control, target) {
    if (!control) return false;
    const normalize = kind === 'timeframe' ? normTf : normExp;
    if (control instanceof HTMLSelectElement) {
      const option = [...control.options].find(o => normalize(o.value) === target || normalize(o.textContent) === target);
      if (!option) return false;
      control.value = option.value;
      fire(control);
      return true;
    }
    if (normalize(textOf(control)) === target) return true;
    if (typeof control.click !== 'function') return false;
    control.click();
    await wait(180);
    const options = deepElements().filter(el => visible(el) && el !== control && !financialAction(el))
      .filter(el => normalize(textOf(el)) === target)
      .slice(0, 30);
    if (!options[0]) return false;
    options[0].click();
    await wait(160);
    return true;
  }

  async function apply(prefs = {}) {
    const local = readDom();
    if (!localCount(local)) return { ok: false, ignored: true, error: 'controls_not_in_frame' };
    const desired = {
      amount: num(prefs.tradeAmount ?? prefs.stake),
      timeframe: normTf(prefs.timeframe),
      expiration: normExp(prefs.expiration)
    };
    const before = await read(local);
    const attempted = {}, applied = {};

    if (desired.amount != null && desired.amount > 0) {
      const c = amountCandidate();
      attempted.amount = !!c?.el;
      applied.amount = Number(c?.value) === desired.amount || (!!c?.el && setAmount(c.el, desired.amount));
    }
    if (desired.timeframe) {
      const c = timeframeCandidate();
      attempted.timeframe = !!c?.el;
      applied.timeframe = !!c?.el && await setChoice('timeframe', c.el, desired.timeframe);
    }
    if (desired.expiration) {
      const c = expirationCandidate();
      attempted.expiration = !!c?.el;
      applied.expiration = !!c?.el && await setChoice('expiration', c.el, desired.expiration);
    }

    await wait(300);
    const after = await read();
    const matched = {
      amount: desired.amount != null && after.amount != null ? Math.abs(after.amount - desired.amount) < 0.000001 : false,
      timeframe: !!desired.timeframe && after.timeframe === desired.timeframe,
      expiration: !!desired.expiration && after.expiration === desired.expiration
    };
    return { ok: !!(matched.amount && matched.timeframe && matched.expiration), desired, before, after, attempted, applied, matched };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'ATS_PLATFORM_READ') {
      const local = readDom();
      if (!localCount(local)) return false;
      read(local).then(observed => sendResponse({ ok: true, observed })).catch(e => sendResponse({ ok: false, error: String(e?.message || e) }));
      return true;
    }
    if (message?.type === 'ATS_PLATFORM_APPLY') {
      const local = readDom();
      if (!localCount(local)) return false;
      apply(message.preferences || {}).then(result => sendResponse(result)).catch(e => sendResponse({ ok: false, error: String(e?.message || e) }));
      return true;
    }
  });
})();
