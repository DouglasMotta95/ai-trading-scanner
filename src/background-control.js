import { activateLicense, validateLicense, clearLicense, restoreCachedLicense } from './services/license.js';
import { readScannerState, updateScannerState } from './services/scanner-state-atomic.js';
import { storageLocalGet, storageSessionGet, tabsQuery, sidePanelSetBehavior } from './services/chrome-compat.js';
import { detectPlatform } from './platforms/registry.js';
import { clearMarketAuthorityState, applyFocus as applyMarketFocus } from './background-market-session.js';

const DEFAULT_LICENSE = Object.freeze({
  status: 'unconfigured', plan: null, planLabel: null, dailyLimit: null, usedToday: 0,
  remainingToday: null, totalLimit: null, usedTotal: 0, remainingTotal: null, error: null
});
const SESSION_HISTORY_KEY = 'atsSessionSignalHistory';
const SHADOW_KEY = 'atsShadowCalibrationV1';
const EXACT_CLOCK_SOURCES = new Set(['trader-dom-countdown', 'network-server-cycle']);
const CONNECT_TIMEOUT_MS = 7000;

const clean = value => String(value ?? '').trim();
const activeLicense = license => {
  const status = clean(license?.status).toLowerCase();
  return ['active', 'valid'].includes(status)
    || license?.devMode === true
    || clean(license?.plan).toUpperCase() === 'OWNER_DEV';
};
const marketId = value => {
  const raw = clean(value).toUpperCase();
  if (!raw) return '';
  const otc = /(?:\(|\b|[_-])OTC(?:\)|\b)?/i.test(raw);
  const pair = raw.match(/\b([A-Z0-9]{2,20})\s*[\/_-]\s*([A-Z0-9]{2,12})/i);
  if (pair) return `${pair[1]}/${pair[2]}${otc ? ' (OTC)' : ''}`;
  return raw.replace(/\s+/g, ' ');
};
const sameAsset = (a, b) => !!marketId(a) && marketId(a) === marketId(b);

function marketDataConnected(state = {}) {
  const focus = state.diagnostics?.focusedAsset || {};
  return state.connection === 'online'
    && !!state.asset
    && Number.isFinite(Number(state.price))
    && focus.reliable === true
    && focus.chartScoped === true
    && focus.trustedChartFrame === true
    && sameAsset(focus.asset, state.asset)
    && Number(state.lastSeen || 0) > 0
    && Date.now() - Number(state.lastSeen) < 7000;
}

function handshakeReady(state = {}) {
  const clock = state.diagnostics?.marketClock || {};
  return marketDataConnected(state)
    && clock.available !== false
    && clock.role === 'candle-close'
    && Number.isFinite(Number(clock.secondsRemaining))
    && Number(clock.at || 0) > 0
    && Date.now() - Number(clock.at) < 5000;
}

function scheduleConnectionTimeout(tabId, connectedAt) {
  setTimeout(async () => {
    const current = await readScannerState().catch(() => null);
    if (!current) return;
    const sameTarget = Number(current.targetTabId) === Number(tabId)
      && Number(current.diagnostics?.target?.connectedAt || 0) === Number(connectedAt);
    if (!sameTarget || handshakeReady(current)) return;

    // A healthy runtime injection is not a connection failure. On Android/tablet
    // the selected-market frame may publish a little later, especially just after
    // an unpacked extension reload. Keep the scanner alive and actively recover
    // the visual focus instead of flipping OFFLINE at 7 seconds.
    if (runtimeInjectionHealthy(current)) {
      await updateScannerState(state => {
        if (Number(state.targetTabId) !== Number(tabId) || handshakeReady(state)) return state;
        const diagnostics = { ...(state.diagnostics || {}) };
        delete diagnostics.connectionError;
        return {
          ...state,
          scanner: 'scanning',
          connection: 'connecting',
          diagnostics: {
            ...diagnostics,
            acquisition: {
              ...(state.diagnostics?.acquisition || {}),
              stage: 'recovering_live_asset',
              reason: 'Leitores carregados. Confirmando o ativo visível da CasaTrade.',
              at: Date.now()
            }
          }
        };
      }).catch(() => {});
      await recoverFocusedAsset(tabId).catch(() => false);
      await injectModern(tabId).catch(() => false);
      await forceLiveControlRead(tabId).catch(() => false);
      setTimeout(() => finalConnectionCheck(tabId, connectedAt).catch(() => {}), 9000);
      return;
    }

    await finalConnectionCheck(tabId, connectedAt);
  }, CONNECT_TIMEOUT_MS);
}

function platformFromUrl(url = '') {
  try { return detectPlatform(new URL(url).hostname); } catch { return null; }
}

function clearMarket(state = {}, extra = {}) {
  return clearMarketAuthorityState(state, {
    ...extra,
    scanner: 'idle',
    connection: 'offline',
    platformId: null,
    platformName: null,
    targetTabId: null,
    diagnostics: { ...(extra.diagnostics || {}) },
    marketSessionSource: 'background-control-clear',
    license: extra.license || state.license || DEFAULT_LICENSE
  });
}

function licenseBlockedDiagnostics(license = {}) {
  return {
    access: {
      state: 'license_required',
      error: clean(license?.error || 'license_required'),
      at: Date.now()
    }
  };
}

