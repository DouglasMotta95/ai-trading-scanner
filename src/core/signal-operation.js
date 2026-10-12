const clean = value => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
const num = value => value == null || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null;

export function operationMarketId(value = '') {
  const raw = clean(value).toUpperCase();
  if (!raw) return '';
  const otc = /(?:\(|\b|[_-])OTC(?:\)|\b)?/i.test(raw);
  const pair = raw.match(/\b([A-Z0-9]{2,20})\s*[\/_-]\s*([A-Z0-9]{2,12})/i);
  return pair ? pair[1] + '/' + pair[2] + (otc ? ' (OTC)' : '') : raw;
}
export const sameOperationMarket = (a, b) => !!operationMarketId(a) && operationMarketId(a) === operationMarketId(b);

export function operationTimeframeMs(value = 'M1') {
  const tf = clean(value).toUpperCase().replace(/\s+/g, '');
  let match = tf.match(/^S(\d+)$/); if (match) return Math.max(1, Number(match[1])) * 1000;
  match = tf.match(/^M(\d+)$/); if (match) return Math.max(1, Number(match[1])) * 60000;
  match = tf.match(/^(\d+)M$/); if (match) return Math.max(1, Number(match[1])) * 60000;
  match = tf.match(/^H(\d+)$/); if (match) return Math.max(1, Number(match[1])) * 3600000;
  return 60000;
}

function operationRecordId(asset, timeframe, targetStart, direction) {
  return [operationMarketId(asset), clean(timeframe).toUpperCase(), Number(targetStart || 0), clean(direction).toUpperCase()].join('|');
}
function targetHistoryRow(operation, history = []) {
  return (Array.isArray(history) ? history : []).find(row => row
    && ((operation.signalId && row.id === operation.signalId)
      || (sameOperationMarket(row.asset, operation.asset)
        && clean(row.timeframe).toUpperCase() === clean(operation.timeframe).toUpperCase()
        && clean(row.direction).toUpperCase() === clean(operation.direction).toUpperCase()
        && Number(row.targetStart || 0) === Number(operation.targetStart || 0)))) || null;
}

export function createActiveSignalOperation(state = {}, decision = {}, now = Date.now()) {
  const direction = clean(decision.direction).toUpperCase();
  const ui = clean(decision.uiState).toUpperCase();
  if (decision.actionable !== true || !['BUY', 'SELL'].includes(direction) || ui !== 'ENTER_' + direction) return null;
  const signal = state.signal || {};
  const signalDirection = clean(signal.direction || signal.analysisDirection).toUpperCase();
  if (signalDirection !== direction) return null;
  const asset = operationMarketId(state.asset || signal.asset || '');
  const timeframe = clean(decision.timeframe || state.analysisTimeframe || state.timeframe || signal.timeframe || 'M1').toUpperCase();
  const tfMs = operationTimeframeMs(timeframe);
  const rawStart = num(signal.targetStart ?? state.decisionCycle?.targetStart);
  if (!asset || rawStart == null || rawStart <= 0) return null;
  const targetStart = Math.round(rawStart / tfMs) * tfMs;
  const targetEnd = targetStart + tfMs;
  if (targetEnd <= now) return null;
  const id = operationRecordId(asset, timeframe, targetStart, direction);
  return {
    id, signalId: id, asset, timeframe, direction, targetStart, targetEnd,
    createdAt: now, status: now < targetStart ? 'ARMED' : 'IN_PROGRESS',
    score: num(decision.score ?? signal.analysisScore ?? signal.score),
    setup: signal.setup || state.decisionCycle?.setup || null,
    candleOpenPrice: null, candleClosePrice: null, result: null, resolvedAt: null
  };
}

export function reconcileActiveSignalOperation(operation = null, history = [], now = Date.now()) {
  if (!operation || !['BUY', 'SELL'].includes(clean(operation.direction).toUpperCase())) return null;
  const timeframe = clean(operation.timeframe || 'M1').toUpperCase();
  const tfMs = operationTimeframeMs(timeframe);
  const targetStart = Math.round(Number(operation.targetStart || 0) / tfMs) * tfMs;
  if (!Number.isFinite(targetStart) || targetStart <= 0) return null;
  const targetEnd = Number(operation.targetEnd || targetStart + tfMs);
  const row = targetHistoryRow({ ...operation, timeframe, targetStart }, history);
  const historyResult = clean(row?.result).toUpperCase();
  const result = ['WIN', 'LOSS', 'DRAW'].includes(historyResult) ? historyResult : null;
  const status = result && now >= targetEnd ? 'COMPLETED'
    : now >= targetEnd ? 'SETTLING'
      : now >= targetStart ? 'IN_PROGRESS' : 'ARMED';
  return {
    ...operation,
    id: operation.id || operationRecordId(operation.asset, timeframe, targetStart, operation.direction),
    signalId: operation.signalId || row?.id || operationRecordId(operation.asset, timeframe, targetStart, operation.direction),
    timeframe, targetStart, targetEnd, status,
    candleOpenPrice: num(row?.entryPrice) ?? num(operation.candleOpenPrice),
    candleClosePrice: num(row?.exitPrice) ?? num(operation.candleClosePrice),
    result: result || operation.result || null,
    resolvedAt: row?.resolvedAt || operation.resolvedAt || null,
    updatedAt: now
  };
}
export function signalOperationHolds(operation = null) {
  return !!operation && operation.status !== 'COMPLETED' && ['BUY', 'SELL'].includes(clean(operation.direction).toUpperCase());
}
export function operationDecision(state = {}, operation = {}, now = Date.now(), common = {}) {
  const direction = clean(operation.direction).toUpperCase();
  const side = direction === 'BUY' ? 'COMPRA' : 'VENDA';
  const entryWindowOpen = now <= Number(operation.targetStart || 0) + 6500;
  const status = operation.status || (now < Number(operation.targetStart) ? 'ARMED' : now < Number(operation.targetEnd) ? 'IN_PROGRESS' : 'SETTLING');
  let reason;
  if (now < Number(operation.targetStart)) {
    reason = 'ENTRADA CONFIRMADA — ' + side + ' • próxima vela em ' + Math.max(0, Math.ceil((Number(operation.targetStart) - now) / 1000)) + 's. Esta decisão fica travada até o fechamento da vela-alvo.';
  } else if (entryWindowOpen) {
    reason = 'ENTRADA CONFIRMADA — ' + side + ' • janela inicial da vela. Não haverá troca de direção neste ciclo.';
  } else if (status === 'SETTLING') {
    reason = 'APURANDO RESULTADO — ' + side + ' • vela-alvo fechou; aguardando o fechamento confirmado do feed.';
  } else {
    reason = 'OPERAÇÃO EM ANDAMENTO — ' + side + ' • abertura da vela: ' + (operation.candleOpenPrice == null ? 'aguardando captura' : operation.candleOpenPrice) + '. A extensão aguarda o fechamento para registrar WIN/LOSS/DRAW e só então libera nova análise.';
  }
  return {
    ...common, uiState: entryWindowOpen ? 'ENTER_' + direction : 'OPERATION_ACTIVE_' + direction,
    direction, actionable: entryWindowOpen, alert: 'silent',
    targetStart: Number(operation.targetStart), targetEnd: Number(operation.targetEnd),
    operationStatus: status, operationId: operation.id,
    candleOpenPrice: operation.candleOpenPrice ?? null,
    candleClosePrice: operation.candleClosePrice ?? null,
    operationResult: operation.result ?? null, reason, updatedAt: now
  };
}
