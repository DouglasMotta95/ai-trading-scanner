const finite = value => value == null || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null;
const clamp = value => Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
const avg = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;

function shape(raw = {}) {
  const open = finite(raw.open), high = finite(raw.high), low = finite(raw.low), close = finite(raw.close);
  if ([open, high, low, close].some(value => value == null)) return null;
  const range = Math.max(1e-12, high - low);
  const body = Math.abs(close - open);
  return {
    open, high, low, close,
    range,
    bodyRatio: body / range,
    upperRatio: Math.max(0, high - Math.max(open, close)) / range,
    lowerRatio: Math.max(0, Math.min(open, close) - low) / range,
    direction: close > open ? 'BUY' : close < open ? 'SELL' : null
  };
}

function rowsFromState(state = {}) {
  const rows = (Array.isArray(state.candles) ? state.candles : []).slice(-9);
  if (state.currentCandle) rows.push(state.currentCandle);
  const shaped = rows.map(shape).filter(Boolean);
  return shaped.slice(-10);
}

function trailingStreak(rows = []) {
  const lastDirection = rows.at(-1)?.direction || null;
  if (!lastDirection) return { direction: null, count: 0 };
  let count = 0;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (rows[index]?.direction !== lastDirection) break;
    count += 1;
  }
  return { direction: lastDirection, count };
}