async function activePlatformTab() {
  const [tab] = await tabsQuery({ active: true, currentWindow: true }).catch(() => []);
  const platform = tab?.url ? platformFromUrl(tab.url) : null;
  return { tab: tab?.id ? tab : null, platform };
}

async function recoverLicense(state = {}, force = false) {
  if (!force && activeLicense(state.license)) return state.license;

  const restored = await restoreCachedLicense().catch(() => null);
  if (activeLicense(restored)) return restored;

  const { settings = {} } = await storageLocalGet('settings').catch(() => ({}));
  const validated = await validateLicense(settings).catch(() => null);
  if (validated?.ok && activeLicense(validated.license)) return { ...validated.license, status: 'active', error: null };

  if (activeLicense(state.license) && validated?.error === 'device_locked') {
    return { ...state.license, status: 'active', error: 'device_locked', syncPending: true };
  }
  return {
    ...(state.license || DEFAULT_LICENSE),
    status: activeLicense(state.license) ? 'active' : String(state.license?.status || 'unconfigured'),
    error: validated?.error || state.license?.error || null,
    syncPending: validated?.error === 'device_locked' || validated?.error === 'backend_unreachable'
  };
}

async function injectModern(tabId) {
  const inject = globalThis.__ATS_INJECT_MODERN_PIPELINE__;
  if (typeof inject !== 'function' || !tabId) return false;
  return inject(tabId).catch(() => false);
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function executeScriptCompat(details) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(Array.isArray(result) ? result : []);
    };
    const callback = result => {
      let runtimeError = null;
      try { runtimeError = chrome.runtime?.lastError || null; } catch {}
      finish(runtimeError ? new Error(runtimeError.message || String(runtimeError)) : null, result);
    };
    try {
      const returned = chrome.scripting.executeScript(details, callback);
      if (returned && typeof returned.then === 'function') {
        returned.then(result => finish(null, result)).catch(error => finish(error));
      }
    } catch (error) {
      finish(error);
    }
  });
}


async function directFocusedAssetProbe(tabId) {
  if (!tabId || !chrome.scripting?.executeScript) return null;
  const probeFunc = () => {
    const clean = value => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
    let host = '';
    try { host = String(location.hostname || '').toLowerCase().replace(/\.$/, ''); } catch {}
    const meta = globalThis.__ATS_FOCUSED_ASSET_META__ || null;
    const value = clean(meta?.asset || globalThis.__ATS_FOCUSED_ASSET_VALUE__ || '');
    if (!value) return null;
    const trader = host === 'casatraders.online' || host.endsWith('.casatraders.online')
      || host === 'ivcasatraders.online' || host.endsWith('.ivcasatraders.online');
    const casa = host === 'casatrade.com' || host.endsWith('.casatrade.com')
      || host === 'casatrade.io' || host.endsWith('.casatrade.io');
    if (!trader && !casa) return null;
    return {
      asset: value,
      score: Number(meta?.score || 0),
      samples: Math.max(3, Number(meta?.samples || 0)),
      stableFor: Math.max(300, Number(meta?.stableFor || 0)),
      reliable: true,
      visual: true,
      explicit: meta?.explicit === true,
      interactionHint: meta?.interactionHint === true,
      interactionAt: Number(meta?.interactionAt || 0) || null,
      chartScoped: true,
      chartFound: meta?.chartFound !== false,
      frameHost: host,
      frameRole: clean(meta?.frameRole || (trader ? 'trader-frame' : 'casa-chart-frame')),
      source: clean(meta?.source || 'background-focus-recovery'),
      at: Date.now()
    };
  };
  const attempts = [
    { target: { tabId, allFrames: true }, world: 'ISOLATED' },
    { target: { tabId, allFrames: true } }
  ];
  let rows = [];
  for (const details of attempts) {
    try {
      const result = await executeScriptCompat({ ...details, func: probeFunc });
      rows = [...rows, ...result];
      if (result.some(row => row?.result?.asset)) break;
    } catch {}
  }
  const candidates = rows
    .map(row => ({ frameId: Number(row?.frameId ?? -1), ...(row?.result || {}) }))
    .filter(row => row.asset && ['trader-frame','casa-chart-frame'].includes(clean(row.frameRole)))
    .sort((a,b) =>
      Number(b.interactionHint === true) - Number(a.interactionHint === true)
      || Number(b.explicit === true) - Number(a.explicit === true)
      || Number(String(b.frameRole) === 'trader-frame') - Number(String(a.frameRole) === 'trader-frame')
      || Number(b.score || 0) - Number(a.score || 0)
    );
  return candidates[0] || null;
}

async function recoverFocusedAsset(tabId) {
  if (!tabId) return false;
  await forceLiveControlRead(tabId).catch(() => false);
  await sleep(220);
  const evidence = await directFocusedAssetProbe(tabId);
  if (!evidence?.asset) return false;
  const state = await readScannerState().catch(() => ({}));
  const topHost = clean(state.diagnostics?.target?.host || 'trade.casatrade.com').toLowerCase();
  const frameHost = clean(evidence.frameHost || '').toLowerCase();
  const sender = {
    tab: { id: Number(tabId), url: `https://${topHost}/` },
    frameId: Number(evidence.frameId ?? 0),
    url: `https://${frameHost || topHost}/`
  };
  const applied = await applyMarketFocus({
    type: 'ATS_VISUAL_FOCUS_V2',
    ...evidence,
    reliable: true,
    visual: true,
    chartScoped: true,
    at: Date.now(),
    source: evidence.source || 'background-focus-recovery'
  }, sender).catch(() => null);
  await updateScannerState(current => ({
    ...current,
    diagnostics: {
      ...(current.diagnostics || {}),
      directFocusRecovery: {
        found: true,
        asset: evidence.asset,
        frameId: Number(evidence.frameId ?? -1),
        frameHost,
        frameRole: evidence.frameRole,
        applied: !!applied,
        at: Date.now()
      }
    }
  })).catch(() => {});
  return !!applied;
}

