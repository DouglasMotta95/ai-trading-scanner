(() => {
  // This probe is intentionally restartable. Re-injection must replace the
  // current reader instead of silently keeping stale readers from an older build.
  try { globalThis.__ATS_EXPIRATION_PROBE_RUNTIME__?.teardown?.(); } catch {}
  globalThis.__ATS_EXPIRATION_PROBE__ = true;

  const sendMessage = typeof globalThis.__ATS_SEND_MESSAGE__ === 'function'
    ? globalThis.__ATS_SEND_MESSAGE__
    : message => new Promise(resolve => {
        try {
          chrome.runtime.sendMessage(message, response => {
            try { void chrome.runtime.lastError; } catch {}
            resolve(response || null);
          });
        } catch { resolve(null); }
      });

  const clean = value => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  const fold = value => clean(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const expirationSemantics = /\b(?:expiracao|expiry|expiration|tempo de expiracao|tempo da operacao|tempo de operacao|duracao|duration)\b/;
  const durationExact = /^(?:\d{1,2}:[0-5]\d:[0-5]\d|\d{1,3}:[0-5]\d|\d{1,4}\s*(?:s|seg|segundo|segundos|m|min|minuto|minutos))$/i;

  function visible(el) {
    if (!el || !(el instanceof Element)) return false;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity || 1) > 0;
  }

  function roots() {
    const out = [document], queue = [document], seen = new Set();
    while (queue.length && out.length < 100) {
      const root = queue.shift();
      if (!root || seen.has(root)) continue;
      seen.add(root);
      let rows = [];
      try { rows = [...root.querySelectorAll('*')]; } catch {}
      for (const el of rows) {
        if (el.shadowRoot && !seen.has(el.shadowRoot)) {
          out.push(el.shadowRoot);
          queue.push(el.shadowRoot);
        }
      }
    }
    return out;
  }

  function elements() {
    const out = [];
    const selector = [
      'button','input','select','option','label','p','strong','small','span','div','svg text',
      '[role="button"]','[role="combobox"]','[role="option"]','[role="listbox"]',
      '[aria-selected]','[aria-current]','[data-state]','[data-value]','[aria-valuetext]','[aria-valuenow]',
      '[data-testid*="expir" i]','[aria-label*="expir" i]','[name*="expir" i]',
      '[id*="expir" i]','[class*="expir" i]'
    ].join(',');
    for (const root of roots()) {
      try { out.push(...root.querySelectorAll(selector)); } catch {}
      if (out.length > 12000) break;
    }
    return [...new Set(out)].slice(0, 12000);
  }

  function ownText(el) {
    if (!el) return '';
    if (el instanceof HTMLInputElement) return clean(el.value || el.getAttribute?.('aria-valuetext') || el.getAttribute?.('data-value') || '');
    if (el instanceof HTMLSelectElement) return clean(el.selectedOptions?.[0]?.textContent || el.value || '');
    return clean(el.innerText || el.textContent || '');
  }

  function rawValues(el) {
    if (!el) return [];
    return [
      el instanceof HTMLInputElement ? el.value : '',
      el instanceof HTMLSelectElement ? el.selectedOptions?.[0]?.textContent : '',
      el.getAttribute?.('aria-valuetext'),
      el.getAttribute?.('data-value'),
      el.getAttribute?.('value'),
      el.getAttribute?.('aria-valuenow'),
      ownText(el)
    ].map(clean).filter(Boolean);
  }

  function parseExpiration(raw = '') {
    const spaced = fold(raw);
    if (!spaced) return null;

    const labeled = spaced.match(/(?:expiracao|expiry|expiration|tempo de expiracao|tempo da operacao|tempo de operacao|duracao|duration)[^0-9]{0,80}(\d{1,4})\s*(s|seg|segundo|segundos|m|min|minuto|minutos)\b/);
    if (labeled) {
      const amount = Number(labeled[1]);
      return /^(m|min|minuto|minutos)$/.test(labeled[2]) ? `${amount * 60}s` : `${amount}s`;
    }

    // Responsive layouts can reverse DOM/text order even when the visual card
    // still reads "Expiração 1 min". Accept a duration immediately before the
    // explicit expiration label, but never infer a default duration.
    const reversed = spaced.match(/(\d{1,4})\s*(s|seg|segundo|segundos|m|min|minuto|minutos)\b[^0-9]{0,80}(?:expiracao|expiry|expiration|tempo de expiracao)/);
    if (reversed) {
      const amount = Number(reversed[1]);
      return /^(m|min|minuto|minutos)$/.test(reversed[2]) ? `${amount * 60}s` : `${amount}s`;
    }

    const s = spaced.replace(/\s+/g, '');
    let m = s.match(/^(\d{1,4})(?:s|seg|segundo|segundos)$/); if (m) return `${Number(m[1])}s`;
    m = s.match(/^(\d{1,3})(?:m|min|minuto|minutos)$/); if (m) return `${Number(m[1]) * 60}s`;
    m = s.match(/^(\d{1,3}):([0-5]\d)$/); if (m) return `${Number(m[1]) * 60 + Number(m[2])}s`;
    m = s.match(/^(\d{1,2}):([0-5]\d):([0-5]\d)$/);
    if (m) return `${Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])}s`;
    m = s.match(/^(\d{1,3})(?:m|min)(\d{1,2})(?:s|seg)$/);
    if (m) return `${Number(m[1]) * 60 + Number(m[2])}s`;
    return null;
  }

  function directDuration(el) {
    for (const raw of rawValues(el)) {
      if (raw.length <= 40 && durationExact.test(raw)) {
        const parsed = parseExpiration(raw);
        if (parsed) return parsed;
      }
    }
    return null;
  }

  function semanticText(el) {
    if (!el) return '';
    const parts = [
      ownText(el), el.id, el.className, el.getAttribute?.('data-testid'), el.getAttribute?.('data-name'),
      el.getAttribute?.('name'), el.getAttribute?.('aria-label'), el.getAttribute?.('title'),
      el.getAttribute?.('role'), el.getAttribute?.('data-state')
    ];
    return fold(parts.filter(Boolean).join(' '));
  }

  function isExpirationLabel(el) {
    if (!visible(el)) return false;
    const own = fold(ownText(el) || el.getAttribute?.('aria-label') || '');
    if (!own || own.length > 90) return false;
    return /^(?:expiracao|expiry|expiration)$/.test(own)
      || /^(?:tempo de expiracao|expiration time)$/.test(own);
  }

  function selectedLike(el) {
    const flags = fold([
      el?.getAttribute?.('aria-selected'),
      el?.getAttribute?.('aria-current'),
      el?.getAttribute?.('data-state'),
      el?.getAttribute?.('data-active'),
      el?.className
    ].filter(Boolean).join(' '));
    return /\b(?:true|active|selected|current|checked|open)\b/.test(flags);
  }

  function controlLike(el) {
    return !!el?.matches?.('button,input,select,[role="button"],[role="combobox"],[aria-haspopup],[data-state]');
  }

  function expirationControlByLabel(all = []) {
    const labels = all.filter(isExpirationLabel);
    if (!labels.length) return null;
    const durationNodes = all
      .filter(el => visible(el))
      .map(el => ({ el, value: directDuration(el) }))
      .filter(row => row.value);

    const candidates = [];
    for (const label of labels) {
      const labelOwn = fold(ownText(label) || label.getAttribute?.('aria-label') || '');
      const strongLabel = /^(?:expiracao|expiry|expiration)$/.test(labelOwn);
      const lr = label.getBoundingClientRect();

      // Accessibility/custom controls sometimes carry the value on the same
      // element as the expiration label.
      const direct = directDuration(label);
      if (direct) candidates.push({ value: direct, score: strongLabel ? 420 : 350, reason: 'label-direct' });

      // Prefer exact duration tokens physically attached to the visible
      // "Expiração" card. This avoids choosing arbitrary entries from an open
      // dropdown ("5 seg", "10 seg", "1 min", ...).
      for (const row of durationNodes) {
        const el = row.el;
        if (el === label) continue;
        const r = el.getBoundingClientRect();
        const vertical = Math.abs((r.top + r.bottom) / 2 - (lr.top + lr.bottom) / 2);
        const below = r.top >= lr.top - 8 && r.top - lr.bottom <= 120;
        const horizontalGap = r.right < lr.left ? lr.left - r.right : r.left > lr.right ? r.left - lr.right : 0;
        if (vertical > 150 || horizontalGap > 560) continue;

        let sameContainer = false;
        let p = label.parentElement;
        for (let depth = 0; p && depth < 5; depth += 1, p = p.parentElement) {
          if (p === el.parentElement || p.contains?.(el)) { sameContainer = true; break; }
        }

        const role = fold(el.getAttribute?.('role') || '');
        const explicitlyUnselected = el.getAttribute?.('aria-selected') === 'false';
        let score = strongLabel ? 300 : 225;
        score += sameContainer ? 105 : 0;
        score += below ? 55 : 0;
        score += controlLike(el) ? 35 : 0;
        score += selectedLike(el) ? 70 : 0;
        if (role === 'option' && !selectedLike(el)) score -= 110;
        if (explicitlyUnselected) score -= 150;
        score -= Math.min(150, horizontalGap / 5 + vertical / 3);
        candidates.push({ value: row.value, score, reason: 'label-geometry' });
      }

      // Walk the nearest containers and accept only a single unambiguous
      // duration. A dropdown containing many options is deliberately rejected.
      let parent = label.parentElement;
      for (let depth = 0; parent && depth < 6; depth += 1, parent = parent.parentElement) {
        let descendants = [];
        try { descendants = [...parent.querySelectorAll('button,input,select,option,[role="button"],[role="combobox"],[role="option"],span,div,strong,p')].slice(0, 240); } catch {}
        const values = descendants
          .filter(visible)
          .map(directDuration)
          .filter(Boolean);
        const unique = [...new Set(values)];
        if (unique.length === 1) {
          candidates.push({ value: unique[0], score: (strongLabel ? 360 : 280) - depth * 14, reason: 'single-value-container' });
          break;
        }
      }
    }

    candidates.sort((a, b) => b.score - a.score);
    return candidates[0]?.score >= 170 ? candidates[0] : null;
  }

  function semanticControlExpiration(all = []) {
    const candidates = [];
    for (const el of all) {
      if (!visible(el)) continue;
      const meta = semanticText(el);
      if (!expirationSemantics.test(meta)) continue;
      const own = rawValues(el);
      for (const raw of own) {
        const parsed = directDuration({
          matches: () => false,
          getAttribute: name => name === 'data-value' ? raw : null
        });
        if (parsed) {
          candidates.push({ value: parsed, score: controlLike(el) ? 260 : 210, reason: 'semantic-control' });
          continue;
        }
        const numeric = String(raw).trim().match(/^\d{1,4}$/);
        if (numeric) {
          const seconds = Number(numeric[0]);
          if (seconds > 0 && seconds <= 3600) {
            candidates.push({ value: `${seconds}s`, score: controlLike(el) ? 245 : 195, reason: 'semantic-numeric-seconds' });
          }
        }
      }
      const combined = clean(el.innerText || el.textContent || '');
      if (combined && combined.length < 220) {
        const parsed = parseExpiration(combined);
        if (parsed) candidates.push({ value: parsed, score: controlLike(el) ? 255 : 205, reason: 'semantic-text' });
      }
    }
    candidates.sort((a, b) => b.score - a.score);
    return candidates[0] || null;
  }

  function bodyExpiration() {
    const rawBodies = [document.body?.innerText || '', document.body?.textContent || ''];
    const found = [];
    for (const rawBody of rawBodies) {
      const body = fold(clean(rawBody).slice(0, 1200000));
      if (!body) continue;
      const markerRe = /(?:expiracao|expiry|expiration)/g;
      let marker;
      let attempts = 0;
      while ((marker = markerRe.exec(body)) && attempts++ < 80) {
        const from = Math.max(0, marker.index - 120);
        const to = Math.min(body.length, marker.index + 220);
        const around = body.slice(from, to);
        const parsed = parseExpiration(around);
        if (parsed) found.push(parsed);
      }
    }
    const unique = [...new Set(found)];
    if (unique.length === 1) return { value: unique[0], score: 205, reason: 'body-explicit-unique' };
    return null;
  }

  function timeframeValue(raw = '') {
    const s = clean(raw).toUpperCase().replace(/\s+/g, '');
    let m = s.match(/^M(\d{1,3})$/) || s.match(/^(\d{1,3})M$/); if (m && Number(m[1]) > 0) return `M${m[1]}`;
    m = s.match(/^S(\d{1,5})$/) || s.match(/^(\d{1,5})S$/); if (m && Number(m[1]) > 0) return `S${m[1]}`;
    return null;
  }

  function selectedTimeframe(all = []) {
    const rows = [];
    for (const el of all) {
      if (!visible(el)) continue;
      const own = ownText(el);
      if (!own || own.length > 24) continue;
      const value = timeframeValue(own);
      if (!value) continue;
      const meta = semanticText(el);
      let score = 0;
      if (/timeframe|periodo|period|vela|candle|grafico|gráfico/.test(meta)) score += 70;
      if (selectedLike(el)) score += 60;
      if (controlLike(el)) score += 35;
      if (score >= 70) rows.push({ value, score });
    }
    rows.sort((a, b) => b.score - a.score);
    return rows[0] || null;
  }

  function scan() {
    const all = elements();
    const strong = expirationControlByLabel(all);
    const semantic = strong || semanticControlExpiration(all);
    const body = semantic || bodyExpiration();
    const exp = strong || semantic || body;
    const tf = selectedTimeframe(all);

    if (!exp && !tf) return null;
    return {
      amount: null,
      expiration: exp?.value || null,
      timeframe: tf?.value || null,
      confidence: {
        amount: 0,
        // Strong visual-control evidence intentionally dominates older readers
        // that may still exist in the tab after an unpacked-extension reload.
        expiration: exp ? Math.max(110, Math.min(140, Number(exp.score || 0))) : 0,
        timeframe: tf?.score || 0
      },
      source: 'casatrade-expiration-probe-v3',
      observedAt: Date.now(),
      evidence: exp?.reason || null
    };
  }

  let lastKey = '';
  let lastSentAt = 0;
  let stopped = false;
  let scheduled = 0;

  async function publish(force = false) {
    if (stopped) return;
    const snapshot = scan();
    if (!snapshot) return;
    const key = JSON.stringify([snapshot.expiration, snapshot.timeframe, snapshot.evidence]);
    const now = Date.now();
    if (!force && key === lastKey && now - lastSentAt < 450) return;
    lastKey = key;
    lastSentAt = now;
    globalThis.__ATS_EXPIRATION_PROBE_LAST__ = snapshot;
    await sendMessage({ type: 'ATS_PLATFORM_CONTROLS_OBSERVED', snapshot });
  }

  function schedule(force = false, delay = 40) {
    if (stopped) return;
    if (scheduled) clearTimeout(scheduled);
    scheduled = setTimeout(() => {
      scheduled = 0;
      publish(force).catch(() => {});
    }, delay);
  }

  const observer = new MutationObserver(() => schedule(false, 35));
  try { observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true }); } catch {}

  const clickHandler = () => {
    schedule(true, 45);
    setTimeout(() => publish(true).catch(() => {}), 220);
  };
  document.addEventListener('click', clickHandler, true);

  const intervalId = setInterval(() => publish(true).catch(() => {}), 650);
  globalThis.__ATS_FORCE_EXPIRATION_SCAN__ = () => publish(true);
  globalThis.__ATS_EXPIRATION_PROBE_RUNTIME__ = {
    version: 'expiration-real-v3',
    scan,
    parseExpiration,
    teardown() {
      stopped = true;
      try { observer.disconnect(); } catch {}
      try { document.removeEventListener('click', clickHandler, true); } catch {}
      try { clearInterval(intervalId); } catch {}
      if (scheduled) { try { clearTimeout(scheduled); } catch {} }
    }
  };

  publish(true).catch(() => {});
})();