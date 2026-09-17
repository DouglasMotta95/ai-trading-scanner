(() => {
  if (globalThis.__ATS_CONTROLS_OBSERVER__) return;
  globalThis.__ATS_CONTROLS_OBSERVER__ = true;

  const protocol = String(location.protocol || '').toLowerCase();
  const opaqueChild = window !== window.top && (!location.hostname || ['about:','blob:','data:'].includes(protocol));
  const directSend = message => {
    const fn = globalThis.__ATS_SEND_MESSAGE__;
    if (typeof fn === 'function') return fn(message);
    return new Promise(resolve => {
      let tries = 0;
      const retry = () => {
        const current = globalThis.__ATS_SEND_MESSAGE__;
        if (typeof current === 'function') current(message).then(resolve).catch(() => resolve(null));
        else if (++tries < 60) setTimeout(retry, 50);
        else resolve(null);
      };
      retry();
    });
  };
  const send = message => opaqueChild
    ? directSend({ type: 'ATS_OPAQUE_FRAME_PROXY', payload: message })
    : directSend(message);

  const clean = value => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  const visible = element => {
    if (!(element instanceof Element)) return false;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 6 && rect.height > 6 && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0;
  };

  let cache = [], cacheAt = 0;
  function nodes(limit = 6500) {
    const now = Date.now();
    if (cache.length && now - cacheAt < 250) return cache.slice(0, limit);
    const out = [], roots = [document], seen = new Set();
    while (roots.length && out.length < 7000) {
      const root = roots.shift();
      if (!root || seen.has(root)) continue;
      seen.add(root);
      let rows = [];
      try { rows = [...root.querySelectorAll('*')]; } catch {}
      for (const element of rows) {
        if (visible(element)) out.push(element);
        if (element.shadowRoot) roots.push(element.shadowRoot);
        if (out.length >= 7000) break;
      }
    }
    cache = out;
    cacheAt = now;
    return out.slice(0, limit);
  }

  const attrs = element => clean([
    element?.getAttribute?.('aria-label'),
    element?.getAttribute?.('aria-valuetext'),
    element?.getAttribute?.('title'),
    element?.getAttribute?.('name'),
    element?.getAttribute?.('placeholder'),
    element?.getAttribute?.('data-testid'),
    element?.innerText,
    element?.textContent
  ].filter(Boolean).join(' ')).slice(0, 260);

  const parentText = element => {
    const parts = [];
    let node = element;
    for (let i = 0; node && i < 4; i += 1, node = node.parentElement) {
      const value = attrs(node);
      if (value) parts.push(value);
    }
    return clean(parts.join(' ')).slice(0, 520);
  };

  const parseTf = value => {
    const text = clean(value);
    let match = text.match(/(?:^|\b)(\d{1,3})\s*(?:m|min|minuto|minutos)(?:\b|$)/i);
    if (match) return `M${Number(match[1])}`;
    match = text.match(/(?:^|\b)(\d{1,3})\s*(?:h|hora|horas)(?:\b|$)/i);
    if (match) return `H${Number(match[1])}`;
    match = text.match(/(?:^|\b)(\d{1,4})\s*(?:s|seg|segundo|segundos)(?:\b|$)/i);
    return match ? `S${Number(match[1])}` : null;
  };

  const parseExp = value => {
    const text = clean(value);
    let match = text.match(/(?:^|\b)(\d{1,5})\s*(?:s|seg|segundo|segundos)(?:\b|$)/i);
    if (match) return `${Number(match[1])}s`;
    match = text.match(/(?:^|\b)(\d{1,4})\s*(?:m|min|minuto|minutos)(?:\b|$)/i);
    if (match) return `${Number(match[1]) * 60}s`;
    match = text.match(/\b(\d{1,2}):(\d{2})\b/);
    return match ? `${Number(match[1]) * 60 + Number(match[2])}s` : null;
  };

  const money = value => {
    const normalized = clean(value).replace(/\./g, '').replace(',', '.');
    const match = normalized.match(/(?:R\$|US\$|\$|€|£)?\s*(\d+(?:\.\d+)?)/);
    return match ? Number(match[1]) : null;
  };

  function semanticScore(element, token, context) {
    const rect = element.getBoundingClientRect();
    let score = 20;
    if (element.matches('input,select,[role="combobox"],[role="spinbutton"]')) score += 30;
    if (context.toLowerCase().startsWith(token)) score += 8;
    if (rect.right > innerWidth * .62) score += 8;
    if (/control|trade|order|ticket|panel|sidebar|input|field/.test(context.toLowerCase())) score += 12;
    return score;
  }

  function readNear(tokens, parser) {
    let best = null;
    for (const element of nodes()) {
      const own = attrs(element);
      const context = parentText(element);
      const lower = `${own} ${context}`.toLowerCase();
      const token = tokens.find(item => lower.includes(item));
      if (!token) continue;
      const candidates = [own, context];
      if (element.previousElementSibling) candidates.push(attrs(element.previousElementSibling));
      if (element.nextElementSibling) candidates.push(attrs(element.nextElementSibling));
      let value = null;
      for (const candidate of candidates) {
        value = parser(candidate);
        if (value != null) break;
      }
      if (value == null) continue;
      const score = semanticScore(element, token, context);
      if (!best || score > best.score) best = { value, score };
    }
    return best;
  }

  function selectedTimeframeFallback() {
    let best = null;
    for (const element of nodes()) {
      const own = attrs(element);
      if (!own || own.length > 36) continue;
      const value = parseTf(own);
      if (!value) continue;
      const flags = `${element.getAttribute?.('aria-selected') || ''} ${element.getAttribute?.('aria-current') || ''} ${element.getAttribute?.('data-state') || ''} ${typeof element.className === 'string' ? element.className : ''}`;
      const selected = /true|active|selected|current|checked/i.test(flags);
      const rect = element.getBoundingClientRect();
      let score = selected ? 90 : 10;
      if (rect.left < innerWidth * .25 && rect.top > innerHeight * .25) score += 20;
      if (own.length <= 8) score += 12;
      if (!best || score > best.score) best = { value, score };
    }
    return best;
  }

  let timer = null, last = '', lastSentAt = 0;
  function scan() {
    const timeframe = readNear(['timeframe','período','periodo','gráfico','grafico','vela','candle'], parseTf) || selectedTimeframeFallback();
    const expiration = readNear(['expira','expiry','expiration','duração','duracao','tempo da operação','tempo de operacao'], parseExp);
    const amount = readNear(['valor','amount','stake','invest','entrada'], money);
    const payload = {
      timeframe: timeframe?.value || null,
      expiration: expiration?.value || null,
      amount: amount?.value || null,
      source: 'casatrade-semantic-controls-v2',
      confidence: {
        timeframe: timeframe?.score || 0,
        expiration: expiration?.score || 0,
        amount: amount?.score || 0
      }
    };
    const signature = JSON.stringify(payload);
    const now = Date.now();
    if (signature !== last || now - lastSentAt > 1800) {
      last = signature;
      lastSentAt = now;
      send({ type: 'ATS_PLATFORM_CONTROLS_OBSERVED', snapshot: payload }).catch(() => {});
    }
  }

  function schedule(delay = 100) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; cacheAt = 0; scan(); }, delay);
  }

  new MutationObserver(() => schedule()).observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    characterData: true
  });
  for (const event of ['click','input','change','pointerup']) document.addEventListener(event, () => schedule(60), true);
  scan();
  setTimeout(scan, 350);
  setTimeout(scan, 900);
  setTimeout(scan, 1600);
  setTimeout(function heartbeat() { cacheAt = 0; scan(); setTimeout(heartbeat, 1600); }, 1600);
})();
