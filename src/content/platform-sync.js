(() => {
  if (globalThis.__ATS_PLATFORM_SYNC__) return;
  globalThis.__ATS_PLATFORM_SYNC__ = true;

  const CASATRADE_HOSTS = new Set([
    'casatrade.com', 'www.casatrade.com', 'app.casatrade.com', 'trade.casatrade.com',
    'casatrade.io', 'www.casatrade.io', 'app.casatrade.io', 'trade.casatrade.io'
  ]);
  const host = String(location.hostname || '').toLowerCase().replace(/\.$/, '');
  if (!CASATRADE_HOSTS.has(host)) return;

  const visible = el => {
    if (!el || !(el instanceof Element)) return false;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity || 1) > 0;
  };
  const clean = v => String(v ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  const fold = v => clean(v).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const short = (v, n = 220) => clean(v).slice(0, n);
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
    let m = s.match(/^m(1|2|5|15|30)$/); if (m) return `M${m[1]}`;
    m = s.match(/^(1|2|5|15|30)(?:m|min|minuto|minutos)$/); if (m) return `M${m[1]}`;
    m = s.match(/^s(5|15|30)$/); if (m) return `S${m[1]}`;
    m = s.match(/^(5|15|30)(?:s|seg|segundo|segundos)$/); if (m) return `S${m[1]}`;
    if (/^(h1|1h|60m|60min)$/.test(s)) return 'H1';
    return null;
  };
  const normExp = v => {
    const s = fold(v).replace(/\s+/g, '');
    let m = s.match(/^(\d{1,4})(s|seg|segundo|segundos)$/); if (m) return `${Number(m[1])}s`;
    m = s.match(/^(\d{1,3})(m|min|minuto|minutos)$/); if (m) return Number(m[1]) === 1 ? '60s' : `${Number(m[1])}m`;
    m = s.match(/^(\d{1,2}):(\d{2})$/);
    if (m) {
      const seconds = Number(m[1]) * 60 + Number(m[2]);
      if (seconds > 0 && seconds <= 3600) return seconds === 60 ? '60s' : seconds < 60 ? `${seconds}s` : seconds % 60 === 0 ? `${seconds / 60}m` : `${seconds}s`;
    }
    const numeric = /^\d{1,4}$/.test(s) ? Number(s) : null;
    if (numeric != null && numeric > 0 && numeric <= 3600) return numeric === 60 ? '60s' : numeric < 60 ? `${numeric}s` : numeric % 60 === 0 ? `${numeric / 60}m` : `${numeric}s`;
    return null;
  };

  const textOf = el => {
    if (!el) return '';
    if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement) return el.value || el.selectedOptions?.[0]?.textContent || '';
    return el.getAttribute?.('aria-valuetext') || el.getAttribute?.('data-value') || el.innerText || el.textContent || '';
  };
  const context = el => {
    const parts = [
      el.getAttribute?.('aria-label'), el.getAttribute?.('title'), el.getAttribute?.('placeholder'),
      el.getAttribute?.('data-testid'), el.getAttribute?.('data-name'), el.name, el.id, el.className
    ];
    if (el.id) {
      try { parts.push(document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent); } catch {}
    }
    let p = el;
    for (let i = 0; i < 3 && p; i++, p = p.parentElement) {
      const t = short(p.innerText || p.textContent || '', 240);
      if (t) parts.push(t);
    }
    return fold(parts.filter(Boolean).join(' '));
  };
  const excludeFinancialAction = txt => /comprar|vender|buy|sell|depositar|saque|retirar|confirmar ordem|abrir ordem/.test(txt);
  const interactive = () => [...document.querySelectorAll([
    'input', 'select', 'button', '[role="button"]', '[role="combobox"]', '[contenteditable="true"]',
    '[data-testid*="amount" i]', '[data-testid*="stake" i]', '[data-testid*="investment" i]', '[data-testid*="valor" i]',
    '[data-testid*="timeframe" i]', '[data-testid*="candle" i]', '[data-testid*="period" i]',
    '[data-testid*="expiration" i]', '[data-testid*="expiry" i]', '[data-testid*="duration" i]',
    '[aria-label*="valor" i]', '[aria-label*="amount" i]', '[aria-label*="vela" i]', '[aria-label*="timeframe" i]',
    '[aria-label*="expira" i]', '[aria-label*="expiry" i]'
  ].join(','))].filter(visible);

  const rank = (kind, el) => {
    const c = context(el);
    const ownText = textOf(el);
    if (excludeFinancialAction(c)) return -999;
    let score = 0;
    if (kind === 'amount') {
      if (/\bvalor\b|montante|amount|stake|investimento|investment/.test(c)) score += 16;
      if (el instanceof HTMLInputElement) score += 6;
      if (num(ownText) != null) score += 2;
      if (/saldo|lucro|payout|retorno|profit/.test(c)) score -= 14;
    }
    if (kind === 'timeframe') {
      if (/timeframe|tempo da vela|periodo da vela|período da vela|vela|candle|grafico|gráfico/.test(c)) score += 16;
      if (normTf(ownText)) score += 6;
      if (/expiracao|expiração|expiry|expiration|duracao|duração/.test(c)) score -= 14;
    }
    if (kind === 'expiration') {
      if (/expiracao|expiração|expiry|expiration|duracao da entrada|duração da entrada|tempo de expiracao|tempo de expiração|duration/.test(c)) score += 18;
      if (normExp(ownText)) score += 5;
      if (/timeframe|tempo da vela|periodo da vela|período da vela|candle/.test(c)) score -= 12;
    }
    return score;
  };
  const best = kind => interactive().map(el => ({ el, score: rank(kind, el) })).filter(x => x.score >= 10).sort((a, b) => b.score - a.score)[0] || null;
  const selectorHint = el => {
    if (!el) return null;
    const tag = el.tagName.toLowerCase();
    if (el.id && !/token|auth|session|password|secret/i.test(el.id)) return `${tag}#${String(el.id).replace(/[^\w-]/g, '').slice(0, 60)}`;
    const testId = el.getAttribute?.('data-testid');
    if (testId && !/token|auth|session|password|secret/i.test(testId)) return `${tag}[data-testid="${String(testId).slice(0, 80)}"]`;
    const cls = [...el.classList].filter(x => !/token|auth|session|password|secret/i.test(x)).slice(0, 2).join('.');
    return cls ? `${tag}.${cls}` : tag;
  };

  function readDom() {
    const amount = best('amount');
    const timeframe = best('timeframe');
    const expiration = best('expiration');
    const amountValue = amount ? num(textOf(amount.el)) : null;
    const timeframeValue = timeframe ? normTf(textOf(timeframe.el)) : null;
    const expirationValue = expiration ? normExp(textOf(expiration.el)) : null;
    return {
      amount: amountValue,
      timeframe: timeframeValue,
      expiration: expirationValue,
      detected: { amount: amountValue != null, timeframe: !!timeframeValue, expiration: !!expirationValue },
      confidence: { amount: amount?.score || 0, timeframe: timeframe?.score || 0, expiration: expiration?.score || 0 },
      hints: { amount: selectorHint(amount?.el), timeframe: selectorHint(timeframe?.el), expiration: selectorHint(expiration?.el) },
      sources: { amount: amountValue != null ? 'dom' : null, timeframe: timeframeValue ? 'dom' : null, expiration: expirationValue ? 'dom' : null },
      at: Date.now()
    };
  }

  async function read() {
    const observed = readDom();
    if (observed.timeframe && observed.expiration) return observed;
    const state = await chrome.runtime.sendMessage({ type: 'ATS_GET_STATE' }).catch(() => null);
    if (!state || state.platformId !== 'casatrade' || state.connection !== 'online') return observed;
    if (!observed.timeframe) {
      const timeframe = normTf(state.timeframe);
      if (timeframe) {
        observed.timeframe = timeframe;
        observed.detected.timeframe = true;
        observed.sources.timeframe = 'capture';
      }
    }
    if (!observed.expiration) {
      const expiration = normExp(state.expiration);
      if (expiration) {
        observed.expiration = expiration;
        observed.detected.expiration = true;
        observed.sources.expiration = 'capture';
      }
    }
    observed.at = Date.now();
    return observed;
  }

  const fire = el => { for (const type of ['input', 'change', 'blur']) el.dispatchEvent(new Event(type, { bubbles: true })); };
  const setAmount = (el, value) => {
    if (!el) return false;
    const formatted = String(Number(value)).replace('.', ',');
    if (el instanceof HTMLInputElement) {
      const proto = Object.getPrototypeOf(el);
      const desc = Object.getOwnPropertyDescriptor(proto, 'value') || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
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
  const distance = (a, b) => {
    const x = a.getBoundingClientRect(), y = b.getBoundingClientRect();
    return Math.hypot((x.left + x.width / 2) - (y.left + y.width / 2), (x.top + x.height / 2) - (y.top + y.height / 2));
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
    control.click();
    await wait(180);
    const candidates = [...document.querySelectorAll('[role="option"],[role="menuitem"],li,button,[data-value],div,span')]
      .filter(el => visible(el) && el !== control)
      .filter(el => short(el.innerText || el.textContent || el.getAttribute?.('data-value') || '', 50).length <= 50)
      .filter(el => normalize(textOf(el)) === target)
      .filter(el => !excludeFinancialAction(context(el)))
      .sort((a, b) => distance(control, a) - distance(control, b));
    const option = candidates[0];
    if (!option) {
      document.body.click();
      return false;
    }
    option.click();
    await wait(160);
    return true;
  }

  async function apply(prefs = {}) {
    const desired = {
      amount: num(prefs.tradeAmount ?? prefs.stake),
      timeframe: normTf(prefs.timeframe),
      expiration: normExp(prefs.expiration)
    };
    const result = { attempted: {}, applied: {}, desired, before: await read() };
    if (desired.amount != null && desired.amount > 0) {
      const c = best('amount');
      result.attempted.amount = !!c;
      const current = c ? num(textOf(c.el)) : null;
      result.applied.amount = !!c && (current === desired.amount || setAmount(c.el, desired.amount));
    }
    if (desired.timeframe) {
      const c = best('timeframe');
      result.attempted.timeframe = !!c;
      result.applied.timeframe = !!c && await setChoice('timeframe', c.el, desired.timeframe);
    }
    if (desired.expiration) {
      const c = best('expiration');
      result.attempted.expiration = !!c;
      result.applied.expiration = !!c && await setChoice('expiration', c.el, desired.expiration);
    }
    await wait(260);
    result.after = await read();
    result.matched = {
      amount: desired.amount != null && result.after.amount != null ? Math.abs(result.after.amount - desired.amount) < 0.000001 : false,
      timeframe: !!desired.timeframe && result.after.timeframe === desired.timeframe,
      expiration: !!desired.expiration && result.after.expiration === desired.expiration
    };
    result.ok = !!(result.matched.amount && result.matched.timeframe && result.matched.expiration);
    return result;
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'ATS_PLATFORM_READ') {
      read().then(observed => sendResponse({ ok: true, observed })).catch(e => sendResponse({ ok: false, error: String(e?.message || e) }));
      return true;
    }
    if (message?.type === 'ATS_PLATFORM_APPLY') {
      apply(message.preferences || {}).then(x => sendResponse({ ok: x.ok, ...x })).catch(async e => sendResponse({ ok: false, error: String(e?.message || e), observed: await read() }));
      return true;
    }
  });
})();