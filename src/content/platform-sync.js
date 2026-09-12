(() => {
  if (globalThis.__ATS_PLATFORM_SYNC__) return;
  globalThis.__ATS_PLATFORM_SYNC__ = true;

  const visible = el => {
    if (!el || !(el instanceof Element)) return false;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity || 1) > 0;
  };
  const clean = v => String(v ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  const fold = v => clean(v).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const short = (v, n = 180) => clean(v).slice(0, n);
  const num = v => {
    let s = clean(v).replace(/[^\d,.-]/g, '');
    if (!s) return null;
    if (s.includes(',') && s.includes('.')) s = s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
    else s = s.replace(',', '.');
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  };
  const normTf = v => {
    const s = fold(v).replace(/\s+/g, '');
    let m = s.match(/^(?:m)?(1|2|5|15|30)(?:m|min|minuto|minutos)?$/); if (m) return `M${m[1]}`;
    m = s.match(/^(1|2|5|15|30)(?:min|minuto|minutos)$/); if (m) return `M${m[1]}`;
    m = s.match(/^m(1|2|5|15|30)$/); if (m) return `M${m[1]}`;
    m = s.match(/^(5|15|30)(?:s|seg|segundo|segundos)$/); if (m) return `S${m[1]}`;
    m = s.match(/^s(5|15|30)$/); if (m) return `S${m[1]}`;
    if (/^(1h|h1|60min)$/.test(s)) return 'H1';
    return null;
  };
  const normExp = v => {
    const s = fold(v).replace(/\s+/g, '');
    let m = s.match(/^(\d{1,4})(s|seg|segundo|segundos)$/); if (m) return `${Number(m[1])}s`;
    m = s.match(/^(\d{1,3})(m|min|minuto|minutos)$/); if (m) return Number(m[1]) === 1 ? '60s' : `${Number(m[1])}m`;
    if (s === '1min') return '60s';
    return null;
  };
  const context = el => {
    const parts = [el.getAttribute?.('aria-label'), el.getAttribute?.('title'), el.getAttribute?.('placeholder'), el.name, el.id, el.className];
    let p = el;
    for (let i = 0; i < 3 && p; i++, p = p.parentElement) {
      const t = short(p.innerText || p.textContent || '', 220);
      if (t) parts.push(t);
    }
    return fold(parts.filter(Boolean).join(' '));
  };
  const interactive = () => [...document.querySelectorAll('input,select,button,[role="button"],[role="combobox"],[contenteditable="true"]')].filter(visible);
  const excludeFinancialAction = txt => /comprar|vender|buy|sell|depositar|saque|retirar|confirmar ordem|abrir ordem/.test(txt);
  const rank = (kind, el) => {
    const c = context(el);
    if (excludeFinancialAction(c)) return -999;
    let score = 0;
    if (kind === 'amount') {
      if (/\bvalor\b|montante|amount|stake|investimento/.test(c)) score += 12;
      if (el instanceof HTMLInputElement) score += 5;
      if (/saldo|lucro|payout|retorno/.test(c)) score -= 10;
    }
    if (kind === 'timeframe') {
      if (/timeframe|tempo da vela|periodo da vela|vela|grafico/.test(c)) score += 12;
      if (normTf(el.value || el.textContent || '')) score += 4;
    }
    if (kind === 'expiration') {
      if (/expiracao|expiry|expiration|duracao da entrada|tempo de expiracao/.test(c)) score += 14;
      if (normExp(el.value || el.textContent || '')) score += 3;
    }
    return score;
  };
  const best = kind => interactive().map(el => ({ el, score: rank(kind, el) })).filter(x => x.score >= 8).sort((a, b) => b.score - a.score)[0] || null;
  const selectorHint = el => {
    if (!el) return null;
    const tag = el.tagName.toLowerCase();
    if (el.id && !/token|auth|session|password|secret/i.test(el.id)) return `${tag}#${String(el.id).replace(/[^\w-]/g, '').slice(0, 60)}`;
    const cls = [...el.classList].filter(x => !/token|auth|session|password|secret/i.test(x)).slice(0, 2).join('.');
    return cls ? `${tag}.${cls}` : tag;
  };
  const textOf = el => el instanceof HTMLInputElement || el instanceof HTMLSelectElement ? (el.value || el.selectedOptions?.[0]?.textContent || '') : (el.innerText || el.textContent || '');
  const read = () => {
    const amount = best('amount'), timeframe = best('timeframe'), expiration = best('expiration');
    const amountValue = amount ? num(textOf(amount.el)) : null;
    const timeframeValue = timeframe ? normTf(textOf(timeframe.el)) : null;
    const expirationValue = expiration ? normExp(textOf(expiration.el)) : null;
    return {
      amount: amountValue,
      timeframe: timeframeValue,
      expiration: expirationValue,
      detected: { amount: !!amountValue || amountValue === 0, timeframe: !!timeframeValue, expiration: !!expirationValue },
      confidence: { amount: amount?.score || 0, timeframe: timeframe?.score || 0, expiration: expiration?.score || 0 },
      hints: { amount: selectorHint(amount?.el), timeframe: selectorHint(timeframe?.el), expiration: selectorHint(expiration?.el) },
      at: Date.now()
    };
  };
  const fire = el => {
    for (const type of ['input', 'change', 'blur']) el.dispatchEvent(new Event(type, { bubbles: true }));
  };
  const setInput = (el, value) => {
    if (!(el instanceof HTMLInputElement)) return false;
    const proto = Object.getPrototypeOf(el);
    const desc = Object.getOwnPropertyDescriptor(proto, 'value') || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    const formatted = String(Number(value)).replace('.', ',');
    try { desc?.set ? desc.set.call(el, formatted) : (el.value = formatted); } catch { el.value = formatted; }
    fire(el);
    return true;
  };
  const distance = (a, b) => {
    const x = a.getBoundingClientRect(), y = b.getBoundingClientRect();
    return Math.hypot((x.left + x.width / 2) - (y.left + y.width / 2), (x.top + x.height / 2) - (y.top + y.height / 2));
  };
  const wait = ms => new Promise(r => setTimeout(r, ms));
  async function setChoice(kind, control, target) {
    if (!control) return false;
    const normalize = kind === 'timeframe' ? normTf : normExp;
    if (control instanceof HTMLSelectElement) {
      const option = [...control.options].find(o => normalize(o.value) === target || normalize(o.textContent) === target);
      if (!option) return false;
      control.value = option.value; fire(control); return true;
    }
    const current = normalize(textOf(control));
    if (current === target) return true;
    control.click();
    await wait(120);
    const candidates = [...document.querySelectorAll('[role="option"],[role="menuitem"],li,button,div,span')]
      .filter(el => visible(el) && el !== control && short(el.innerText || el.textContent || '', 40).length <= 40)
      .filter(el => normalize(el.innerText || el.textContent || '') === target)
      .filter(el => !excludeFinancialAction(context(el)))
      .sort((a, b) => distance(control, a) - distance(control, b));
    const option = candidates[0];
    if (!option) { document.body.click(); return false; }
    option.click();
    await wait(100);
    return true;
  }
  async function apply(prefs = {}) {
    const desired = {
      amount: num(prefs.tradeAmount ?? prefs.stake),
      timeframe: normTf(prefs.timeframe),
      expiration: normExp(prefs.expiration)
    };
    const result = { attempted: {}, applied: {}, desired, before: read() };
    if (desired.amount != null && desired.amount > 0) {
      const c = best('amount'); result.attempted.amount = !!c;
      result.applied.amount = !!c && (Math.abs((num(textOf(c.el)) ?? NaN) - desired.amount) < 0.000001 || setInput(c.el, desired.amount));
    }
    if (desired.timeframe) {
      const c = best('timeframe'); result.attempted.timeframe = !!c;
      result.applied.timeframe = !!c && await setChoice('timeframe', c.el, desired.timeframe);
    }
    if (desired.expiration) {
      const c = best('expiration'); result.attempted.expiration = !!c;
      result.applied.expiration = !!c && await setChoice('expiration', c.el, desired.expiration);
    }
    await wait(180);
    result.after = read();
    result.matched = {
      amount: desired.amount != null && result.after.amount != null ? Math.abs(result.after.amount - desired.amount) < 0.000001 : false,
      timeframe: !!desired.timeframe && result.after.timeframe === desired.timeframe,
      expiration: !!desired.expiration && result.after.expiration === desired.expiration
    };
    result.ok = !!(result.matched.amount && result.matched.timeframe && result.matched.expiration);
    return result;
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'ATS_PLATFORM_READ') { sendResponse({ ok: true, observed: read() }); return; }
    if (message?.type === 'ATS_PLATFORM_APPLY') {
      apply(message.preferences || {}).then(x => sendResponse({ ok: x.ok, ...x })).catch(e => sendResponse({ ok: false, error: String(e?.message || e), observed: read() }));
      return true;
    }
  });
})();