function runtimeInjectionHealthy(state = {}) {
  const runtime = state.diagnostics?.runtimeInjection || {};
  return Number(runtime.isolated?.ok || 0) > 0 || Number(runtime.main?.ok || 0) > 0;
}

async function finalConnectionCheck(tabId, connectedAt) {
  const current = await readScannerState().catch(() => null);
  if (!current) return;
  const sameTarget = Number(current.targetTabId) === Number(tabId)
    && Number(current.diagnostics?.target?.connectedAt || 0) === Number(connectedAt);
  if (!sameTarget || handshakeReady(current)) return;

  if (runtimeInjectionHealthy(current)) {
    await recoverFocusedAsset(tabId).catch(() => false);
    await sleep(1200);
    const recovered = await readScannerState().catch(() => null);
    if (recovered && handshakeReady(recovered)) return;
  }

  await updateScannerState(state => {
    const stillSame = Number(state.targetTabId) === Number(tabId)
      && Number(state.diagnostics?.target?.connectedAt || 0) === Number(connectedAt);
    if (!stillSame || handshakeReady(state)) return state;
    return {
      ...state,
      scanner: 'idle',
      connection: 'offline',
      diagnostics: {
        ...(state.diagnostics || {}),
        connectionError: {
          code: 'handshake_timeout',
          message: 'Falha ao confirmar o ativo ao vivo — tentar novamente.',
          at: Date.now()
        },
        acquisition: {
          ...(state.diagnostics?.acquisition || {}),
          stage: 'connect_timeout',
          reason: 'Os leitores entraram, mas o ativo ao vivo não foi confirmado.',
          at: Date.now()
        }
      }
    };
  });
}

function normalizeExpiration(value = '') {
  const s = clean(value).toLowerCase().replace(/\s+/g, '');
  let m = s.match(/^(\d{1,5})(?:s|seg|segundo|segundos)$/); if (m) return `${Number(m[1])}s`;
  m = s.match(/^(\d{1,4})(?:m|min|minuto|minutos)$/); if (m) return `${Number(m[1]) * 60}s`;
  m = s.match(/^(\d{1,3}):(\d{2})$/); if (m) return `${Number(m[1]) * 60 + Number(m[2])}s`;
  return null;
}

