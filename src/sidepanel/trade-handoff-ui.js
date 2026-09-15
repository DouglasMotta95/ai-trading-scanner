const atsHandoffButton = direction => document.getElementById(direction === 'BUY' ? 'prepareBuy' : 'prepareSell');
const atsHandoffStatus = () => document.getElementById('tradeActionStatus');
const atsNormExpiration = value => {
  const s = String(value || '').toLowerCase().replace(/\s+/g, '');
  let m = s.match(/^(\d{1,4})(?:s|seg|segundo|segundos)$/); if (m) return `${Number(m[1])}s`;
  m = s.match(/^(\d{1,3})(?:m|min|minuto|minutos)$/); return m ? `${Number(m[1]) * 60}s` : null;
};

async function atsSendToFrame(tabId, frameId, message) {
  if (!tabId || !chrome.tabs?.sendMessage) return null;
  try {
    if (Number.isInteger(Number(frameId)) && Number(frameId) >= 0) return await chrome.tabs.sendMessage(Number(tabId), message, { frameId: Number(frameId) });
  } catch {}
  try { return await chrome.tabs.sendMessage(Number(tabId), message); } catch { return null; }
}

async function atsPrepareTrade(direction) {
  const button = atsHandoffButton(direction);
  const status = atsHandoffStatus();
  if (!button || button.disabled || button.dataset.busy === '1') return;
  button.dataset.busy = '1';
  const original = button.textContent;
  button.textContent = direction === 'BUY' ? '🟢 LOCALIZANDO…' : '🔴 LOCALIZANDO…';
  try {
    const before = await chrome.runtime.sendMessage({ type: 'ATS_READ_SCANNER_STATE' }).catch(() => null);
    const beforeState = before?.state || {};
    const desiredExpiration = atsNormExpiration(beforeState.executionPreferences?.expiration || '60s') || '60s';
    const actualExpiration = atsNormExpiration(beforeState.platformControls?.observed?.expiration || '');
    if (!actualExpiration || actualExpiration !== desiredExpiration) {
      if (status) status.textContent = actualExpiration
        ? `ENTRADA BLOQUEADA: CasaTrade em ${actualExpiration}; ajuste para ${desiredExpiration}.`
        : `ENTRADA BLOQUEADA: confirme a expiração da CasaTrade (${desiredExpiration}).`;
      return;
    }

    const response = await chrome.runtime.sendMessage({ type: 'ATS_PREPARE_TRADE', direction }).catch(() => null);
    if (!response?.ok) {
      if (status) status.textContent = 'O sinal já mudou ou não está confirmado. Aguarde a próxima decisão.';
      return;
    }
    const state = response.state || {};
    const intent = response.intent || {};
    const focus = state.diagnostics?.focusedAsset || {};
    const message = {
      type: 'ATS_HIGHLIGHT_TRADE',
      direction,
      asset: state.asset || intent.asset || null,
      timeframe: state.analysisTimeframe || state.timeframe || intent.timeframe || null,
      expiration: actualExpiration,
      score: state.signal?.analysisScore ?? state.signal?.score ?? null
    };
    const handoff = await atsSendToFrame(state.targetTabId, focus.frameId, message);
    if (status) status.textContent = handoff?.found
      ? `${direction === 'BUY' ? 'COMPRA' : 'VENDA'} preparada: botão correto destacado. Confirme com seu toque na CasaTrade.`
      : 'Sinal preparado, mas não localizei o botão da CasaTrade com segurança. Confirme diretamente na plataforma.';
  } finally {
    button.textContent = original;
    delete button.dataset.busy;
  }
}

document.getElementById('prepareBuy')?.addEventListener('click', () => atsPrepareTrade('BUY').catch(() => {}));
document.getElementById('prepareSell')?.addEventListener('click', () => atsPrepareTrade('SELL').catch(() => {}));
