(() => {
  if (globalThis.__ATS_TRADE_HANDOFF__) return;
  globalThis.__ATS_TRADE_HANDOFF__ = true;

  const visible = el => {
    if (!el || !(el instanceof Element)) return false;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 24 && r.height > 18 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity || 1) > 0;
  };
  const clean = value => String(value || '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
  const tokens = {
    BUY: ['comprar','compra','buy','call','alta','higher','up'],
    SELL: ['vender','venda','sell','put','baixa','lower','down']
  };

  function score(el, direction) {
    const text = clean([el.textContent, el.getAttribute?.('aria-label'), el.getAttribute?.('title'), el.getAttribute?.('data-testid'), el.getAttribute?.('name')].filter(Boolean).join(' '));
    let points = 0;
    for (const token of tokens[direction] || []) if (text.includes(token)) points += token.length >= 5 ? 5 : 3;
    const opposite = direction === 'BUY' ? 'SELL' : 'BUY';
    for (const token of tokens[opposite] || []) if (text.includes(token)) points -= token.length >= 5 ? 6 : 4;
    if (el.matches('button,[role="button"],input[type="button"],input[type="submit"]')) points += 3;
    if (el.matches(':disabled,[aria-disabled="true"]')) points -= 8;
    if (/ats-|scanner/i.test(String(el.id || '') + ' ' + String(el.className || ''))) points -= 10;
    return points;
  }

  function clear() {
    document.querySelectorAll('[data-ats-trade-target]').forEach(el => {
      el.removeAttribute('data-ats-trade-target');
      el.style.removeProperty('outline');
      el.style.removeProperty('outline-offset');
      el.style.removeProperty('box-shadow');
      el.style.removeProperty('scroll-margin');
    });
    document.getElementById('ats-trade-handoff-toast')?.remove();
  }

  function toast(message, target, ambiguous = false) {
    const direction = String(message.direction || '').toUpperCase();
    const buy = direction === 'BUY';
    const el = document.createElement('div');
    el.id = 'ats-trade-handoff-toast';
    Object.assign(el.style, {
      position: 'fixed', zIndex: '2147483647', top: '18px', left: '50%', transform: 'translateX(-50%)',
      minWidth: '260px', maxWidth: '430px', padding: '13px 15px', borderRadius: '14px',
      background: 'rgba(7,12,21,.98)', border: `1px solid ${buy ? 'rgba(79,224,165,.45)' : 'rgba(255,108,134,.45)'}`,
      boxShadow: '0 18px 48px rgba(0,0,0,.55)', color: '#fff', font: '600 12px system-ui', pointerEvents: 'none'
    });
    const title = document.createElement('div');
    title.style.cssText = `font-weight:900;font-size:13px;color:${buy ? '#79eabb' : '#ff99aa'};margin-bottom:5px`;
    title.textContent = `ATS • ${buy ? 'COMPRA' : 'VENDA'} PRONTA PARA CONFIRMAR`;
    const meta = document.createElement('div');
    meta.style.cssText = 'color:#aeb9c9;font-size:11px;line-height:1.55';
    meta.textContent = [message.asset, message.timeframe, message.expiration ? `exp. ${message.expiration}` : null, Number.isFinite(Number(message.score)) ? `força ${Math.round(Number(message.score))}/100` : null].filter(Boolean).join(' • ');
    const hint = document.createElement('div');
    hint.style.cssText = 'color:#8799aa;font-size:10px;margin-top:6px';
    hint.textContent = target
      ? 'Botão da CasaTrade localizado e destacado. Toque nele para confirmar a operação.'
      : ambiguous
        ? 'Encontrei mais de um botão possível e não vou adivinhar. Confirme diretamente na plataforma.'
        : 'Não localizei o botão da CasaTrade com segurança. Confirme diretamente na plataforma.';
    el.append(title, meta, hint);
    document.documentElement.appendChild(el);
    setTimeout(() => el.remove(), 6000);
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== 'ATS_HIGHLIGHT_TRADE') return false;
    clear();
    const direction = String(message.direction || '').toUpperCase();
    if (!['BUY','SELL'].includes(direction)) { sendResponse({ ok: false, error: 'invalid_direction' }); return false; }
    const elements = [...document.querySelectorAll('button,[role="button"],input[type="button"],input[type="submit"],a')].filter(visible);
    const ranked = elements.map(el => ({ el, score: score(el, direction) })).filter(item => item.score >= 6).sort((a,b) => b.score - a.score);
    const top = ranked[0] || null;
    const second = ranked[1] || null;
    const ambiguous = !!(top && second && top.score - second.score < 2);
    const target = top && !ambiguous ? top.el : null;
    if (target) {
      target.setAttribute('data-ats-trade-target', direction);
      target.style.outline = direction === 'BUY' ? '3px solid #33e89b' : '3px solid #ff6178';
      target.style.outlineOffset = '4px';
      target.style.boxShadow = direction === 'BUY' ? '0 0 30px rgba(51,232,155,.60)' : '0 0 30px rgba(255,97,120,.60)';
      target.style.scrollMargin = '120px';
      target.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
    }
    toast(message, target, ambiguous);
    sendResponse({ ok: true, found: !!target, ambiguous, label: target ? clean(target.textContent || target.getAttribute?.('aria-label') || '').slice(0,80) : null });
    return true;
  });
})();