async function directExpirationProbe(tabId) {
  if (!tabId || !chrome.scripting?.executeScript) return null;
  try {
    const probeFunc = () => {
        const clean = value => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
        const fold = value => clean(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
        const visible = el => {
          if (!el || !(el instanceof Element)) return false;
          const r = el.getBoundingClientRect();
          const s = getComputedStyle(el);
          return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity || 1) > 0;
        };
        const raw = el => clean(
          el instanceof HTMLInputElement ? el.value
            : el instanceof HTMLSelectElement ? (el.selectedOptions?.[0]?.textContent || el.value)
              : (el.getAttribute?.('aria-valuetext') || el.getAttribute?.('data-value') || el.innerText || el.textContent || '')
        );
        const parse = value => {
          const s = fold(value);
          let m = s.match(/(?:expiracao|expiry|expiration|tempo de expiracao)[^0-9]{0,80}(\d{1,4})\s*(s|seg|segundo|segundos|m|min|minuto|minutos)\b/);
          if (m) return /^(m|min|minuto|minutos)$/.test(m[2]) ? `${Number(m[1]) * 60}s` : `${Number(m[1])}s`;
          m = s.match(/^(\d{1,4})\s*(s|seg|segundo|segundos|m|min|minuto|minutos)$/);
          if (m) return /^(m|min|minuto|minutos)$/.test(m[2]) ? `${Number(m[1]) * 60}s` : `${Number(m[1])}s`;
          // Compact CasaTrade controls can prefix the selected value with an
          // icon/glyph (for example "⚑ 1 min"). When this short token is being
          // inspected next to the Expiração label, accept the duration inside it.
          if (s.length <= 48) {
            m = s.match(/(?:^|[^0-9])(\d{1,4})\s*(s|seg|segundo|segundos|m|min|minuto|minutos)\b/);
            if (m) return /^(m|min|minuto|minutos)$/.test(m[2]) ? `${Number(m[1]) * 60}s` : `${Number(m[1])}s`;
          }
          m = s.match(/^(\d{1,3}):([0-5]\d)$/);
          return m ? `${Number(m[1]) * 60 + Number(m[2])}s` : null;
        };
        const selected = el => {
          const flags = fold([
            el?.getAttribute?.('aria-selected'), el?.getAttribute?.('aria-current'),
            el?.getAttribute?.('data-state'), el?.getAttribute?.('data-active'), el?.className
          ].filter(Boolean).join(' '));
          return /\b(?:true|active|selected|current|checked)\b/.test(flags);
        };
        const localText = (el, levels = 3) => {
          const parts = [];
          let node = el;
          for (let i = 0; node && i <= levels; i += 1, node = node.parentElement) {
            const t = clean(node.innerText || node.textContent || '');
            if (t && t.length <= 220) parts.push(t);
            parts.push(node.id || '', String(node.className || ''), node.getAttribute?.('data-testid') || '', node.getAttribute?.('aria-label') || '');
          }
          return fold(parts.join(' '));
        };
        const selector = 'button,input,select,option,label,p,strong,small,span,div,[role="button"],[role="combobox"],[role="option"],[aria-selected],[data-value],[aria-valuetext]';
        const all = [];
        const roots = [document];
        const seenRoots = new Set();
        while (roots.length && all.length < 14000) {
          const root = roots.shift();
          if (!root || seenRoots.has(root)) continue;
          seenRoots.add(root);
          let nodes = [];
          try { nodes = [...root.querySelectorAll(selector)]; } catch {}
          for (const node of nodes) {
            if (visible(node)) all.push(node);
            if (node.shadowRoot && !seenRoots.has(node.shadowRoot)) roots.push(node.shadowRoot);
            if (all.length >= 14000) break;
          }
          let every = [];
          try { every = [...root.querySelectorAll('*')].slice(0, 5000); } catch {}
          for (const node of every) if (node.shadowRoot && !seenRoots.has(node.shadowRoot)) roots.push(node.shadowRoot);
        }
        const labels = all.filter(el => {
          const t = fold(raw(el));
          return /^(?:expiracao|expiry|expiration|tempo de expiracao|expiration time)$/.test(t)
            || /^(?:expiracao|expiry|expiration)\b/.test(t) && t.length <= 90;
        });

        const candidates = [];
        for (const label of labels) {
          const labelText = raw(label);
          const direct = parse(labelText);
          if (direct) candidates.push({ expiration: direct, score: 1000, evidence: 'direct-label' });
          const lr = label.getBoundingClientRect();

          let parent = label.parentElement;
          for (let depth = 0; parent && depth < 5; depth += 1, parent = parent.parentElement) {
            const text = clean(parent.innerText || parent.textContent || '');
            if (!text || text.length > 260) continue;
            const labeled = parse(text);
            if (labeled) {
              let score = 900 - depth * 40;
              if (/\bvalor\b|\bamount\b|stake|investimento/i.test(text)) score += 80;
              if (/periodo da vela|periodo de vela|candle period|timeframe|chart range|countdown|fechamento da vela/i.test(fold(text))) score -= 350;
              candidates.push({ expiration: labeled, score, evidence: 'expiration-container' });
            }
          }

          for (const el of all) {
            if (el === label) continue;
            const value = parse(raw(el));
            if (!value) continue;
            const r = el.getBoundingClientRect();
            const centerY = Math.abs((r.top + r.bottom) / 2 - (lr.top + lr.bottom) / 2);
            const horizontalGap = r.right < lr.left ? lr.left - r.right : r.left > lr.right ? r.left - lr.right : 0;
            if (centerY > 145 || horizontalGap > 500) continue;
            const context = localText(el, 2);
            if (/periodo da vela|periodo de vela|candle period|candle interval|timeframe|chart range|chart period|countdown|contagem|fechamento da vela/.test(context)) continue;
            const role = fold(el.getAttribute?.('role') || '');
            let score = 650 - Math.min(220, centerY + horizontalGap / 3);
            if (selected(el)) score += 180;
            if (role === 'option' && !selected(el)) score -= 260;
            if (/expiracao|expiry|expiration|duracao|duration/.test(context)) score += 160;
            candidates.push({ expiration: value, score, evidence: selected(el) ? 'selected-near-expiration' : 'near-expiration' });
          }
        }

        // Last-resort visible-text reader. This deliberately does not depend on
        // CasaTrade classes, ids or component structure. On responsive/mobile
        // layouts the selector can be rendered by a custom component while the
        // visible text still contains "Expiração" followed by "1 min".
        // Preserve real line breaks. Calling clean() here would collapse the
        // exact mobile layout we need to read: "Expiração" on one line and
        // "1 min" (often prefixed by an icon) on the next.
        const bodyTextRaw = String(document.body?.innerText || '').normalize('NFKC');
        const bodyText = fold(bodyTextRaw);
        const lines = bodyTextRaw.split(/\r?\n/).map(clean).filter(Boolean);
        for (let i = 0; i < lines.length; i += 1) {
          const label = fold(lines[i]);
          if (!/^(?:expiracao|expiry|expiration|tempo de expiracao|expiration time)\b/.test(label) || label.length > 48) continue;
          for (let j = i + 1; j <= Math.min(lines.length - 1, i + 4); j += 1) {
            const value = parse(lines[j]);
            if (value) {
              candidates.push({ expiration: value, score: 1300 - (j - i) * 20, evidence: 'visible-lines-after-expiration-label' });
              break;
            }
          }
        }
        for (const marker of ['expiracao','expiry','expiration','tempo de expiracao']) {
          let from = 0;
          for (let attempt = 0; attempt < 20; attempt += 1) {
            const index = bodyText.indexOf(marker, from);
            if (index < 0) break;
            const slice = bodyText.slice(index, Math.min(bodyText.length, index + 140));
            const value = parse(slice);
            if (value) candidates.push({ expiration: value, score: 1180, evidence: 'visible-body-expiration-text' });
            from = index + marker.length;
          }
        }

        candidates.sort((a, b) => b.score - a.score);
        const best = candidates[0] || null;
        if (!best || best.score < 420) return null;
        let host = '';
        try { host = location.hostname || ''; } catch {}
        return { ...best, host };
      };

    // Android extension engines differ here: some are callback-only, some do
    // not accept the world option, and an allFrames call can fail because of a
    // single inaccessible child frame. Try the visible top frame first, then
    // broaden the search. A failed compatibility mode must not turn a visible
    // "Expiração 1 min" into PENDENTE.
    const attempts = [
      { target: { tabId }, world: 'ISOLATED' },
      { target: { tabId } },
      { target: { tabId, allFrames: true }, world: 'ISOLATED' },
      { target: { tabId, allFrames: true } }
    ];
    let rows = [];
    for (const details of attempts) {
      try {
        const result = await executeScriptCompat({ ...details, func: probeFunc });
        rows = [...rows, ...result];
        if (result.some(row => row?.result?.expiration)) break;
      } catch {}
    }

    const candidates = (Array.isArray(rows) ? rows : [])
      .map(row => ({ frameId: Number(row?.frameId ?? -1), ...(row?.result || {}) }))
      .filter(row => normalizeExpiration(row.expiration))
      .sort((a, b) => Number(b.score || 0) - Number(a.score || 0));
    return candidates[0] || null;
  } catch {
    return null;
  }
}

