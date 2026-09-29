const atsHandoffButton = direction => document.getElementById(direction === 'BUY' ? 'prepareBuy' : 'prepareSell');
const atsHandoffStatus = () => document.getElementById('tradeActionStatus');
const atsClean = value => String(value ?? '').trim();
const atsNormExpiration = value => {
  const s = atsClean(value).toLowerCase().replace(/\s+/g, '');
  let m = s.match(/^(\d{1,5})(?:s|seg|segundo|segundos)$/); if (m) return `${Number(m[1])}s`;
  m = s.match(/^(\d{1,4})(?:m|min|minuto|minutos)$/); if (m) return `${Number(m[1]) * 60}s`;
  m = s.match(/^(\d{1,3}):(\d{2})$/); return m ? `${Number(m[1]) * 60 + Number(m[2])}s` : null;
};

function atsClockBoundToFocus(clock = {}, focus = {}) {
  const sameFrame = Number(clock.frameId) === Number(focus.frameId)
    && atsClean(clock.frameHost).toLowerCase() === atsClean(focus.frameHost).toLowerCase();
  const boundControlFrame = clock.crossFrameControl === true
    && Number(clock.boundFocusFrameId) === Number(focus.frameId)
    && atsClean(clock.boundFocusFrameHost).toLowerCase() === atsClean(focus.frameHost).toLowerCase();
  return sameFrame || boundControlFrame;
}

function atsExactTimeReady(state = {}) {
  const clock = state.diagnostics?.marketClock || {};
  const focus = state.diagnostics?.focusedAsset || {};
  const professional = state.professionalDecision || {};
  const actualExpiration = atsNormExpiration(state.platformControls?.observed?.expiration || '');
  const controlsFresh = Number(state.platformControls?.checkedAt || 0) > 0 && Date.now() - Number(state.platformControls.checkedAt) < 7000;
  return professional.timeReady === true
    && professional.expirationReady === true
    && professional.actionable === true
    && clock.verified === true
    && clock.available !== false
    && clock.role === 'candle-close'
    && ['trader-dom-countdown', 'network-server-cycle'].includes(String(clock.source || ''))
    && Number(clock.at || 0) > 0
    && Date.now() - Number(clock.at) < 3000
    && atsClockBoundToFocus(clock, focus)
    && !!actualExpiration
    && controlsFresh;
}

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
    const before = await chrome.runtime.sendMessage({ type: 'ATS_READ_SCANNER_STATE' }).catch(() => null);
    const beforeState = before?.state || {};
    const expectedUi = direction === 'BUY' ? 'ENTER_BUY' : 'ENTER_SELL';
    const professional = beforeState.professionalDecision || {};
    const actualExpiration = atsNormExpiration(beforeState.platformControls?.observed?.expiration || '');

    if (professional.uiState !== expectedUi || professional.direction !== direction || professional.actionable !== true) {
      if (status) status.textContent = 'O padrão ainda não está confirmado para esta direção. Aguarde a próxima decisão.';
      return;
    }
    if (!atsExactTimeReady(beforeState)) {
      if (status) status.textContent = 'ENTRADA BLOQUEADA: countdown, timeframe ou expiração real da CasaTrade não estão sincronizados.';
      return;
    }

    const response = await chrome.runtime.sendMessage({ type: 'ATS_PREPARE_TRADE', direction }).catch(() => null);
    if (!response?.ok) {
      if (status) status.textContent = response?.error === 'time_not_synchronized'
        ? 'ENTRADA BLOQUEADA: o tempo da CasaTrade mudou. Aguarde a nova sincronização.'
        : 'O sinal já mudou ou perdeu a confirmação. Aguarde a próxima decisão.';
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
      score: state.professionalDecision?.score ?? state.signal?.analysisScore ?? state.signal?.score ?? null
    };
    const handoff = await atsSendToFrame(state.targetTabId, focus.frameId, message);
    if (status) status.textContent = handoff?.found
      ? `${direction === 'BUY' ? 'COMPRA' : 'VENDA'} preparada com expiração CasaTrade ${actualExpiration}. Confirme com seu toque na plataforma CasaTrade.`
      : 'Sinal confirmado, mas o botão da CasaTrade não foi localizado com segurança. Confirme manualmente na plataforma.';
  } finally {
    button.textContent = original;
    delete button.dataset.busy;
  }
}

document.getElementById('prepareBuy')?.addEventListener('click', () => atsPrepareTrade('BUY').catch(() => {}));
document.getElementById('prepareSell')?.addEventListener('click', () => atsPrepareTrade('SELL').catch(() => {}));
