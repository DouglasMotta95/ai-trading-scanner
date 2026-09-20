(() => {
  if (globalThis.__ATS_CASATRADE_UI_OBSERVER_V2__) return;
  globalThis.__ATS_CASATRADE_UI_OBSERVER_V2__ = true;

  const host = String(location.hostname || '').toLowerCase().replace(/\.$/, '');
  const allowed = value => value === 'casatrade.com' || value.endsWith('.casatrade.com') || value === 'casatrade.io' || value.endsWith('.casatrade.io') || value === 'casatraders.online' || value.endsWith('.casatraders.online') || value === 'ivcasatraders.online' || value.endsWith('.ivcasatraders.online');
  if (!allowed(host)) return;
  const sendMessage = globalThis.__ATS_SEND_MESSAGE__;
  if (typeof sendMessage !== 'function') return;

  const clean = value => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  const fold = value => clean(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const visible = el => {
    if (!el || !(el instanceof Element)) return false;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity || 1) > 0;
  };
  const number = value => {
    let s = clean(value).replace(/\s/g, '').replace(/[^\d,.-]/g, '');
    if (!s) return null;
    if (s.includes(',') && s.includes('.')) s = s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
    else if (s.includes(',')) s = s.replace(',', '.');
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  };
  const currency = value => /R\$/i.test(value) ? 'BRL' : /€/.test(value) ? 'EUR' : /£/.test(value) ? 'GBP' : /\$/.test(value) ? 'USD' : null;
  const moneyRe = /(?:R\$|US\$|\$|€|£)\s*-?\d[\d.,\s]*/;
  const pctRe = /(-?\d{1,3}(?:[.,]\d+)?)\s*%/;

  let cache = [];
  let cacheAt = 0;
  function nodes() {
    const now = Date.now();
    if (cache.length && now - cacheAt < 500) return cache;
    const out = [];
    const roots = [document];
    const seen = new Set();
    while (roots.length && out.length < 6500) {
      const root = roots.shift();
      if (!root || seen.has(root)) continue;
      seen.add(root);
      let list = [];
      try { list = [...root.querySelectorAll('*')]; } catch {}
      for (const el of list) {
        out.push(el);
        if (el.shadowRoot) roots.push(el.shadowRoot);
        if (out.length >= 6500) break;
      }
    }
    cache = out; cacheAt = now;
    return out;
  }

  const text = el => clean(el?.innerText || el?.textContent || el?.getAttribute?.('aria-label') || el?.getAttribute?.('title') || '');
  function neighborhood(el, levels = 2) {
    const parts = [text(el)];
    let node = el?.parentElement;
    for (let i = 0; node && i < levels; i += 1, node = node.parentElement) parts.push(text(node).slice(0, 260));
    return clean(parts.join(' '));
  }

  function balanceCandidate() {
    const rows = [];
    for (const el of nodes()) {
      if (!visible(el)) continue;
      const own = text(el);
      if (!own || own.length > 70) continue;
      const m = own.match(moneyRe);
      if (!m) continue;
      const value = number(m[0]);
      if (value == null || value <= 0 || value > 1e9) continue;
      const r = el.getBoundingClientRect();
      if (r.top > Math.max(250, innerHeight * .26)) continue;
      const ctx = fold(neighborhood(el, 1));
      if (/valor|amount|invest|lucro|profit|retorno|payout|comprar|buy|vender|sell|expira/.test(ctx)) continue;
      let score = 10;
      if (r.left > innerWidth * .35) score += 7;
      if (/depositar|deposit|saldo|balance|conta|wallet/.test(ctx)) score += 10;
      if (currency(m[0])) score += 4;
      rows.push({ value, currency: currency(m[0]) || currency(ctx), score });
    }
    rows.sort((a, b) => b.score - a.score);
    return rows[0] || null;
  }

  function labeledMoney(labelPattern) {
    const rows = [];
    for (const el of nodes()) {
      if (!visible(el)) continue;
      const own = text(el);
      if (!own || own.length > 140) continue;
      const ctx = neighborhood(el, 2);
      if (!labelPattern.test(fold(ctx))) continue;
      const m = ctx.match(moneyRe) || ctx.match(/\b\d{1,9}(?:[.,]\d{1,4})?\b/);
      if (!m) continue;
      const value = number(m[0]);
      if (value == null || value <= 0 || value > 1e9) continue;
      let score = labelPattern.test(fold(own)) ? 18 : 12;
      if (el.matches?.('input,[contenteditable="true"]')) score += 8;
      rows.push({ value, currency: currency(ctx), score });
    }
    rows.sort((a, b) => b.score - a.score);
    return rows[0] || null;
  }

  function payoutCandidate() {
    const rows = [];
    for (const el of nodes()) {
      if (!visible(el)) continue;
      const ctx = neighborhood(el, 2);
      if (!/\blucro\b|\bprofit\b|payout|retorno/.test(fold(ctx))) continue;
      const m = ctx.match(pctRe);
      const value = number(m?.[1]);
      if (value == null || value <= 0 || value > 100) continue;
      rows.push({ value, score: /\blucro\b|\bprofit\b/.test(fold(text(el))) ? 18 : 12 });
    }
    rows.sort((a, b) => b.score - a.score);
    return rows[0] || null;
  }

  function visibleLineExpiration() {
    const raw = String(document.body?.innerText || document.body?.textContent || '').normalize('NFKC');
    const lines = raw.split(/\r?\n/).map(clean).filter(Boolean);
    const duration = value => {
      const m = clean(value).match(/(?:^|[^0-9])(\d{1,4})\s*(s|seg|segundo|segundos|m|min|minuto|minutos)\b/i);
      if (!m) return null;
      const n = Number(m[1]);
      if (!(n > 0)) return null;
      return /^(m|min|minuto|minutos)$/i.test(m[2]) ? `${n * 60}s` : `${n}s`;
    };
    for (let i = 0; i < lines.length; i += 1) {
      const label = fold(lines[i]);
      if (!/^(?:expiracao|expiry|expiration)(?:\s*:)?$/.test(label)) continue;
      const direct = duration(lines[i]);
      if (direct) return { expiration: direct, score: 80, source: 'visible-expiration-line' };
      for (let j = i + 1; j <= Math.min(lines.length - 1, i + 3); j += 1) {
        const value = duration(lines[j]);
        if (value) return { expiration: value, score: 78 - (j - i), source: 'visible-expiration-next-line' };
      }
    }
    // Compact card sometimes renders label and value on one visual line.
    const joined = lines.join(' | ');
    const m = joined.match(/(?:EXPIRA(?:ÇÃO|CAO)|EXPIRY|EXPIRATION)\s*[:| -]*\s*(\d{1,4})\s*(S|SEG|SEGUNDO|SEGUNDOS|M|MIN|MINUTO|MINUTOS)\b/i);
    if (!m) return null;
    const n = Number(m[1]);
    const expiration = /^(M|MIN|MINUTO|MINUTOS)$/i.test(m[2]) ? `${n * 60}s` : `${n}s`;
    return { expiration, score: 76, source: 'visible-expiration-inline' };
  }

  function expirationCandidate() {
    const visibleLine = visibleLineExpiration();
    if (visibleLine) return visibleLine;
    const rows = [];
    for (const el of nodes()) {
      if (!visible(el)) continue;
      const ctx = neighborhood(el, 2);
      if (!/expira|expiry|expiration/.test(fold(ctx))) continue;
      const m = ctx.match(/(?:expira(?:cao|ção)?|expiry|expiration)[^0-9]{0,36}(\d{1,4})\s*(s|seg|segundo|segundos|m|min|minuto|minutos)\b/i)
        || ctx.match(/(\d{1,4})\s*(s|seg|segundo|segundos|m|min|minuto|minutos)\b/i);
      if (!m) continue;
      const n = Number(m[1]);
      if (!(n > 0)) continue;
      const unit = m[2].toLowerCase();
      const expiration = /^(m|min|minuto|minutos)$/.test(unit) ? `${n * 60}s` : `${n}s`;
      rows.push({ expiration, score: /expira|expiry/.test(fold(text(el))) ? 20 : 13 });
    }
    rows.sort((a, b) => b.score - a.score);
    return rows[0] || null;
  }

  function timeframeCandidate() {
    const rows = [];
    for (const el of nodes()) {
      if (!visible(el)) continue;
      const own = clean(text(el));
      const m = own.match(/^M(\d{1,3})$/i) || own.match(/^(\d{1,3})\s*m$/i);
      if (!m || Number(m[1]) <= 0) continue;
      const flags = `${el.className || ''} ${el.getAttribute?.('aria-selected') || ''} ${el.getAttribute?.('aria-current') || ''} ${el.getAttribute?.('data-state') || ''}`;
      const ctx = fold(neighborhood(el, 2));
      if (/chart range|range do grafico|range do gráfico|faixa do grafico|faixa do gráfico|visualizacao|visualização|view range|visible range|zoom|history range|historico visivel|histórico visível/.test(ctx)) continue;
      let score = /true|active|selected|current|checked/i.test(flags) ? 20 : 5;
      if (/periodo da vela|período da vela|candle period|candle interval|timeframe/.test(ctx)) score += 18;
      if (/expira|expiry|expiration|duration/.test(ctx)) score -= 25;
      if (el.getBoundingClientRect().left < innerWidth * .28) score += 3;
      rows.push({ timeframe: `M${Number(m[1])}`, score });
    }
    rows.sort((a, b) => b.score - a.score);
    return rows[0]?.score >= 18 ? rows[0] : null;
  }

  let lastKey = '';
  let lastAt = 0;
  async function scan() {
    cacheAt = 0;
    const balance = balanceCandidate();
    const stake = labeledMoney(/\bvalor\b|amount|invest|stake|entrada/);
    const payout = payoutCandidate();
    const expiration = expirationCandidate();
    const timeframe = timeframeCandidate();
    const snapshot = {
      balance: balance?.value ?? null,
      stake: stake?.value ?? null,
      payoutPct: payout?.value ?? null,
      currency: balance?.currency || stake?.currency || null,
      confidence: { balance: balance?.score || 0, stake: stake?.score || 0, payout: payout?.score || 0 },
      source: 'casatrade-layout-v2', observedAt: Date.now()
    };
    const controls = {
      amount: stake?.value ?? null,
      expiration: expiration?.expiration || null,
      timeframe: timeframe?.timeframe || null,
      confidence: { amount: stake?.score || 0, expiration: expiration?.score || 0, timeframe: timeframe?.score || 0 },
      source: 'casatrade-layout-v2', observedAt: Date.now()
    };
    const key = JSON.stringify([snapshot.balance, snapshot.stake, snapshot.payoutPct, controls.expiration, controls.timeframe]);
    const now = Date.now();
    if (key === lastKey && now - lastAt < 1800) return;
    lastKey = key; lastAt = now;
    if (snapshot.balance != null || snapshot.stake != null || snapshot.payoutPct != null) await sendMessage({ type: 'ATS_ACCOUNT_METRICS', snapshot });
    if (controls.amount != null || controls.expiration || controls.timeframe) await sendMessage({ type: 'ATS_PLATFORM_CONTROLS_OBSERVED', snapshot: controls });
  }

  let timer = 0;
  const schedule = delay => {
    if (timer) return;
    timer = setTimeout(() => { timer = 0; scan().catch(() => {}); }, delay);
  };
  new MutationObserver(() => schedule(140)).observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });
  document.addEventListener('input', () => schedule(20), true);
  document.addEventListener('click', () => schedule(60), true);
  setInterval(() => schedule(0), 1200);
  schedule(120);
})();
