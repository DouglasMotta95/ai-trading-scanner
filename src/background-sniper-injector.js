import { readScannerState, updateScannerState } from './services/scanner-state-atomic.js';

const ISOLATED = [
  'src/content/runtime-message-compat.js',
  'src/content/runtime-boot-probe.js',
  'src/content/sniper-page-bootstrap.js',
  'src/content/opaque-frame-top-bridge.js',
  'src/content/opaque-frame-recovery.js',
  'src/content/device-anchor.js',
  'src/content/casatrade-asset-observer.js',
  'src/content/embedded-feed-bridge.js',
  'src/content/casatrade-controls-observer.js',
  'src/content/casatrade-live-clock.js',
  'src/content/manual-trade-observer.js'
];

const MAIN = [
  'src/content/page-world-sentinel.js',
  'src/content/standalone-instrument-probe.js',
  'src/content/worker-probe.js',
  'src/content/network-probe.js'
];

const CRITICAL_ISOLATED = new Set([
  'src/content/runtime-message-compat.js',
  'src/content/runtime-boot-probe.js',
  'src/content/sniper-page-bootstrap.js',
  'src/content/casatrade-asset-observer.js',
  'src/content/embedded-feed-bridge.js',
  'src/content/casatrade-live-clock.js'
]);

function exec(details) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (error, result) => {
      if (done) return;
      done = true;
      error ? reject(error) : resolve(Array.isArray(result) ? result : []);
    };
    try {
      const returned = chrome.scripting.executeScript(details, result => {
        let lastError = null;
        try { lastError = chrome.runtime?.lastError; } catch {}
        finish(lastError ? new Error(lastError.message) : null, result);
      });
      if (returned?.then) returned.then(result => finish(null, result)).catch(error => finish(error));
    } catch (error) {
      finish(error);
    }
  });
}

async function injectFile(tabId, file, world) {
  try {
    const result = await exec({ target: { tabId, allFrames: true }, files: [file], world });
    return { file, world, ok: true, frames: result.length, fallback: false };
  } catch (firstError) {
    if (world === 'ISOLATED') {
      try {
        const result = await exec({ target: { tabId, allFrames: true }, files: [file] });
        return { file, world, ok: true, frames: result.length, fallback: true };
      } catch {}
    }
    return { file, world, ok: false, frames: 0, fallback: false, error: String(firstError?.message || firstError) };
  }
}

function pageWorldConfirmed(state = {}, startedAt = 0) {
  const boots = state.diagnostics?.runtimeBoot?.boots;
  if (!Array.isArray(boots)) return false;
  return boots.some(row => row?.module === 'sniper-page-bootstrap'
    && row?.phase === 'page-world-confirmed'
    && Number(row?.at || 0) >= startedAt - 1000);
}

function focusFresh(state = {}) {
  const focus = state.diagnostics?.focusedAsset || {};
  return !!focus.asset && focus.reliable === true && Number(focus.at || 0) > 0 && Date.now() - Number(focus.at) < 7000;
}

function liveDataFresh(state = {}) {
  return state.connection === 'online'
    && Number(state.lastSeen || 0) > 0
    && Date.now() - Number(state.lastSeen) < 7000
    && Number(state.diagnostics?.marketSession?.historyCount || 0) >= 2;
}

function clockFresh(state = {}) {
  const clock = state.diagnostics?.marketClock || {};
  return clock.verified === true
    && clock.available !== false
    && clock.source === 'casatrade-platform-clock'
    && Number(clock.at || 0) > 0
    && Date.now() - Number(clock.at) < 4500;
}

function acquisitionFailure(state = {}, pageReady = false) {
  if (!pageReady) return { stage: 'page_world_timeout', reason: 'O page-world da CasaTrade não confirmou inicialização.' };
  if (!focusFresh(state)) return { stage: 'asset_timeout', reason: 'Leitores iniciaram, mas o ativo visível da CasaTrade não foi confirmado.' };
  if (!liveDataFresh(state)) return { stage: 'ohlc_timeout', reason: 'Ativo confirmado, mas OHLC/cotação não chegaram com qualidade suficiente.' };
  if (!clockFresh(state)) return { stage: 'clock_timeout', reason: 'OHLC recebido, mas o relógio autoritativo da CasaTrade não foi confirmado.' };
  return null;
}

function scheduleWatchdog(tabId, startedAt, attempt) {
  setTimeout(async () => {
    const state = await readScannerState().catch(() => null);
    if (!state || Number(state.targetTabId) !== Number(tabId)) return;
    const pageReady = pageWorldConfirmed(state, startedAt);
    const failure = acquisitionFailure(state, pageReady);
    if (!failure) return;

    if (attempt < 1) {
      await inject(tabId, attempt + 1).catch(() => false);
      return;
    }

    await updateScannerState(current => {
      if (Number(current.targetTabId) !== Number(tabId)) return current;
      const latestFailure = acquisitionFailure(current, pageWorldConfirmed(current, startedAt));
      if (!latestFailure) return current;
      return {
        ...current,
        connection: 'offline',
        diagnostics: {
          ...(current.diagnostics || {}),
          acquisition: { ...latestFailure, at: Date.now(), retryable: true }
        }
      };
    }).catch(() => {});
  }, 5000);
}

async function inject(tabId, attempt = 0) {
  const startedAt = Date.now();
  const rows = [];

  for (const file of ISOLATED) rows.push(await injectFile(tabId, file, 'ISOLATED'));
  for (const file of MAIN) rows.push(await injectFile(tabId, file, 'MAIN'));

  const criticalIsolatedOk = [...CRITICAL_ISOLATED].every(file => rows.some(row => row.file === file && row.ok));
  const directMainOk = MAIN.every(file => rows.some(row => row.file === file && row.ok));
  const bootstrapOk = rows.some(row => row.file === 'src/content/sniper-page-bootstrap.js' && row.ok);
  const pageWorldPath = directMainOk ? 'executeScript-main' : bootstrapOk ? 'script-tag-fallback' : 'unavailable';
  const ok = criticalIsolatedOk && pageWorldPath !== 'unavailable';
  const failures = rows.filter(row => !row.ok).slice(0, 12);

  await updateScannerState(state => ({
    ...state,
    ...(ok ? {} : { connection: 'offline' }),
    diagnostics: {
      ...(state.diagnostics || {}),
      runtimeInjection: {
        tabId,
        at: Date.now(),
        attempt,
        ok,
        pageWorldPath,
        isolated: {
          total: ISOLATED.length,
          ok: rows.filter(row => row.world === 'ISOLATED' && row.ok).length,
          criticalOk: criticalIsolatedOk
        },
        main: {
          total: MAIN.length,
          ok: rows.filter(row => row.world === 'MAIN' && row.ok).length,
          directOk: directMainOk
        },
        failures
      },
      acquisition: ok
        ? {
            stage: 'waiting_for_asset',
            reason: pageWorldPath === 'executeScript-main'
              ? 'Leitores injetados. Confirmando o ativo visível da CasaTrade.'
              : 'Fallback de compatibilidade ativado. Confirmando page-world e ativo.',
            at: Date.now()
          }
        : {
            stage: 'injection_failed',
            reason: 'Falha ao iniciar os leitores essenciais da CasaTrade.',
            at: Date.now()
          }
    }
  })).catch(() => {});

  if (ok) scheduleWatchdog(tabId, startedAt, attempt);
  return ok;
}

globalThis.__ATS_INJECT_MODERN_PIPELINE__ = inject;
