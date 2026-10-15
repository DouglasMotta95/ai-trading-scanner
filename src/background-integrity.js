import {
  repairMarketSessionIntegrity,
  marketSessionEpoch
} from './background-market-session.js';

const clean = value => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
const num = value => value == null || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null;
const casaHost = value => value === 'casatrade.com' || value.endsWith('.casatrade.com') || value === 'casatrade.io' || value.endsWith('.casatrade.io');
const traderHost = value => value === 'casatraders.online' || value.endsWith('.casatraders.online') || value === 'ivcasatraders.online' || value.endsWith('.ivcasatraders.online');
const licenseActive = state => ['active', 'valid'].includes(String(state?.license?.status || '').toLowerCase());
const FOCUS_FRESH_MS = 2600;
const CLOCK_FRESH_MS = 2200;
let integrityRepairing = false;
let repeatedIssueKey = '';
let repeatedIssueCount = 0;
let repeatedIssueSince = 0;

function normAsset(value = '') {
  const raw = clean(value).toUpperCase();
  if (!raw || raw.length > 100) return '';
  const otc = /(?:\(|\b|[_-])OTC(?:\)|\b)?/i.test(raw);
  const direct = raw.match(/\b([A-Z0-9]{2,20})\s*[\/_-]\s*([A-Z0-9]{2,12})/i);
  if (direct) return `${direct[1]}/${direct[2]}${otc ? ' (OTC)' : ''}`;
  const compact = raw.match(/\b([A-Z]{3})([A-Z]{3})\b/);
  return compact ? `${compact[1]}/${compact[2]}${otc ? ' (OTC)' : ''}` : '';
}

const identity = value => normAsset(value).replace(/\s*\(OTC\)\s*$/i, '');
const sameAsset = (a, b) => !!identity(a) && identity(a) === identity(b);

function senderMeta(sender = {}) {
  let frameHost = '', topHost = '';
  try { frameHost = new URL(sender.url || '').hostname.toLowerCase(); } catch {}
  try { topHost = new URL(sender.tab?.url || '').hostname.toLowerCase(); } catch {}
  const embeddedTrader = sender.frameId !== 0 && traderHost(frameHost) && casaHost(topHost);
  return { trusted: !!sender.tab?.id && embeddedTrader, embeddedTrader, frameHost, topHost, frameId: sender.frameId };
}

function focusValid(state, now = Date.now()) {
  const focus = state?.diagnostics?.focusedAsset || null;
  return !!normAsset(focus?.asset)
    && focus?.reliable === true
    && focus?.chartScoped === true
    && (focus?.embeddedTrader === true || focus?.casaTradeFrame === true)
    && (traderHost(clean(focus?.frameHost).toLowerCase()) || casaHost(clean(focus?.frameHost).toLowerCase()))
    && now - Number(focus?.at || 0) < FOCUS_FRESH_MS;
}

function clockValid(state, now = Date.now()) {
  const focus = state?.diagnostics?.focusedAsset || null;
  const clock = state?.diagnostics?.marketClock || null;
  return focusValid(state, now)
    && clock?.verified === true
    && clean(clock?.role) === 'candle-close'
    && clean(clock?.source) === 'trader-dom-countdown'
    && now - Number(clock?.at || 0) < CLOCK_FRESH_MS
    && sameAsset(clock?.asset, focus?.asset)
    && (
      (Number(clock?.frameId) === Number(focus?.frameId)
        && clean(clock?.frameHost).toLowerCase() === clean(focus?.frameHost).toLowerCase())
      || (clock?.crossFrameControl === true
        && Number(clock?.boundFocusFrameId) === Number(focus?.frameId)
        && clean(clock?.boundFocusFrameHost).toLowerCase() === clean(focus?.frameHost).toLowerCase())
    )
    && num(clock?.secondsRemaining) != null;
}

function stateIntegrityIssue(nextState = {}) {
  if (!licenseActive(nextState)) return null;
  const now = Date.now();
  const validFocus = focusValid(nextState, now);
  const focusAsset = validFocus ? normAsset(nextState.diagnostics?.focusedAsset?.asset) : '';
  const session = nextState.diagnostics?.marketSession || {};
  const sessionAsset = normAsset(session.asset || session.pendingAsset || session.confirmedAsset || '');
  const assetMismatch = !!nextState.asset && !!sessionAsset && !sameAsset(nextState.asset, sessionAsset);
  const focusSessionMismatch = !!focusAsset && !!sessionAsset && !sameAsset(focusAsset, sessionAsset);
  if (!validFocus || assetMismatch || focusSessionMismatch) {
    return {
      epoch: marketSessionEpoch(nextState),
      validFocus,
      focusAsset: focusAsset || null,
      sessionAsset: sessionAsset || null,
      reason: !validFocus ? 'awaiting_visible_chart_asset' : 'market_session_mismatch'
    };
  }
  return null;
}

chrome.storage.onChanged.addListener(changes => {
  if (!changes.scannerState || integrityRepairing) return;
  const nextState = changes.scannerState.newValue || {};
  const issue = stateIntegrityIssue(nextState);
  if (!issue) {
    repeatedIssueKey = '';
    repeatedIssueCount = 0;
    repeatedIssueSince = 0;
    return;
  }

  const issueKey = [
    issue.epoch, issue.reason, issue.focusAsset || '', issue.sessionAsset || '',
    normAsset(nextState.asset || '')
  ].join('|');
  const now = Date.now();
  if (issueKey !== repeatedIssueKey || now - repeatedIssueSince > 2500) {
    repeatedIssueKey = issueKey;
    repeatedIssueCount = 1;
    repeatedIssueSince = now;
    return;
  }
  repeatedIssueCount += 1;
  // A single missed iframe/DOM observation is not a session failure. Require
  // several consecutive matching failures before asking the owner to repair.
  if (repeatedIssueCount < 3 || now - repeatedIssueSince < 350) return;

  integrityRepairing = true;
  repairMarketSessionIntegrity(nextState).finally(() => {
    integrityRepairing = false;
    repeatedIssueKey = '';
    repeatedIssueCount = 0;
    repeatedIssueSince = 0;
  });
});

async function injectIntegrityReaders(tabId) {
  if (!tabId || !chrome.scripting?.executeScript) return;
  const files = ['src/content/focused-asset-v2.js', 'src/content/market-clock-sync.js', 'src/content/analysis-visual-overlay-v2.js'];
  for (const file of files) {
    try { await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: [file], world: 'ISOLATED' }); } catch {}
  }
}

function maybeInject(tab) {
  if (!tab?.id || !tab.url) return;
  let h = '';
  try { h = new URL(tab.url).hostname.toLowerCase(); } catch {}
  if (casaHost(h)) injectIntegrityReaders(tab.id);
}

chrome.tabs?.onActivated?.addListener(async info => {
  try { const tab = await chrome.tabs.get(info.tabId); maybeInject(tab); } catch {}
});
chrome.tabs?.onUpdated?.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' || changeInfo.url) maybeInject({ ...tab, id: tabId });
});
try {
  chrome.tabs?.query?.({ active: true, currentWindow: true }, tabs => {
    void chrome.runtime?.lastError;
    maybeInject(tabs?.[0]);
  });
} catch {}