async function commitDirectExpiration(tabId, evidence = null) {
  const expiration = normalizeExpiration(evidence?.expiration || '');
  if (!expiration) return readScannerState();
  return updateScannerState(state => {
    if (Number(state.targetTabId || 0) !== Number(tabId)) return state;
    const now = Date.now();
    const previousObserved = state.platformControls?.observed || {};
    const observed = {
      ...previousObserved,
      expiration,
      source: 'background-direct-expiration-probe',
      observedAt: {
        ...(previousObserved.observedAt || {}),
        expiration: now
      },
      confidence: {
        ...(previousObserved.confidence || {}),
        expiration: Math.max(145, Number(previousObserved.confidence?.expiration || 0))
      },
      expirationRecheckPendingAt: 0
    };
    const timeframe = normalizeOperatingTimeframe(state.analystPreferences?.operatingTimeframe || state.analysisTimeframe || state.timeframe);
    const requiredExpiration = expirationForOperatingTimeframe(timeframe);
    const ready = expiration === requiredExpiration;
    return {
      ...state,
      expiration,
      targetExpiration: expiration,
      platformControls: {
        ...(state.platformControls || {}),
        observed,
        checkedAt: now,
        expirationCheckedAt: now,
        frameId: Number(evidence?.frameId ?? state.platformControls?.frameId ?? 0),
        source: 'background-direct-expiration-probe',
        aligned: ready,
        liveAuthority: true
      },
      diagnostics: {
        ...(state.diagnostics || {}),
        directExpirationProbe: {
          found: true,
          expiration,
          evidence: clean(evidence?.evidence || ''),
          frameId: Number(evidence?.frameId ?? -1),
          host: clean(evidence?.host || ''),
          score: Number(evidence?.score || 0),
          tabId: Number(tabId || 0),
          at: now
        },
        expirationGuard: {
          ...(state.diagnostics?.expirationGuard || {}),
          required: requiredExpiration,
          actual: expiration,
          ready,
          validForM1: timeframe === 'M1' && ready,
          validForM5: timeframe === 'M5' && ready,
          reason: expiration === requiredExpiration
            ? `Expiração real de ${timeframe === 'M1' ? '1 minuto' : '5 minutos'} confirmada diretamente na CasaTrade.`
            : `Ajuste a expiração da CasaTrade para ${timeframe === 'M1' ? '1 minuto' : '5 minutos'}.`,
          source: 'background-direct-expiration-probe',
          evidence: clean(evidence?.evidence || ''),
          at: now
        },
        platformTime: {
          ...(state.diagnostics?.platformTime || {}),
          expiration,
          source: 'background-direct-expiration-probe',
          ready,
          at: now
        }
      }
    };
  });
}

async function readAndCommitDirectExpiration(tabId) {
  const waits = [0, 180, 480];
  let lastEvidence = null;
  for (const wait of waits) {
    if (wait) await sleep(wait);
    const evidence = await directExpirationProbe(tabId);
    if (evidence) {
      lastEvidence = evidence;
      await commitDirectExpiration(tabId, evidence);
      return evidence;
    }
  }
  await updateScannerState(state => ({
    ...state,
    diagnostics: {
      ...(state.diagnostics || {}),
      directExpirationProbe: {
        found: false,
        attempts: waits.length,
        tabId: Number(tabId || 0),
        at: Date.now()
      }
    }
  })).catch(() => {});
  return lastEvidence;
}

async function forceLiveControlRead(tabId) {
  if (!tabId || !chrome.scripting?.executeScript) return false;
  try {
    const result = executeScriptCompat({
      target: { tabId, allFrames: true },
      world: 'ISOLATED',
      func: () => {
        let asset = false;
        try {
          if (typeof globalThis.__ATS_FORCE_FOCUSED_ASSET_SCAN__ === 'function') {
            globalThis.__ATS_FORCE_FOCUSED_ASSET_SCAN__();
            asset = true;
          }
        } catch {}
        return { asset };
      }
    });
    await result.catch(() => []);
    await sleep(240);
    return true;
  } catch {
    await sleep(240);
    return false;
  }
}

