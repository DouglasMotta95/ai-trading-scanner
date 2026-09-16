import { readScannerState, updateScannerState } from './services/scanner-state-atomic.js';

const clean = (value, max = 240) => String(value ?? '').normalize('NFKC').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const host = value => clean(value, 200).toLowerCase().replace(/\.$/, '');
const casaHost = value => value === 'casatrade.com' || value.endsWith('.casatrade.com') || value === 'casatrade.io' || value.endsWith('.casatrade.io');
const traderHost = value => value === 'casatraders.online' || value.endsWith('.casatraders.online') || value === 'ivcasatraders.online' || value.endsWith('.ivcasatraders.online');
const SENSITIVE = /token|auth|cookie|session|password|secret|bearer|csrf|api[-_]?key|credential/i;

function senderTrusted(sender = {}) {
  let frameHost = '', topHost = '';
  try { frameHost = host(new URL(sender.url || '').hostname); } catch {}
  try { topHost = host(new URL(sender.tab?.url || '').hostname); } catch {}
  return !!sender.tab?.id && Number(sender.frameId) !== 0 && traderHost(frameHost) && casaHost(topHost);
}

function safeStrings(rows, maxItems, maxLength) {
  if (!Array.isArray(rows)) return [];
  const out = [];
  for (const raw of rows) {
    const value = clean(raw, maxLength);
    if (!value || SENSITIVE.test(value)) continue;
    if (!out.includes(value)) out.push(value);
    if (out.length >= maxItems) break;
  }
  return out;
}

function safeSnapshot(raw = {}, sender = {}) {
  const candidate = raw.focusedCandidate && typeof raw.focusedCandidate === 'object' ? raw.focusedCandidate : null;
  const trade = raw.tradeEvidence && typeof raw.tradeEvidence === 'object' ? raw.tradeEvidence : {};
  return {
    at: Date.now(),
    frameId: Number(sender.frameId),
    transports: {
      primary: clean(raw.transports?.primary, 24) || null,
      messages: raw.transports?.messages && typeof raw.transports.messages === 'object' ? {
        ws: Number(raw.transports.messages.ws || 0), fetch: Number(raw.transports.messages.fetch || 0), xhr: Number(raw.transports.messages.xhr || 0)
      } : {},
      connections: { ws: Number(raw.transports?.connections?.ws || 0) }
    },
    endpoints: safeStrings(raw.endpoints, 12, 240),
    keys: safeStrings(raw.keys, 80, 64),
    tradeEvidence: {
      detected: trade.detected === true,
      keys: safeStrings(trade.keys, 30, 64),
      endpoints: safeStrings(trade.endpoints, 12, 240),
      observedAt: Number(trade.observedAt || 0) || Date.now()
    },
    rawCandidateCount: Math.max(0, Number(raw.rawCandidateCount || 0)),
    candleCount: Math.max(0, Number(raw.candleCount || 0)),
    focusedCandidate: candidate ? {
      asset: clean(candidate.asset, 64),
      price: Number.isFinite(Number(candidate.price)) ? Number(candidate.price) : null,
      bid: Number.isFinite(Number(candidate.bid)) ? Number(candidate.bid) : null,
      ask: Number.isFinite(Number(candidate.ask)) ? Number(candidate.ask) : null,
      timeframe: clean(candidate.timeframe, 24),
      expiration: clean(candidate.expiration, 24),
      transport: clean(candidate.transport, 24),
      confidence: Math.max(0, Math.min(100, Number(candidate.confidence || 0))),
      selected: candidate.selected === true
    } : null
  };
}

async function accept(message = {}, sender = {}) {
  if (!senderTrusted(sender)) return { ok: false, error: 'untrusted_sender' };
  const state = await readScannerState();
  if (Number(state.targetTabId || 0) && Number(state.targetTabId) !== Number(sender.tab?.id || 0)) return { ok: false, error: 'wrong_tab' };
  const snapshot = safeSnapshot(message.snapshot || {}, sender);
  await updateScannerState(current => ({
    ...current,
    diagnostics: { ...(current.diagnostics || {}), dataInspector: snapshot }
  }));
  return { ok: true };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'ATS_DATA_INSPECTOR') return false;
  accept(message, sender).then(sendResponse).catch(error => sendResponse({ ok: false, error: String(error?.message || error) }));
  return true;
});
