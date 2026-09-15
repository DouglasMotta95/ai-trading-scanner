import { updateScannerState } from './services/scanner-state-atomic.js';

const clean = value => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
const num = value => value == null || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null;
const casaHost = value => value === 'casatrade.com' || value.endsWith('.casatrade.com') || value === 'casatrade.io' || value.endsWith('.casatrade.io');
const traderHost = value => value === 'casatraders.online' || value.endsWith('.casatraders.online') || value === 'ivcasatraders.online' || value.endsWith('.ivcasatraders.online');

function trusted(sender = {}) {
  let frameHost = '', topHost = '';
  try { frameHost = new URL(sender.url || '').hostname.toLowerCase(); } catch {}
  try { topHost = new URL(sender.tab?.url || '').hostname.toLowerCase(); } catch {}
  return !!sender.tab?.id && casaHost(topHost) && (casaHost(frameHost) || traderHost(frameHost));
}

function normExp(value = '') {
  const s = clean(value).toLowerCase().replace(/\s+/g, '');
  let m = s.match(/^(\d{1,4})(?:s|seg|segundo|segundos)$/); if (m) return `${Number(m[1])}s`;
  m = s.match(/^(\d{1,3})(?:m|min|minuto|minutos)$/); if (m) return `${Number(m[1]) * 60}s`;
  m = s.match(/^(\d{1,2}):(\d{2})$/); if (m) return `${Number(m[1]) * 60 + Number(m[2])}s`;
  return null;
}

function normTf(value = '') {
  const s = clean(value).toUpperCase().replace(/\s+/g, '');
  let m = s.match(/^M(\d{1,4})$/) || s.match(/^(\d{1,4})(?:M|MIN)$/); if (m) return `M${Number(m[1])}`;
  m = s.match(/^S(\d{1,5})$/) || s.match(/^(\d{1,5})S$/); if (m) return `S${Number(m[1])}`;
  m = s.match(/^H(\d{1,3})$/) || s.match(/^(\d{1,3})H$/); return m ? `H${Number(m[1])}` : null;
}

function safeObserved(snapshot = {}) {
  const amount = num(snapshot.amount);
  return {
    amount: amount != null && amount > 0 ? amount : null,
    expiration: normExp(snapshot.expiration),
    timeframe: normTf(snapshot.timeframe),
    source: clean(snapshot.source || 'casatrade-ui-v2').slice(0, 64),
    confidence: {
      amount: Math.max(0, num(snapshot.confidence?.amount) || 0),
      expiration: Math.max(0, num(snapshot.confidence?.expiration) || 0),
      timeframe: Math.max(0, num(snapshot.confidence?.timeframe) || 0)
    }
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'ATS_SET_EXECUTION_PREFERENCES') {
    const expiration = normExp(message.expiration || '60s') || '60s';
    updateScannerState(state => ({ ...state, executionPreferences: { ...(state.executionPreferences || {}), expiration } }))
      .then(state => sendResponse({ ok: true, executionPreferences: state.executionPreferences }))
      .catch(error => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }
  if (message?.type !== 'ATS_PLATFORM_CONTROLS_OBSERVED') return false;
  if (!trusted(sender)) { sendResponse({ ok: false, error: 'untrusted_sender' }); return false; }
  const tabId = Number(sender.tab?.id || 0);
  const observed = safeObserved(message.snapshot || {});
  updateScannerState(state => {
    if (Number(state.targetTabId || 0) && Number(state.targetTabId) !== tabId) return state;
    const desired = normExp(state.executionPreferences?.expiration || '60s') || '60s';
    const actual = observed.expiration;
    const expirationReady = !!actual && actual === desired;
    return {
      ...state,
      platformControls: {
        observed,
        checkedAt: Date.now(),
        frameId: Number(sender.frameId || 0),
        source: observed.source,
        aligned: expirationReady
      },
      diagnostics: {
        ...(state.diagnostics || {}),
        expirationGuard: {
          desired,
          actual,
          ready: expirationReady,
          reason: !actual ? 'Expiração da CasaTrade ainda não confirmada.' : expirationReady ? 'Expiração alinhada.' : `CasaTrade em ${actual}; esperado ${desired}.`,
          at: Date.now()
        }
      }
    };
  }).then(state => sendResponse({ ok: true, platformControls: state.platformControls, expirationGuard: state.diagnostics?.expirationGuard || null }))
    .catch(error => sendResponse({ ok: false, error: String(error?.message || error) }));
  return true;
});
