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

function inspectDecisionAlert(state = {}) {
  const decision = state.professionalDecision || {};
  const seconds = num(decision.secondsRemaining);
  const cycleKey = clean(decision.cycleKey);
  const timeframe = normTimeframe(decision.timeframe);
  const expiration = normExpiration(decision.actualExpiration);
  const ui = clean(decision.uiState).toUpperCase();
  const direction = clean(decision.direction).toUpperCase();
  const side = direction === 'BUY' ? 'COMPRA' : direction === 'SELL' ? 'VENDA' : null;
  const pattern = decision.pullbackContinuation || state.signal?.analytics?.pullbackContinuation || {};
  const patternQualified = pattern.qualified === true
    && pattern.direction === direction
    && pattern.notStretched === true
    && Number(pattern.score) >= 80
    && Number(pattern.roomToLevel) >= 0.35;

  let reason = '';
  if (state.scanner !== 'scanning') reason = 'Scanner não está no estado scanning.';
  else if (state.connection !== 'online') reason = 'Conexão com CasaTrade não está online.';
  else if (decision.timeReady !== true) reason = 'Relógio exato da vela não está validado.';
  else if (decision.expirationReady !== true) reason = 'Expiração/timeframe não estão alinhados.';
  else if (!timeframe) reason = 'Timeframe da decisão não é M1 nem M5.';
  else if (expiration !== MODE_EXPIRATION[timeframe]) reason = `Expiração ${expiration || 'não confirmada'} incompatível com ${timeframe}.`;
  else if (!cycleKey) reason = 'A decisão não tem identificador de ciclo/vela.';
  else if (seconds == null || seconds <= 0) reason = 'Countdown ausente ou vela já encerrada.';
  const alertWindow = patternQualified ? (timeframe === 'M5' ? 120 : 45) : 30;
  if (!reason && seconds > alertWindow) reason = patternQualified
    ? `Fora da janela de aviso do padrão: ${seconds}s > ${alertWindow}s.`
    : `Fora da janela de pré-sinal: ${seconds}s > ${alertWindow}s.`;
  if (!reason && !side) reason = 'A decisão não tem direção BUY/SELL.';
  let stage = null;
  if (!reason && seconds > 10) {
    if (!['POSSIBLE_BUY','POSSIBLE_SELL'].includes(ui)) reason = `Estado ${ui || 'vazio'} não é um pré-sinal notificável.`;
    else if ((ui === 'POSSIBLE_BUY' && direction !== 'BUY') || (ui === 'POSSIBLE_SELL' && direction !== 'SELL')) reason = 'Direção e estado do pré-sinal estão inconsistentes.';
    else stage = 'pre';
  } else if (!reason) {
    const confirmedBuy = ui === 'ENTER_BUY' && direction === 'BUY';
    const confirmedSell = ui === 'ENTER_SELL' && direction === 'SELL';
    if (!confirmedBuy && !confirmedSell) reason = `Últimos 10s, mas estado é ${ui || 'vazio'}; AGUARDAR não gera sinal final.`;
    else stage = 'final';
  }
  return {
    eligible: !reason && !!stage,
    stage,
    reason: reason || 'Elegível para notificação.',
    cycleKey, seconds, timeframe, expiration, ui, direction, side,
    patternQualified, patternScore: num(pattern.score), roomToLevel: num(pattern.roomToLevel),
    alertWindow
  };
}

export function explainDecisionAlertEligibility(state = {}) {
  const result = inspectDecisionAlert(state);
  return { eligible: result.eligible, stage: result.stage, reason: result.reason, seconds: result.seconds, alertWindow: result.alertWindow, cycleKey: result.cycleKey };
}

/**
 * Returns a browser notification only for a time-, mode- and direction-aligned signal.
 * All blocked outcomes have a companion explanation through explainDecisionAlertEligibility().
 */
export function qualifiedDecision(state = {}) {
  const check = inspectDecisionAlert(state);
  if (!check.eligible) return null;
  const { stage, cycleKey, seconds, timeframe, side, direction, patternQualified } = check;
  if (stage === 'pre') {
    const pattern = state.professionalDecision?.pullbackContinuation || state.signal?.analytics?.pullbackContinuation || {};
    return {
      stage, cycleKey, seconds, label: side, timeframe, direction,
      title: patternQualified ? 'Padrão para a próxima vela' : 'Pré-sinal',
      message: patternQualified
        ? side + ' na próxima vela — pullback/retomada ' + Math.round(Number(pattern.score || 0)) + '/100, sem esticamento; espaço ' + Number(pattern.roomToLevel).toFixed(1) + '× faixa média — ' + clean(state.asset || 'ATIVO') + ' ' + timeframe
        : 'Possível ' + side + ' — ' + clean(state.asset || 'ATIVO') + ' ' + timeframe
    };
  }
  return {
    stage, cycleKey, seconds, label: side, timeframe, direction,
    title: 'Sinal confirmado',
    message: side + ' — ' + clean(state.asset || 'ATIVO') + ' ' + timeframe
  };
}
