import { readScannerState, updateScannerState } from './services/scanner-state-atomic.js';

const host = value => String(value || '').toLowerCase().replace(/\.$/, '');
const casaHost = value => value === 'casatrade.com' || value.endsWith('.casatrade.com') || value === 'casatrade.io' || value.endsWith('.casatrade.io');
const traderHost = value => value === 'casatraders.online' || value.endsWith('.casatraders.online') || value === 'ivcasatraders.online' || value.endsWith('.ivcasatraders.online');
const num = value => value == null || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null;
const MIN_CONFIDENCE = { balance: 8, stake: 8, payout: 9 };
const METRIC_FRESH_MS = 5000;

function senderTrusted(sender = {}) {
  let frameHost = '', topHost = '';
  try { frameHost = host(new URL(sender.url || '').hostname); } catch {}
  try { topHost = host(new URL(sender.tab?.url || '').hostname); } catch {}
  return !!sender.tab?.id && (casaHost(topHost) || traderHost(topHost)) && (casaHost(frameHost) || traderHost(frameHost));
}

function candidate(previous = {}, snapshot = {}, key, atKey, now) {
  const value = num(snapshot[key === 'payout' ? 'payoutPct' : key]);
  const confidence = Math.max(0, num(snapshot.confidence?.[key]) || 0);
  const oldValue = num(previous[key === 'payout' ? 'payoutPct' : key]);
  const oldConfidence = Math.max(0, num(previous.confidence?.[key]) || 0);
  const oldAt = Number(previous[atKey] || 0);
  const oldFresh = oldAt > 0 && now - oldAt <= METRIC_FRESH_MS;
  const positiveRequired = key === 'balance' || key === 'stake' || key === 'payout';

  if (value == null || (positiveRequired && value <= 0) || confidence < MIN_CONFIDENCE[key]) {
    return { value: oldFresh && oldValue != null && (!positiveRequired || oldValue > 0) ? oldValue : null, confidence: oldFresh ? oldConfidence : 0, at: oldFresh ? oldAt : 0, accepted: false };
  }
  if (oldValue == null || !oldFresh || confidence >= oldConfidence) return { value, confidence, at: now, accepted: true };
  return { value: oldValue, confidence: oldConfidence, at: oldAt, accepted: false };
}

function mergeMetric(previous = {}, snapshot = {}, tabId) {
  const now = Date.now();
  const sameTab = Number(previous.tabId || 0) === Number(tabId || 0);
  const base = sameTab ? previous : {};
  const balance = candidate(base, snapshot, 'balance', 'balanceAt', now);
  const stake = candidate(base, snapshot, 'stake', 'stakeAt', now);
  const payout = candidate(base, snapshot, 'payout', 'payoutAt', now);

  const currentBalance = balance.value;
  const currentStake = stake.value;
  const previousStart = sameTab ? num(previous.startBalance) : null;
  const previousStartConfidence = sameTab ? Math.max(0, num(previous.startBalanceConfidence) || 0) : 0;
  let startBalance = previousStart;
  let startBalanceConfidence = previousStartConfidence;
  if (currentBalance != null && currentBalance > 0 && (startBalance == null || startBalance <= 0 || (balance.accepted && balance.confidence > previousStartConfidence && Number(previous.balanceAt || 0) && now - Number(previous.balanceAt || 0) < 2500))) {
    startBalance = currentBalance;
    startBalanceConfidence = balance.confidence;
  }

  const riskPct = currentBalance != null && currentBalance > 0 && currentStake != null && currentStake > 0
    ? Math.round((currentStake / currentBalance) * 10000) / 100
    : null;
  const sessionDelta = currentBalance != null && startBalance != null && startBalance > 0
    ? Math.round((currentBalance - startBalance) * 100) / 100
    : null;

  const incomingCurrency = String(snapshot.currency || '').slice(0, 8) || null;
  const currency = incomingCurrency && (balance.accepted || stake.accepted)
    ? incomingCurrency
    : String(base.currency || '').slice(0, 8) || null;

  return {
    tabId: Number(tabId || 0),
    balance: currentBalance,
    stake: currentStake,
    payoutPct: payout.value,
    currency,
    startBalance,
    startBalanceConfidence,
    sessionDelta,
    riskPct,
    balanceAt: balance.at,
    stakeAt: stake.at,
    payoutAt: payout.at,
    source: String(snapshot.source || base.source || 'platform-dom-labelled').slice(0, 48),
    confidence: { balance: balance.confidence, stake: stake.confidence, payout: payout.confidence },
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