async function refreshTargetTab() {
  const state = await readScannerState();
  if (!activeLicense(state.license)) return { ok: false, error: 'license_required', state };
  const tabId = Number(state.targetTabId || 0);
  if (!tabId) return { ok: false, error: 'target_tab_missing', state };

  const injected = await injectModern(tabId).catch(() => false);
  await forceLiveControlRead(tabId).catch(() => false);
  const focusRecovered = await recoverFocusedAsset(tabId).catch(() => false);
  const nextState = await readScannerState();
  return { ok: !!injected || focusRecovered, tabId, injected, focusRecovered, state: nextState };
}

async function connectActiveTab() {
  let state = await readScannerState();
  const license = await recoverLicense(state);
  if (!activeLicense(license)) {
    const next = await updateScannerState(current => clearMarket(current, {
      license,
      diagnostics: licenseBlockedDiagnostics(license)
    }));
    return { ok: false, error: license.error || 'license_required', state: next };
  }

  const { tab, platform } = await activePlatformTab();
  if (!tab?.id || !platform) {
    const next = await updateScannerState(current => clearMarket(current, {
      license,
      diagnostics: { unsupportedHost: (() => { try { return new URL(tab?.url || '').hostname || null; } catch { return null; } })() }
    }));
    return { ok: false, error: 'platform_not_registered', state: next };
  }

  const next = await updateScannerState(current => {
    const sameTab = Number(current.targetTabId) === Number(tab.id);
    const focus = current.diagnostics?.focusedAsset || null;
    const focusFresh = Number(focus?.at || 0) > 0 && Date.now() - Number(focus.at) < 2500;
    const dataFresh = Number(current.lastSeen || 0) > 0 && Date.now() - Number(current.lastSeen) < 2500;
    const preserveLive = sameTab && current.connection === 'online' && focusFresh && dataFresh
      && focus?.reliable === true && focus?.trustedChartFrame === true;

    const diagnostics = { ...(current.diagnostics || {}) };
    delete diagnostics.connectionError;
    const base = {
      ...current,
      license,
      platformId: platform.id,
      platformName: platform.name,
      targetTabId: tab.id,
      scanner: 'scanning',
      connection: preserveLive ? 'online' : 'connecting',
      diagnostics: {
        ...diagnostics,
        target: { host: new URL(tab.url).hostname, tabId: tab.id, connectedAt: Date.now(), pipeline: 'single-session' },
        acquisition: {
          stage: preserveLive ? 'diagnosing_next_candle' : 'confirming_asset',
          reason: preserveLive ? 'Sessão ao vivo preservada e conferida.' : 'CasaTrade conectada. Confirmando novamente o gráfico ativo.',
          at: Date.now()
        }
      }
    };

    if (preserveLive) return base;
    const cleared = clearMarketAuthorityState(base, {
      license,
      platformId: platform.id,
      platformName: platform.name,
      targetTabId: tab.id,
      scanner: 'scanning',
      connection: 'connecting',
      diagnostics: base.diagnostics,
      marketSessionSource: 'connect-active-tab'
    });

    // Reconnecting the same CasaTrade tab must not erase a platform control
    // that was already confirmed from that tab. Market price/history/focus are
    // session-scoped and are cleared above; expiration is a persistent selected
    // control and remains authoritative until a new real reading replaces it.
    const confirmedExpiration = clean(current.platformControls?.observed?.expiration || '');
    const confirmedExpirationAt = Number(
      current.platformControls?.observed?.observedAt?.expiration
      || current.platformControls?.expirationCheckedAt
      || 0
    );
    if (sameTab && confirmedExpiration && confirmedExpirationAt > 0) {
      return {
        ...cleared,
        expiration: confirmedExpiration,
        targetExpiration: confirmedExpiration,
        platformControls: current.platformControls,
        diagnostics: {
          ...(cleared.diagnostics || {}),
          expirationGuard: {
            ...(current.diagnostics?.expirationGuard || {}),
            actual: confirmedExpiration,
            at: Date.now()
          }
        }
      };
    }
    return cleared;
  });

  const injected = await injectModern(tab.id);
  if (!injected) {
    const failed = await updateScannerState(current => ({
      ...current,
      connection: current.connection === 'online' ? 'online' : 'connecting',
      diagnostics: {
        ...(current.diagnostics || {}),
        acquisition: {
          ...(current.diagnostics?.acquisition || {}),
          stage: 'runtime_injection_failed',
          reason: 'A CasaTrade foi reconhecida, mas os leitores ao vivo não conseguiram ser injetados. Recarregue a aba da CasaTrade e conecte novamente.',
          at: Date.now()
        }
      }
    }));
    return { ok: false, error: 'runtime_injection_failed', platform: { id: platform.id, name: platform.name }, tabId: tab.id, state: failed };
  }
  await forceLiveControlRead(tab.id);
  await recoverFocusedAsset(tab.id).catch(() => false);
  const connectedAt = Number(next.diagnostics?.target?.connectedAt || Date.now());
  scheduleConnectionTimeout(tab.id, connectedAt);
  return { ok: true, platform: { id: platform.id, name: platform.name }, tabId: tab.id, state: await readScannerState() || next };
}

