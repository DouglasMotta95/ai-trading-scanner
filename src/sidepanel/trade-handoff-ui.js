const atsHandoffButton = direction => document.getElementById(direction === 'BUY' ? 'prepareBuy' : 'prepareSell');
const atsHandoffStatus = () => document.getElementById('tradeActionStatus');

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
      expiration: state.targetExpiration || state.expiration || intent.expiration || null,
      score: state.signal?.analysisScore ?? state.signal?.score ?? null
    };
    const handoff = await atsSendToFrame(state.targetTabId, focus.frameId, message);
    if (status) status.textContent = handoff?.found
      ? `${direction === 'BUY' ? 'COMPRA' : 'VENDA'} preparada: o botão correto da CasaTrade foi destacado. Confirme com seu toque na plataforma.`
      : 'Sinal preparado, mas não localizei o botão da CasaTrade com segurança. Confirme diretamente na plataforma.';
  } finally {
    button.textContent = original;
    delete button.dataset.busy;
  }
}

document.getElementById('prepareBuy')?.addEventListener('click', () => atsPrepareTrade('BUY').catch(() => {}));
document.getElementById('prepareSell')?.addEventListener('click', () => atsPrepareTrade('SELL').catch(() => {}));
