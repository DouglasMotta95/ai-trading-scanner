import { readScannerState, updateScannerState } from './services/scanner-state-atomic.js';

const host = value => String(value || '').toLowerCase().replace(/\.$/, '');
const casaHost = value => value === 'casatrade.com' || value.endsWith('.casatrade.com') || value === 'casatrade.io' || value.endsWith('.casatrade.io');
const traderHost = value => value === 'casatraders.online' || value.endsWith('.casatraders.online') || value === 'ivcasatraders.online' || value.endsWith('.ivcasatraders.online');
const num = value => value == null || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null;

function senderTrusted(sender = {}) {
  let frameHost = '', topHost = '';
  try { frameHost = host(new URL(sender.url || '').hostname); } catch {}
  try { topHost = host(new URL(sender.tab?.url || '').hostname); } catch {}
  return !!sender.tab?.id && casaHost(topHost) && (casaHost(frameHost) || traderHost(frameHost));
}

function mergeMetric(previous = {}, snapshot = {}, tabId) {
  const now = Date.now();
  const sameTab = Number(previous.tabId || 0) === Number(tabId || 0);
  const balance = num(snapshot.balance);
  const stake = num(snapshot.stake);
  const payoutPct = num(snapshot.payoutPct);
  const previousBalance = sameTab ? num(previous.balance) : null;
  const startBalance = sameTab && num(previous.startBalance) != null
    ? Number(previous.startBalance)
    : balance != null ? balance : previousBalance;
  const currentBalance = balance != null ? balance : previousBalance;
  const currentStake = stake != null ? stake : (sameTab ? num(previous.stake) : null);
  const riskPct = currentBalance != null && currentBalance > 0 && currentStake != null && currentStake >= 0
    ? Math.round((currentStake / currentBalance) * 10000) / 100
    : null;
  const sessionDelta = currentBalance != null && startBalance != null
    ? Math.round((currentBalance - startBalance) * 100) / 100
    : null;

  return {
    tabId: Number(tabId || 0),
    balance: currentBalance,
    stake: currentStake,
    payoutPct: payoutPct != null ? payoutPct : (sameTab ? num(previous.payoutPct) : null),
    currency: String(snapshot.currency || (sameTab ? previous.currency : '') || '').slice(0, 8) || null,
    startBalance,
    sessionDelta,
    riskPct,
    balanceAt: balance != null ? now : (sameTab ? Number(previous.balanceAt || 0) : 0),
    stakeAt: stake != null ? now : (sameTab ? Number(previous.stakeAt || 0) : 0),
    payoutAt: payoutPct != null ? now : (sameTab ? Number(previous.payoutAt || 0) : 0),
    source: String(snapshot.source || 'platform-dom-labelled').slice(0, 48),
    confidence: snapshot.confidence && typeof snapshot.confidence === 'object' ? snapshot.confidence : {},
    observedAt: now
  };
}

async function acceptMetrics(message = {}, sender = {}) {
  if (!senderTrusted(sender)) return { ok: false, error: 'untrusted_sender' };
  const tabId = Number(sender.tab?.id || 0);
  const state = await readScannerState();
  if (Number(state.targetTabId || 0) && Number(state.targetTabId) !== tabId) return { ok: false, error: 'wrong_tab' };
  const snapshot = message.snapshot && typeof message.snapshot === 'object' ? message.snapshot : {};
  const next = await updateScannerState(current => ({
    ...current,
    accountMetrics: mergeMetric(current.accountMetrics || {}, snapshot, tabId)
  }));
  return { ok: true, accountMetrics: next.accountMetrics };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'ATS_ACCOUNT_METRICS') {
    acceptMetrics(message, sender).then(sendResponse).catch(error => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }
  if (message?.type === 'ATS_GET_ACCOUNT_METRICS') {
    readScannerState().then(state => sendResponse({ ok: true, accountMetrics: state.accountMetrics || null })).catch(error => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }
  return false;
});