async function activate(key = '') {
  const { settings = {} } = await storageLocalGet('settings').catch(() => ({}));
  const response = await activateLicense(settings, clean(key));
  let license = response?.license || null;

  if (!response?.ok && response?.error === 'device_locked') {
    const restored = await restoreCachedLicense().catch(() => null);
    if (activeLicense(restored)) license = { ...restored, error: 'device_locked', syncPending: true };
  }

  const ok = activeLicense(license);
  const next = await updateScannerState(current => {
    if (ok) return { ...current, license: { ...license, status: 'active' } };
    const blockedLicense = {
      ...(current.license || DEFAULT_LICENSE),
      ...(license || {}),
      status: String(license?.status || current.license?.status || 'unconfigured'),
      error: response?.error || license?.error || 'license_inactive'
    };
    return clearMarket(current, { license: blockedLicense, diagnostics: licenseBlockedDiagnostics(blockedLicense) });
  });
  if (ok) return { ...response, ok: true, error: null, license: next.license, state: next };
  return { ...response, ok: false, error: response?.error || 'license_inactive', license: next.license, state: next };
}

async function validate() {
  const state = await readScannerState();
  const license = await recoverLicense(state, true);
  const ok = activeLicense(license);
  const next = await updateScannerState(current => ok
    ? { ...current, license }
    : clearMarket(current, { license, diagnostics: licenseBlockedDiagnostics(license) }));
  return { ok, license, state: next };
}

async function readSessionHistory() {
  const [session, shadow] = await Promise.all([
    storageSessionGet(SESSION_HISTORY_KEY).catch(() => ({})),
    storageLocalGet(SHADOW_KEY).catch(() => ({}))
  ]);
  const rows = Array.isArray(session?.[SESSION_HISTORY_KEY]) ? session[SESSION_HISTORY_KEY] : [];
  const shadowData = shadow?.[SHADOW_KEY] || { rows: [], metrics: {} };
  return {
    ok: true,
    rows,
    shadowRows: Array.isArray(shadowData.rows) ? shadowData.rows.slice(-100) : [],
    shadowMetrics: shadowData.metrics || {}
  };
}

function exactTradeReady(state = {}) {
  const focus = state.diagnostics?.focusedAsset || {};
  const ui = String(state.signal?.uiState || '').toUpperCase();
  if (!['ENTER_BUY','ENTER_SELL'].includes(ui)) return false;
  if (!state.asset || !sameAsset(focus.asset, state.asset)) return false;
  if (focus.reliable !== true || focus.chartScoped !== true || focus.trustedChartFrame !== true) return false;
  return true;
}

async function manualIntent(direction = '') {
  direction = String(direction || '').toUpperCase();
  if (!['BUY', 'SELL'].includes(direction)) return { ok: false, error: 'invalid_direction' };
  const state = await readScannerState();
  if (!activeLicense(state.license)) return { ok: false, error: 'license_required', state };
  const signalDirection = String(state.signal?.direction || '').toUpperCase();
  const confirmed = state.signal?.state === 'CONFIRM' || ['ENTER_BUY', 'ENTER_SELL'].includes(String(state.signal?.uiState || ''));
  if (!confirmed || signalDirection !== direction) return { ok: false, error: 'signal_not_confirmed', state };

  if (!exactTradeReady(state)) return { ok: false, error: 'signal_not_ready', state };

  const operatingTimeframe = normalizeOperatingTimeframe(state.analystPreferences?.operatingTimeframe || state.analysisTimeframe || state.timeframe);
  const intent = {
    direction, asset: state.asset, timeframe: operatingTimeframe,
    expiration: expirationForOperatingTimeframe(operatingTimeframe),
    targetStart: state.signal?.targetStart || null,
    mode: 'manual-only', createdAt: Date.now()
  };
  const next = await updateScannerState(current => ({ ...current, tradeIntent: intent }));
  return { ok: true, intent, state: next };
}

function normalizeOperatingTimeframe(value = '') {
  return clean(value).toUpperCase() === 'M1' ? 'M1' : 'M5';
}
function expirationForOperatingTimeframe(value = '') {
  return normalizeOperatingTimeframe(value) === 'M1' ? '60s' : '300s';
}

async function setAnalystPreferences(message = {}) {
  const operatingTimeframe = normalizeOperatingTimeframe(message.operatingTimeframe);
  const preferredExpiration = expirationForOperatingTimeframe(operatingTimeframe);
  const next = await updateScannerState(current => {
    const previousTf = normalizeOperatingTimeframe(current.analystPreferences?.operatingTimeframe || 'M1');
    const changed = previousTf !== operatingTimeframe;
    return {
      ...current,
      analystPreferences: {
        ...(current.analystPreferences || {}),
        mode: 'A_PLUS',
        operatingTimeframe,
        preferredExpiration,
        geminiEnabled: message.geminiEnabled !== false,
        holdSeconds: 3
      },
      operationPlan: {
        timeframe: operatingTimeframe,
        expiration: preferredExpiration,
        contextTimeframe: operatingTimeframe === 'M1' ? 'M5' : 'M15',
        finalWindowSeconds: operatingTimeframe === 'M1' ? 10 : 20
      },
      targetExpiration: preferredExpiration,
      ...(changed ? {
        signal: null,
        professionalDecision: null,
        decisionCycle: null,
        tradeIntent: null,
        entryAdvice: null
      } : {}),
      diagnostics: {
        ...(current.diagnostics || {}),
        operationPlan: {
          timeframe: operatingTimeframe,
          expiration: preferredExpiration,
          contextTimeframe: operatingTimeframe === 'M1' ? 'M5' : 'M15',
          finalWindowSeconds: operatingTimeframe === 'M1' ? 10 : 20,
          changedAt: changed ? Date.now() : Number(current.diagnostics?.operationPlan?.changedAt || 0),
          at: Date.now()
        }
      }
    };
  });
  globalThis.__ATS_SCHEDULE_CENTRAL_ANALYSIS__?.(true);
  return { ok: true, state: next, operatingTimeframe, preferredExpiration };
}

