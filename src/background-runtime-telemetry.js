import { updateScannerState } from './services/scanner-state-atomic.js';

const clean = (value, max = 120) => String(value ?? '').normalize('NFKC').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const casaHost = value => {
  const host = clean(value, 180).toLowerCase().replace(/\.$/, '');
  return host === 'casatrade.com' || host.endsWith('.casatrade.com') || host === 'casatrade.io' || host.endsWith('.casatrade.io');
};

function topHost(sender = {}) {
  try { return new URL(sender.tab?.url || '').hostname.toLowerCase(); } catch { return ''; }
}

function safeHints(rows = []) {
  return (Array.isArray(rows) ? rows : []).slice(0, 16).map(row => ({
    protocol: clean(row?.protocol, 16),
    host: clean(row?.host, 120),
    opaque: row?.opaque === true,
    srcdoc: row?.srcdoc === true
  }));
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'ATS_RUNTIME_BOOT') return false;
  if (!sender.tab?.id || !casaHost(topHost(sender))) {
    sendResponse({ ok: false, ignored: true });
    return false;
  }

  const boot = message.boot && typeof message.boot === 'object' ? message.boot : {};
  const frameId = Number.isInteger(Number(sender.frameId)) ? Number(sender.frameId) : null;
  const row = {
    at: Date.now(),
    frameId,
    isTop: boot.isTop === true || frameId === 0,
    module: clean(boot.module || 'runtime-boot', 64),
    phase: clean(boot.phase || 'boot', 32),
    protocol: clean(boot.protocol, 16),
    host: clean(boot.host, 120),
    referrerHost: clean(boot.referrerHost, 120),
    readyState: clean(boot.readyState, 24),
    frameHints: safeHints(boot.frameHints)
  };

  updateScannerState(state => {
    const diagnostics = state.diagnostics || {};
    const previous = diagnostics.runtimeBoot || {};
    const boots = Array.isArray(previous.boots) ? previous.boots.slice(-29) : [];
    const key = `${row.frameId}|${row.module}|${row.phase}`;
    const filtered = boots.filter(item => `${item?.frameId}|${item?.module}|${item?.phase}` !== key);
    filtered.push(row);
    return {
      ...state,
      diagnostics: {
        ...diagnostics,
        runtimeBoot: {
          lastBootAt: row.at,
          count: Number(previous.count || 0) + 1,
          boots: filtered.slice(-30)
        }
      }
    };
  }).then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
  return true;
});
