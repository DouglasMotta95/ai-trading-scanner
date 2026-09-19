const atsHandoffButton = direction => document.getElementById(direction === 'BUY' ? 'prepareBuy' : 'prepareSell');
const atsHandoffStatus = () => document.getElementById('tradeActionStatus');
const atsClean = value => String(value ?? '').trim();
const atsNormExpiration = value => {
  const s = atsClean(value).toLowerCase().replace(/\s+/g, '');
  let m = s.match(/^(\d{1,5})(?:s|seg|segundo|segundos)$/); if (m) return `${Number(m[1])}s`;
  m = s.match(/^(\d{1,4})(?:m|min|minuto|minutos)$/); if (m) return `${Number(m[1]) * 60}s`;
  m = s.match(/^(\d{1,3}):(\d{2})$/); return m ? `${Number(m[1]) * 60 + Number(m[2])}s` : null;
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
  button.textContent = direction === 'BUY' ? '🟢 PREPARANDO…' : '🔴 PREPARANDO…';
  try {
    // background-control is the single execution gate. It validates the current
    // orchestrator ENTER signal, focused asset and selected M1/M5 operation plan.
    const response = await chrome.runtime.sendMessage({ type: 'ATS_PREPARE_TRADE', direction }).catch(() => null);
    if (!response?.ok) {
      if (status) status.textContent = response?.error === 'signal_not_ready'
        ? 'O sinal perdeu a confirmação ou o ativo mudou. Aguarde a próxima decisão.'
        : 'O padrão ainda não está confirmado para esta direção. Aguarde a próxima decisão.';
      return;
    }

    const state = response.state || {};
    const intent = response.intent || {};
    const focus = state.diagnostics?.focusedAsset || {};
    const message = {
      type: 'ATS_HIGHLIGHT_TRADE',
      direction,
      asset: state.asset || intent.asset || null,
      timeframe: intent.timeframe || state.analysisTimeframe || state.timeframe || null,
      expiration: intent.expiration || null,
      score: state.signal?.qualityScore ?? state.signal?.aPlus?.score ?? state.signal?.analysisScore ?? state.signal?.score ?? null
    };
    const handoff = await atsSendToFrame(state.targetTabId, focus.frameId, message);
    if (status) status.textContent = handoff?.found
      ? `${direction === 'BUY' ? 'COMPRA' : 'VENDA'} preparada • ${intent.timeframe || '—'} • expiração ${intent.expiration || '—'}. Confirme com seu toque na CasaTrade.`
      : 'Sinal confirmado, mas o botão da CasaTrade não foi localizado com segurança. Confirme manualmente na plataforma.';
  } finally {
    button.textContent = original;
    delete button.dataset.busy;
  }
}

document.getElementById('prepareBuy')?.addEventListener('click', () => atsPrepareTrade('BUY').catch(() => {}));
document.getElementById('prepareSell')?.addEventListener('click', () => atsPrepareTrade('SELL').catch(() => {}));
