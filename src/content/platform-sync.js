(() => {
  if (globalThis.__ATS_PLATFORM_SYNC__) return;
  globalThis.__ATS_PLATFORM_SYNC__ = true;

  const CASATRADE_HOSTS = new Set([
    'casatrade.com','www.casatrade.com','app.casatrade.com','trade.casatrade.com',
    'casatrade.io','www.casatrade.io','app.casatrade.io','trade.casatrade.io'
  ]);
  const host = String(location.hostname || '').toLowerCase().replace(/\.$/, '');
  if (!CASATRADE_HOSTS.has(host)) return;

  const clean = v => String(v ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  const fold = v => clean(v).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
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
    for (let i = 0; i < 2 && p; i++, p = p.parentElement) parts.push(clean(p.innerText || p.textContent || '').slice(0, 180));
    return fold(parts.join(' '));
  };
  const financialAction = el => /comprar|vender|buy|sell|depositar|saque|retirar/.test(ownContext(el));
  const distance = (a, b) => {
    const x = a.getBoundingClientRect(), y = b.getBoundingClientRect();
    return Math.hypot((x.left + x.width / 2) - (y.left + y.width / 2), (x.top + x.height / 2) - (y.top + y.height / 2));
  };

  const labelsFor = kind => {
    const pattern = kind === 'amount' ? /^(valor|amount|stake|investimento|investment)$/
      : kind === 'timeframe' ? /^(vela|timeframe|periodo|periodo da vela|candle)$/
        : /^(expiracao|expiry|expiration|duracao|duration)$/;
    return [...document.querySelectorAll('label,span,div,p,strong,b')]
      .filter(visible)
      .filter(el => {
        const t = fold(textOf(el));
        return t.length <= 40 && pattern.test(t);
      })
      .slice(0, 40);
  };
  const candidateNodes = () => [...document.querySelectorAll([
    'input','select','button','[role="button"]','[role="combobox"]','[role="spinbutton"]','[contenteditable="true"]',
    '[aria-label]','[data-testid]','span','div','p','strong','b'
  ].join(','))].filter(visible).slice(0, 7000);

  function parsed(kind, el) {
    const text = clean(textOf(el));
    if (!text || text.length > 80 || financialAction(el)) return null;
    if (kind === 'amount') {
      if (/%/.test(text)) return null;
      const n = num(text);
      return n != null && n > 0 && n <= 100000000 ? n : null;
    }
    if (kind === 'timeframe') return normTf(text);
    return normExp(text.match(/\d{1,4}\s*(?:s|seg|segundo|segundos|m|min|minuto|minutos)/i)?.[0] || text);
  }
  function score(kind, el, value, labels) {
    const own = ownContext(el);
    const local = localContext(el);
    let s = 0;
    if (kind === 'amount') {
      if (/\bvalor\b|amount|stake|investimento|investment/.test(own)) s += 55;
      if (/\bvalor\b|amount|stake|investimento|investment/.test(local)) s += 30;
      if (el instanceof HTMLInputElement) s += 18;
      if (/saldo|lucro|profit|retorno|payout/.test(local)) s -= 35;
      if (Number(value) >= 1) s += 5;
    } else if (kind === 'timeframe') {
      if (/vela|timeframe|candle|periodo/.test(own)) s += 45;
      if (/vela|timeframe|candle|periodo/.test(local)) s += 20;
      if (el.getAttribute?.('aria-selected') === 'true' || /active|selected|current/i.test(String(el.className || ''))) s += 45;
      const r = el.getBoundingClientRect();
      if (r.left < innerWidth * .4) s += 12;
      if (/expira|expiry|duration/.test(local)) s -= 25;
    } else {
      if (/expira|expiry|expiration|duracao|duration/.test(own)) s += 55;
      if (/expira|expiry|expiration|duracao|duration/.test(local)) s += 30;
      if (/vela|timeframe|candle/.test(local)) s -= 20;
    }
    if (labels.length) {
      const d = Math.min(...labels.map(label => distance(label, el)));
      if (d < 50) s += 55;
      else if (d < 120) s += 35;
      else if (d < 220) s += 15;
    }
    return s;
  }
  function best(kind) {
    const labels = labelsFor(kind);
    const rows = [];
    for (const el of candidateNodes()) {
      const value = parsed(kind, el);
      if (value == null || value === '') continue;
      const s = score(kind, el, value, labels);
      if (s >= 20) rows.push({ el, value, score: s });
    }
    rows.sort((a, b) => b.score - a.score);
    return rows[0] || null;
  }

  function readDom() {
    const amount = best('amount');
    const timeframe = best('timeframe');
    const expiration = best('expiration');
    return {
      amount: amount?.value ?? null,
      timeframe: timeframe?.value || null,
      expiration: expiration?.value || null,
      detected: { amount: amount?.value != null, timeframe: !!timeframe?.value, expiration: !!expiration?.value },
      confidence: { amount: amount?.score || 0, timeframe: timeframe?.score || 0, expiration: expiration?.score || 0 },
      sources: { amount: amount ? 'dom' : null, timeframe: timeframe ? 'dom' : null, expiration: expiration ? 'dom' : null },
      at: Date.now()
    };
  }

  async function read() {
    const observed = readDom();
    const state = await chrome.runtime.sendMessage({ type: 'ATS_GET_STATE' }).catch(() => null);
    if (!state || state.platformId !== 'casatrade' || state.connection !== 'online') return observed;
    if (!observed.timeframe) {
      const tf = normTf(state.timeframe);
      if (tf) { observed.timeframe = tf; observed.detected.timeframe = true; observed.sources.timeframe = 'capture'; }
    }
    if (!observed.expiration) {
      const exp = normExp(state.expiration);
      if (exp) { observed.expiration = exp; observed.detected.expiration = true; observed.sources.expiration = 'capture'; }
    }
    observed.at = Date.now();
    return observed;
  }

  const fire = el => { for (const type of ['input','change','blur']) el.dispatchEvent(new Event(type, { bubbles: true })); };
  const setAmount = (el, value) => {
    if (!el) return false;
    const formatted = String(Number(value)).replace('.', ',');
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
    const options = [...document.querySelectorAll('[role="option"],[role="menuitem"],li,button,[data-value],div,span')]
      .filter(el => visible(el) && el !== control && !financialAction(el))
      .filter(el => normalize(textOf(el)) === target)
      .sort((a, b) => distance(control, a) - distance(control, b));
    if (!options[0]) return false;
    options[0].click();
    await wait(160);
    return true;
  }

  async function apply(prefs = {}) {
    const desired = {
      amount: num(prefs.tradeAmount ?? prefs.stake),
      timeframe: normTf(prefs.timeframe),
      expiration: normExp(prefs.expiration)
    };
    const before = await read();
    const attempted = {}, applied = {};
    if (desired.amount != null && desired.amount > 0) {
      const c = best('amount');
      attempted.amount = !!c;
      applied.amount = !!c && (Number(c.value) === desired.amount || setAmount(c.el, desired.amount));
    }
    if (desired.timeframe) {
      const c = best('timeframe');
      attempted.timeframe = !!c;
      applied.timeframe = !!c && await setChoice('timeframe', c.el, desired.timeframe);
    }
    if (desired.expiration) {
      const c = best('expiration');
      attempted.expiration = !!c;
      applied.expiration = !!c && await setChoice('expiration', c.el, desired.expiration);
    }
    await wait(250);
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
      read().then(observed => sendResponse({ ok: true, observed })).catch(e => sendResponse({ ok: false, error: String(e?.message || e) }));
      return true;
    }
    if (message?.type === 'ATS_PLATFORM_APPLY') {
      apply(message.preferences || {}).then(result => sendResponse(result)).catch(async e => sendResponse({ ok: false, error: String(e?.message || e), observed: await read() }));
      return true;
    }
  });
})();