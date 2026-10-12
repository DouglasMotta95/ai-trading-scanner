const clean = value => String(value ?? '').trim();
const num = value => value == null || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null;

function normTimeframe(value = '') {
  const raw = clean(value).toUpperCase().replace(/\s+/g, '');
  if (raw === 'M1' || raw === '1M' || raw === '1MIN' || raw === '1MINUTE') return 'M1';
  if (raw === 'M5' || raw === '5M' || raw === '5MIN' || raw === '5MINUTE') return 'M5';
  return null;
}

function normExpiration(value = '') {
  const raw = clean(value).toLowerCase().replace(/\s+/g, '');
  if (['60s','60sec','60secs','1m','1min','1minute','1minutes','1minuto','1minutos'].includes(raw)) return '60s';
  if (['300s','300sec','300secs','5m','5min','5minute','5minutes','5minuto','5minutos'].includes(raw)) return '300s';
  return null;
}

const MODE_EXPIRATION = Object.freeze({ M1: '60s', M5: '300s' });

/**
 * Returns a browser-notification event only for a valid M1/M5 signal.
 * This function is deliberately pure so M1, M5 and no-trade cases can be unit tested.
 */
export function qualifiedDecision(state = {}) {
  const decision = state.professionalDecision || {};
  const seconds = num(decision.secondsRemaining);
  const cycleKey = clean(decision.cycleKey);
  const timeframe = normTimeframe(decision.timeframe);
  const expiration = normExpiration(decision.actualExpiration);

  if (state.scanner !== 'scanning' || state.connection !== 'online') return null;
  if (decision.timeReady !== true || decision.expirationReady !== true) return null;
  if (!timeframe || expiration !== MODE_EXPIRATION[timeframe]) return null;
  if (!cycleKey || seconds == null || seconds <= 0 || seconds > 30) return null;

  const ui = clean(decision.uiState).toUpperCase();
  const direction = clean(decision.direction).toUpperCase();
  const side = direction === 'BUY' ? 'COMPRA' : direction === 'SELL' ? 'VENDA' : null;
  if (!side) return null;

  if (seconds > 10) {
    if (!['POSSIBLE_BUY', 'POSSIBLE_SELL'].includes(ui)) return null;
    if ((ui === 'POSSIBLE_BUY' && direction !== 'BUY') || (ui === 'POSSIBLE_SELL' && direction !== 'SELL')) return null;
    return {
      stage: 'pre',
      cycleKey,
      seconds,
      label: side,
      timeframe,
      title: 'Pré-sinal',
      message: 'Possível ' + side + ' — ' + clean(state.asset || 'ATIVO') + ' ' + timeframe
    };
  }

  // Never issue a final notification for AGUARDAR or a direction mismatch.
  const confirmedBuy = ui === 'ENTER_BUY' && direction === 'BUY';
  const confirmedSell = ui === 'ENTER_SELL' && direction === 'SELL';
  if (!confirmedBuy && !confirmedSell) return null;

  return {
    stage: 'final',
    cycleKey,
    seconds,
    label: side,
    timeframe,
    title: 'Sinal confirmado',
    message: side + ' — ' + clean(state.asset || 'ATIVO') + ' ' + timeframe
  };
}
