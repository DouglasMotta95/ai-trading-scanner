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

  const EXPIRATION_DIAG_STORAGE_KEY = 'atsExpirationProbeDiagnosticsV1';
  const expirationProbeDiag = globalThis.__ATS_EXPIRATION_PROBE_DIAGNOSTICS__ || {
    version: 1,
    instanceId: (globalThis.crypto?.randomUUID?.() || (Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10))),
    startedAt: Date.now(),
    scans: 0,
    domFound: 0,
    domMissed: 0,
    messagesSent: 0,
    lastDomValue: null,
    lastEvidence: null,
    lastMessageAt: 0,
    updatedAt: 0
  };
  globalThis.__ATS_EXPIRATION_PROBE_DIAGNOSTICS__ = expirationProbeDiag;
  let expirationDiagFlushTimer = 0;

  function expirationDiagSnapshot() {
    let host = '';
    try { host = location.hostname || ''; } catch {}
    let isTop = false;
    try { isTop = window === top; } catch {}
    return {
      version: 1,
      instanceId: expirationProbeDiag.instanceId,
      startedAt: Number(expirationProbeDiag.startedAt || 0),
      scans: Number(expirationProbeDiag.scans || 0),
      domFound: Number(expirationProbeDiag.domFound || 0),
      domMissed: Number(expirationProbeDiag.domMissed || 0),
      messagesSent: Number(expirationProbeDiag.messagesSent || 0),
      lastDomValue: expirationProbeDiag.lastDomValue || null,
      lastEvidence: expirationProbeDiag.lastEvidence || null,
      lastMessageAt: Number(expirationProbeDiag.lastMessageAt || 0),
      updatedAt: Date.now(),
      host,
      isTop
    };
  }

  function flushExpirationDiag(immediate = false) {
    expirationProbeDiag.updatedAt = Date.now();
    const write = () => {
      expirationDiagFlushTimer = 0;
      try {
        chrome.storage.local.get(EXPIRATION_DIAG_STORAGE_KEY, stored => {
          try { void chrome.runtime.lastError; } catch {}
          const current = stored?.[EXPIRATION_DIAG_STORAGE_KEY];
          const frames = current?.version === 1 && current.frames && typeof current.frames === 'object'
            ? { ...current.frames }
            : {};
          const now = Date.now();
          for (const [key, row] of Object.entries(frames)) {
            if (!row || now - Number(row.updatedAt || 0) > 120000) delete frames[key];
          }
          frames[expirationProbeDiag.instanceId] = expirationDiagSnapshot();
          chrome.storage.local.set({
            [EXPIRATION_DIAG_STORAGE_KEY]: { version: 1, updatedAt: now, frames }
          }, () => {
            try { void chrome.runtime.lastError; } catch {}
          });
        });
      } catch {}
    };
    if (immediate) {
      if (expirationDiagFlushTimer) { clearTimeout(expirationDiagFlushTimer); expirationDiagFlushTimer = 0; }
      write();
      return;
    }
    if (!expirationDiagFlushTimer) expirationDiagFlushTimer = setTimeout(write, 750);
  }

  async function sendControlsObserved(snapshot = {}) {
    expirationProbeDiag.messagesSent = Number(expirationProbeDiag.messagesSent || 0) + 1;
    expirationProbeDiag.lastMessageAt = Date.now();
    flushExpirationDiag();
    return sendMessage({ type: 'ATS_PLATFORM_CONTROLS_OBSERVED', snapshot });
  }

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

  function renderedMarkerExpiration() {
    const marker = document.getElementById?.('__ats_rendered_market__');
    if (!marker) return null;
    const text = clean(marker.textContent || marker.innerText || '');
    const value = parseExpiration(text);
    return value ? { value, score: 138, reason: 'rendered-market-marker' } : null;
  }

  function bodyExpiration() {
    const body = fold(clean(document.body?.innerText || document.body?.textContent || '').slice(0, 260000));
    if (!body) return null;
    const labels = ['expiracao', 'expiry', 'expiration'];
    for (const marker of labels) {
      let from = 0;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const index = body.indexOf(marker, from);
        if (index < 0) break;
        const after = body.slice(index, Math.min(body.length, index + 180));
        const labeled = parseExpiration(after);
        if (labeled) return { value: labeled, score: 180, reason: 'body-label' };
        const match = after.match(/(?:^|[^0-9])(\d{1,4}\s*(?:s|seg|segundo|segundos|m|min|minuto|minutos))\b/);
        const parsed = parseExpiration(match?.[1] || '');
        if (parsed) return { value: parsed, score: 175, reason: 'body-near-label' };
        from = index + marker.length;
      }
    }
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

  const EXPIRATION_TRANSIENT_CACHE_MS = 12000;
  let lastConfirmedExpiration = null;
  let lastConfirmedAt = 0;
  let expirationControlDirtyAt = 0;

  function expirationInteractionTarget(target) {
    let node = target instanceof Element ? target : null;
    for (let depth = 0; node && depth < 3; depth += 1, node = node.parentElement) {
      const own = clean(ownText(node) || '');
      const meta = fold([
        node.id, node.className, node.getAttribute?.('data-testid'),
        node.getAttribute?.('data-name'), node.getAttribute?.('name'),
        node.getAttribute?.('aria-label'), node.getAttribute?.('title'),
        node.getAttribute?.('role')
      ].filter(Boolean).join(' '));
      const shortOwn = own.length <= 90 ? fold(own) : '';
      if (expirationSemantics.test(meta) || (controlLike(node) && expirationSemantics.test(shortOwn))) return true;

      const value = directDuration(node);
      const parent = node.parentElement;
      const parentOwn = clean(parent?.innerText || parent?.textContent || '');
      if (value && parentOwn.length <= 140 && expirationSemantics.test(fold(parentOwn))) return true;
    }
    return false;
  }

  function scan() {
    const all = elements();
    const marker = renderedMarkerExpiration();
    const strong = marker || expirationControlByLabel(all);
    const semantic = strong || semanticControlExpiration(all);
    const body = semantic || bodyExpiration();
    let exp = marker || strong || semantic || body;
    const tf = selectedTimeframe(all);
    const now = Date.now();
    expirationProbeDiag.scans = Number(expirationProbeDiag.scans || 0) + 1;
    if (exp?.value) {
      expirationProbeDiag.domFound = Number(expirationProbeDiag.domFound || 0) + 1;
      expirationProbeDiag.lastDomValue = exp.value;
      expirationProbeDiag.lastEvidence = exp.reason || null;
    } else {
      expirationProbeDiag.domMissed = Number(expirationProbeDiag.domMissed || 0) + 1;
      expirationProbeDiag.lastDomValue = null;
      expirationProbeDiag.lastEvidence = null;
    }
    flushExpirationDiag();

    if (exp?.value) {
      lastConfirmedExpiration = exp.value;
      lastConfirmedAt = now;
    } else if (
      lastConfirmedExpiration
      && lastConfirmedAt > expirationControlDirtyAt
      && now - lastConfirmedAt < EXPIRATION_TRANSIENT_CACHE_MS
    ) {
      exp = { value: lastConfirmedExpiration, score: 110, reason: 'stable-control-cache' };
    }

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
      source: 'casatrade-expiration-probe-v4',
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
    await sendControlsObserved(snapshot);
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

  const markControlDirty = event => {
    if (!expirationInteractionTarget(event?.target)) return;
    expirationControlDirtyAt = Date.now();
    sendControlsObserved({
      amount: null,
      expiration: null,
      timeframe: null,
      expirationDirty: true,
      confidence: { amount: 0, expiration: 0, timeframe: 0 },
      source: 'casatrade-expiration-probe-v4-dirty',
      observedAt: expirationControlDirtyAt
    }).catch(() => {});
  };
  const clickHandler = event => {
    markControlDirty(event);
    schedule(true, 45);
    setTimeout(() => publish(true).catch(() => {}), 220);
  };
  const controlChangeHandler = event => {
    markControlDirty(event);
    schedule(true, 25);
    setTimeout(() => publish(true).catch(() => {}), 140);
  };
  document.addEventListener('click', clickHandler, true);
  document.addEventListener('input', controlChangeHandler, true);
  document.addEventListener('change', controlChangeHandler, true);

  const intervalId = setInterval(() => publish(true).catch(() => {}), 650);
  globalThis.__ATS_FORCE_EXPIRATION_SCAN__ = () => publish(true);
  globalThis.__ATS_EXPIRATION_PROBE_RUNTIME__ = {
    version: 'expiration-real-v4',
    scan,
    parseExpiration,
    teardown() {
      stopped = true;
      try { observer.disconnect(); } catch {}
      try { document.removeEventListener('click', clickHandler, true); } catch {}
      try { document.removeEventListener('input', controlChangeHandler, true); } catch {}
      try { document.removeEventListener('change', controlChangeHandler, true); } catch {}
      try { clearInterval(intervalId); } catch {}
      if (scheduled) { try { clearTimeout(scheduled); } catch {} }
      flushExpirationDiag(true);
    }
  };

  publish(true).catch(() => {});
})();