async function setScanner(enabled = false) {
  const state = await readScannerState();
  if (enabled && !activeLicense(state.license)) {
    const next = await updateScannerState(current => clearMarket(current, {
      license: current.license || DEFAULT_LICENSE,
      diagnostics: licenseBlockedDiagnostics(current.license || DEFAULT_LICENSE)
    }));
    return { ok: false, error: 'license_required', state: next };
  }
  const next = await updateScannerState(current => ({
    ...current,
    scanner: enabled ? 'scanning' : 'idle',
    ...(enabled ? {} : { signal: null, professionalDecision: null, tradeIntent: null })
  }));
  return { ok: true, state: next };
}

sidePanelSetBehavior({ openPanelOnActionClick: true }).catch(() => {});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const type = String(message?.type || '');

  if (type === 'ATS_CONNECT_ACTIVE_TAB' || type === 'ATS_REFRESH_MARKET') {
    connectActiveTab().then(sendResponse).catch(error => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }

  if (type === 'ATS_REFRESH_TARGET_TAB') {
    refreshTargetTab().then(sendResponse).catch(error => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }

  if (type === 'ATS_READ_SCANNER_STATE' || type === 'ATS_GET_STATE') {
    readScannerState().then(state => sendResponse({ ok: true, state })).catch(error => sendResponse({ ok: false, error: String(error?.message || error), state: {} }));
    return true;
  }

  if (type === 'ATS_ACTIVATE_LICENSE') {
    activate(message.key).then(async result => {
      if (result.ok) {
        const connected = await connectActiveTab().catch(() => null);
        if (connected?.state) result.state = connected.state;
      }
      sendResponse(result);
    }).catch(error => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }

  if (type === 'ATS_VALIDATE_LICENSE') {
    validate().then(sendResponse).catch(error => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }

  if (type === 'ATS_CLEAR_LICENSE') {
    clearLicense().then(() => updateScannerState(current => clearMarket(current, { license: DEFAULT_LICENSE, diagnostics: licenseBlockedDiagnostics(DEFAULT_LICENSE) })))
      .then(state => sendResponse({ ok: true, state }))
      .catch(error => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }

  if (type === 'ATS_GET_PLATFORM_CONFIG') {
    let host = clean(message.host);
    if (!host && sender?.url) { try { host = new URL(sender.url).hostname; } catch {} }
    const platform = detectPlatform(host);
    sendResponse({ ok: !!platform, platform: platform ? { ...platform } : null });
    return false;
  }

  if (type === 'ATS_READ_PLATFORM_CONTROLS' || type === 'ATS_SYNC_PLATFORM_PREFERENCES') {
    readScannerState().then(state => {
      const observed = state.platformControls?.observed || {};
      sendResponse({ ok: true, aligned: !!state.platformControls?.aligned, observed });
    }).catch(error => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }

  if (type === 'ATS_PREPARE_TRADE') {
    manualIntent(message.direction).then(sendResponse).catch(error => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }

  if (type === 'ATS_GET_SESSION_HISTORY') {
    readSessionHistory().then(sendResponse).catch(error => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }

  if (type === 'ATS_SET_ANALYST_PREFERENCES') {
    setAnalystPreferences(message).then(sendResponse).catch(error => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }

  if (type === 'ATS_SET_SCANNER') {
    setScanner(message.enabled === true).then(sendResponse).catch(error => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }

  if (type === 'ATS_RESET_STATE') {
    readScannerState().then(state => updateScannerState(() => clearMarket({}, { license: state.license || DEFAULT_LICENSE, diagnostics: activeLicense(state.license) ? {} : licenseBlockedDiagnostics(state.license || DEFAULT_LICENSE) })))
      .then(state => sendResponse({ ok: true, state }))
      .catch(error => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }

  if (['ATS_PLATFORM_SNAPSHOT', 'ATS_DOM_CATALOG', 'ATS_NETWORK_DIAGNOSTIC'].includes(type)) {
    sendResponse({ ok: true, ignored: true, reason: 'single_session_market_authority' });
    return false;
  }

  return false;
});

(async () => {
  const state = await readScannerState().catch(() => ({}));
  const license = await recoverLicense(state).catch(() => state.license || DEFAULT_LICENSE);
  await updateScannerState(current => activeLicense(license)
    ? { ...current, license }
    : clearMarket(current, { license, diagnostics: licenseBlockedDiagnostics(license) }));
})().catch(() => {});