export function assessAssetQuality(state = {}) {
  const rows = rowsFromState(state);
  const asset = String(state.asset || state.diagnostics?.focusedAsset?.asset || '').trim() || null;
  const signal = state.signal || {};
  const analytics = signal.analytics || {};

  if (!asset || rows.length < 3) {
    return {
      status: 'LOADING', tone: 'waiting', label: 'AVALIANDO ATIVO', action: 'SINCRONIZANDO',
      score: null, asset, context: 'AGUARDANDO HISTÓRICO', bias: '—', tradable: false,
      reason: 'Lendo as velas reais deste ativo antes de dizer se está bom para operar agora.'
    };
  }

  const up = rows.filter(row => row.direction === 'BUY').length;
  const down = rows.filter(row => row.direction === 'SELL').length;
  const majorityDirection = up === down ? null : up > down ? 'BUY' : 'SELL';
  const agreement = Math.max(up, down) / Math.max(1, rows.length);
  const averageBody = avg(rows.map(row => row.bodyRatio));
  const tiny = rows.filter(row => row.bodyRatio < .20).length;
  const last = rows.at(-1);
  const doji = last.bodyRatio < .12;

  const deltas = rows.slice(1).map((row, index) => row.close - rows[index].close);
  const net = deltas.reduce((sum, value) => sum + value, 0);
  const activity = deltas.reduce((sum, value) => sum + Math.abs(value), 0);
  const efficiency = activity > 0 ? Math.abs(net) / activity : 0;

  const buyPower = Number(analytics.buyPower || 0);
  const sellPower = Number(analytics.sellPower || 0);
  const powerGap = Math.abs(buyPower - sellPower);
  const currentStrength = Number(analytics.currentStrength || 0);
  const momentumScore = Number(analytics.momentumScore || 0);
  const momentumDirection = ['BUY', 'SELL'].includes(analytics.momentumDirection) ? analytics.momentumDirection : null;
  const continuationScore = Number(analytics.continuationScore || 0);
  const continuationDirection = ['BUY', 'SELL'].includes(analytics.continuationDirection) ? analytics.continuationDirection : null;
  const lossOfStrength = Number(analytics.lossOfStrength || 0);
  const signalBias = ['BUY', 'SELL'].includes(signal.analysisDirection) ? signal.analysisDirection
    : ['BUY', 'SELL'].includes(analytics.trendDirection) ? analytics.trendDirection
      : majorityDirection;
  const regime = String(signal.regime?.type || '').toLowerCase();
  const streak = trailingStreak(rows);
  const waitingType = String(signal.waitingFor?.type || '');

  const compressed = tiny >= Math.ceil(rows.length * .6);
  const lateral = regime === 'range'
    || (efficiency < .24 && agreement <= .6)
    || (averageBody < .22 && agreement < .7);
  const stretched = streak.count >= 4;
  const weakeningStretch = stretched && (
    lossOfStrength >= 55
    || currentStrength < 35
    || doji
    || (momentumDirection && streak.direction !== momentumDirection)
  );
  const cleanTrend = !!signalBias && agreement >= .65 && efficiency >= .34;
  const continuationAligned = !!signalBias && continuationDirection === signalBias && continuationScore >= 60;
  const momentumAligned = !!signalBias && momentumDirection === signalBias && momentumScore >= 45;
  const activeSetup = ['POSSIBLE_BUY','POSSIBLE_SELL','DECIDING','ENTER_BUY','ENTER_SELL'].includes(String(signal.uiState || ''));
  const rejectionContext = waitingType === 'rejection' || analytics.rejectionDirection === signalBias;
  const breakoutContext = waitingType === 'breakout' || ['breakout','rompimento'].some(term => String(signal.setup || '').toLowerCase().includes(term));

  let score = 20
    + agreement * 28
    + Math.min(1, averageBody / .60) * 14
    + Math.min(1, efficiency / .75) * 16
    + Math.min(1, powerGap / 30) * 10
    + Math.min(1, momentumScore / 70) * 8;

  if (cleanTrend) score += 6;
  if (continuationAligned) score += 5;
  if (momentumAligned) score += 4;
  if (activeSetup) score += 5;
  if (breakoutContext || rejectionContext) score += 3;
  if (!signalBias) score -= 12;
  if (lateral) score -= 22;
  if (compressed) score -= 14;
  if (doji) score -= 8;
  if (weakeningStretch) score -= 10;
  score = clamp(score);

  const directionText = signalBias === 'BUY' ? 'ALTA' : signalBias === 'SELL' ? 'BAIXA' : 'SEM DIREÇÃO';
  const biasText = signalBias === 'BUY' ? 'COMPRADOR' : signalBias === 'SELL' ? 'VENDEDOR' : 'NEUTRO';
  const setupContext = breakoutContext ? 'ROMPIMENTO EM FORMAÇÃO'
    : rejectionContext ? 'REJEIÇÃO EM FORMAÇÃO'
      : continuationAligned ? `CONTINUAÇÃO DE ${directionText}`
        : cleanTrend ? `TENDÊNCIA DE ${directionText}` : `MOVIMENTO DE ${directionText}`;

  if (weakeningStretch) {
    return {
      status: 'WATCH', tone: 'warn', label: `ATENÇÃO: ${directionText} ESTICADA`, action: 'AGUARDAR GATILHO',
      score, asset, context: `${streak.count} VELAS SEGUIDAS • PERDENDO FORÇA`, bias: biasText, tradable: false,
      reason: 'O movimento está esticado e começou a perder força. Não inverter só porque subiu/caiu muito; espere rejeição, pullback ou rompimento confirmar a próxima vela.'
    };
  }

  if (lateral || compressed) {
    const context = compressed ? 'MERCADO COMPRIMIDO' : 'MERCADO LATERAL';
    const hasLocalSetup = activeSetup && Number(signal.analysisScore ?? signal.score ?? 0) >= 44;
    return {
      status: hasLocalSetup ? 'WATCH' : 'POOR', tone: hasLocalSetup ? 'warn' : 'bad',
      label: hasLocalSetup ? 'ATIVO EM OBSERVAÇÃO' : 'ATIVO RUIM PARA OPERAR',
      action: hasLocalSetup ? 'AGUARDAR GATILHO' : 'PROCURE OUTRO ATIVO',
      score, asset, context, bias: biasText, tradable: false,
      reason: hasLocalSetup
        ? 'O ativo está lateral/comprimido, mas existe um setup local em formação. Só opere se o gatilho da próxima vela confirmar.'
        : 'Pouca direção e pouca vantagem no movimento atual. Vale trocar de ativo e comparar outro gráfico.'
    };
  }

  if (score >= 68 && signalBias) {
    return {
      status: 'GOOD', tone: 'good', label: 'ATIVO BOM PARA OPERAR', action: 'PROCURAR ENTRADA',
      score, asset, context: setupContext,
      bias: biasText, tradable: true,
      reason: 'Movimento relativamente limpo, direção clara e força suficiente para procurar uma entrada na próxima vela. A entrada ainda depende do gatilho e da confirmação final.'
    };
  }

  if (score >= 48) {
    return {
      status: 'WATCH', tone: 'warn', label: 'ATIVO EM OBSERVAÇÃO', action: 'AGUARDAR GATILHO',
      score, asset, context: signalBias ? setupContext : 'MOVIMENTO MISTO',
      bias: biasText, tradable: false,
      reason: 'Existe movimento, mas a vantagem ainda não está limpa. Aguarde o gatilho de POSSÍVEL COMPRA/VENDA ou a confirmação final da próxima vela.'
    };
  }

  return {
    status: 'POOR', tone: 'bad', label: 'ATIVO RUIM PARA OPERAR', action: 'PROCURE OUTRO ATIVO',
    score, asset, context: 'SEM QUALIDADE SUFICIENTE', bias: biasText, tradable: false,
    reason: 'O gráfico está sem direção ou força suficiente agora. Trocar de ativo pode ser melhor do que ficar esperando este mercado melhorar.'
  };
}
