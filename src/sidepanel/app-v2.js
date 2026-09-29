const $ = id => document.getElementById(id);
const PREF_KEY = 'atsScannerUiPreferences';
const DEFAULT_PREFS = Object.freeze({
  overlayEnabled: false,
  possibleSoundEnabled: false,
  confirmSoundEnabled: false,
  alertLevel: 'discrete',
  notificationsEnabled: true,
  analystMode: 'NORMAL',
  geminiEnabled: true,
  sensitivityProfile: 'MEDIO',
  operationMode: 'M1',
  payoutByMode: { M1: 88, M5: 88 },
  holdSeconds: 2,
  expectedAsset: ''
});

const profileHoldSeconds = value => {
  const profile = String(value || '').toUpperCase();
  return profile === 'RIGIDO' ? 3 : profile === 'SOLTO' ? 1 : 2;
};

const PANEL_OPENED_AT = Date.now();
const FOCUS_FRESH_MS = 12000;
let prefs = { ...DEFAULT_PREFS };
let liveOhlc = null;
let audioContext = null;

const clean = value => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
const num = value => value == null || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null;
const activeLicense = state => {
  const status = String(state?.license?.status || '').toLowerCase();
  return ['active', 'valid'].includes(status)
    || state?.license?.devMode === true
    || String(state?.license?.plan || '').toUpperCase() === 'OWNER_DEV'
    || state?.diagnostics?.access?.ownerDev === true
    || state?.diagnostics?.access?.state === 'owner_dev';
};
const marketId = value => {
  const raw = clean(value).toUpperCase();
  if (!raw) return '';
  const otc = /(?:\(|\b|[_-])OTC(?:\)|\b)?/.test(raw);
  const match = raw.match(/\b([A-Z0-9]{2,20})\s*[\/_-]\s*([A-Z0-9]{2,12})/);
  return match ? `${match[1]}/${match[2]}${otc ? ' (OTC)' : ''}` : raw;
};
const sameMarket = (a, b) => !!marketId(a) && marketId(a) === marketId(b);

function sessionInfo(state = {}) { return state.diagnostics?.marketSession || {}; }
function transitionAsset(state = {}) {
  const session = sessionInfo(state);
  return session.transitioning === true ? marketId(session.pendingAsset || session.asset) : '';
}
function marketDataReady(state = {}) {
  const session = sessionInfo(state);
  const signal = state.signal || {};
  const rows = (Array.isArray(state.candles) ? state.candles : []).filter(row => [row?.open,row?.high,row?.low,row?.close].every(value => num(value) != null));
  const signalMatches = !signal.asset || sameMarket(signal.asset, state.asset);
  const candleMatches = !state.currentCandle?.asset || sameMarket(state.currentCandle.asset, state.asset);
  return session.dataReady === true
    && !!state.asset
    && sameMarket(session.confirmedAsset, state.asset)
    && signalMatches
    && candleMatches
    && num(state.price) != null
    && rows.length >= 2;
}

function marketIdentityReady(state = {}) {
  const session = sessionInfo(state);
  const focus = state.diagnostics?.focusedAsset || {};
  const signal = state.signal || {};
  const asset = marketId(state.asset || '');
  if (!asset || !sameMarket(session.confirmedAsset, asset) || !sameMarket(focus.asset, asset)) return false;
  if (signal.asset && !sameMarket(signal.asset, asset)) return false;
  if (state.currentCandle?.asset && !sameMarket(state.currentCandle.asset, asset)) return false;
  return true;
}
function expirationObservation(state = {}) {
  const controls = state.platformControls || {};
  const observedAt = Number(controls.expirationCheckedAt || controls.observed?.observedAt?.expiration || 0);
  const realAt = Number(controls.realExpirationAt || 0);
  const realValue = normExp(controls.realExpiration || '');
  const realSource = clean(controls.realExpirationSource || controls.expirationSource || '');
  // A verified CasaTrade expiration remains time-fresh for 15s as before.
  // A user-declared expiration is intentionally NOT time-expiring: it remains
  // a valid unverified fallback until the existing session/asset reset clears it
  // or the user changes the selector. It must never turn into "real pending"
  // merely because 7 seconds elapsed since the selector change.
  const realFresh = !!realValue && realAt > 0 && Date.now() - realAt < 15000 && realSource !== 'user-declared';
  const at = realFresh ? realAt : observedAt;
  const declaredValue = normExp(controls.userDeclaredExpiration || '');
  const observedManualValue = normExp(controls.observed?.expiration || '');
  const manualValue = declaredValue || observedManualValue || null;
  const manualFresh = !!manualValue;
  const value = realFresh ? realValue : manualValue;
  const source = realFresh ? (realSource || 'casatrade-observed') : manualValue ? 'user-declared' : '';
  return { value, fresh: realFresh || manualFresh, verified: realFresh, source, at, ageMs: at > 0 ? Date.now() - at : Infinity };
}
function sessionAgeMs(state = {}) {
  const at = Number(sessionInfo(state).startedAt || state.diagnostics?.target?.connectedAt || 0);
  const panelAge = Math.max(0, Date.now() - PANEL_OPENED_AT);
  if (!(at > 0)) return panelAge;
  return Math.min(Math.max(0, Date.now() - at), panelAge);
}
function focusConfirmedThisPanel(state = {}) {
  const at = Number(state.diagnostics?.focusedAsset?.at || 0);
  return at >= PANEL_OPENED_AT;
}

function normTf(value = '') {
  const raw = clean(value).toUpperCase().replace(/\s+/g, '');
  let match = raw.match(/^([SMH])(\d{1,5})$/);
  if (match && Number(match[2]) > 0) return `${match[1]}${Number(match[2])}`;
  match = raw.match(/^(\d{1,4})(?:M|MIN)$/);
  return match && Number(match[1]) > 0 ? `M${Number(match[1])}` : null;
}
function timeframeSeconds(value = '') {
  const tf = normTf(value);
  if (!tf) return null;
  if (tf[0] === 'S') return Number(tf.slice(1));
  if (tf[0] === 'M') return Number(tf.slice(1)) * 60;
  if (tf[0] === 'H') return Number(tf.slice(1)) * 3600;
  return null;
}
function normExp(value = '') {
  const raw = clean(value).toLowerCase().replace(/\s+/g, '');
  let match = raw.match(/^(\d{1,5})(?:s|seg|segundo|segundos)$/); if (match) return `${Number(match[1])}s`;
  match = raw.match(/^(\d{1,4})(?:m|min|minuto|minutos)$/); if (match) return `${Number(match[1]) * 60}s`;
  match = raw.match(/^(\d{1,3}):(\d{2})$/); if (match) return `${Number(match[1]) * 60 + Number(match[2])}s`;
  return null;
}
function operationRequirement(state = {}) {
  const timeframe = String(state.analystPreferences?.operationMode || prefs.operationMode || 'M1').toUpperCase() === 'M5' ? 'M5' : 'M1';
  const durationSeconds = Number(state.analystPreferences?.operationDurationSeconds || timeframeSeconds(timeframe) || (timeframe === 'M5' ? 300 : 60));
  const expiration = normExp(state.analystPreferences?.operationExpiration || `${durationSeconds}s`) || (timeframe === 'M5' ? '300s' : '60s');
  return { timeframe, expiration, durationSeconds };
}

function expLabel(value = '') {
  const exp = normExp(value);
  if (!exp) return '—';
  const seconds = Number(exp.replace(/\D/g, ''));
  if (seconds % 3600 === 0) return `${seconds / 3600} h`;
  if (seconds % 60 === 0) return `${seconds / 60} min`;
  return `${seconds} s`;
}
function fmtPrice(value) {
  const n = num(value);
  if (n == null) return '—';
  const a = Math.abs(n);
  const digits = a >= 1000 ? 2 : a >= 100 ? 3 : a >= 1 ? 5 : 8;
  return n.toFixed(digits).replace(/0+$/, '').replace(/\.$/, '');
}

function focusReady(state = {}) {
  const focus = state.diagnostics?.focusedAsset || {};
  const ambiguousPassive = Number(focus.ambiguityCount || 0) > 0
    && focus.explicit !== true
    && focus.interactionHint !== true;
  return focus.reliable === true
    && focus.chartScoped === true
    && focus.trustedChartFrame === true
    && focus.visualAuthority !== false
    && !ambiguousPassive
    && (focus.embeddedTrader === true || focus.casaTradeFrame === true)
    && sameMarket(focus.asset, state.asset)
    && Number(focus.at || 0) > 0
    && Date.now() - Number(focus.at) < FOCUS_FRESH_MS;
}

function clockBoundToFocus(clock = {}, focus = {}) {
  const sameFrame = Number(clock.frameId) === Number(focus.frameId)
    && clean(clock.frameHost).toLowerCase() === clean(focus.frameHost).toLowerCase();
  const boundControlFrame = clock.crossFrameControl === true
    && Number(clock.boundFocusFrameId) === Number(focus.frameId)
    && clean(clock.boundFocusFrameHost).toLowerCase() === clean(focus.frameHost).toLowerCase();
  return sameFrame || boundControlFrame;
}

function clockBaseReady(state = {}) {
  const clock = state.diagnostics?.marketClock || {};
  const focus = state.diagnostics?.focusedAsset || {};
  if (!(focusReady(state)
    && clock.available !== false
    && clock.role === 'candle-close'
    && sameMarket(clock.asset, state.asset)
    && clockBoundToFocus(clock, focus)
    && Number(clock.at || 0) > 0
    && num(clock.secondsRemaining) != null)) return false;
  const tf = normTf(clock.timeframe || state.analysisTimeframe || state.timeframe);
  const duration = timeframeSeconds(tf);
  const raw = Number(clock.secondsRemaining);
  const ageMs = Date.now() - Number(clock.at);
  if (!duration || !Number.isFinite(raw) || raw < 0 || raw > duration + 2 || ageMs < -1000) return false;
  const projected = raw - Math.max(0, ageMs / 1000);
  return projected > 0.25;
}

function exactClockReady(state = {}) {
  const clock = state.diagnostics?.marketClock || {};
  if (!clockBaseReady(state)) return false;
  return clock.verified === true && ['trader-dom-countdown', 'network-server-cycle'].includes(String(clock.source || ''));
}

function operationalClockReady(state = {}) {
  // The countdown is anchored to an exact CasaTrade observation. Between two
  // CasaTrade samples we continue the monotonic second-by-second projection
  // until that sampled candle closes; we never roll it into the next candle.
  return exactClockReady(state);
}

function sessionReady(state = {}) {
  return activeLicense(state)
    && state.connection === 'online'
    && marketDataReady(state)
    && focusReady(state)
    && operationalClockReady(state);
}

function expirationTimingCompatible(expiration = {}, operation = {}) {
  // A real CasaTrade observation remains accepted exactly as before.
  // When CasaTrade does not expose a structured expiration, the explicit
  // user declaration is the supported timing authority, provided it matches
  // the active operation expiration exactly.
  return !!expiration.value
    && expiration.value === operation.expiration
    && (expiration.verified === true || expiration.source === 'user-declared');
}

function liveTimingReady(state = {}) {
  if (!exactClockReady(state)) return false;
  const clock = state.diagnostics?.marketClock || {};
  const expiration = expirationObservation(state);
  const operation = operationRequirement(state);
  return expirationTimingCompatible(expiration, operation)
    && normTf(clock.timeframe) === operation.timeframe;
}

function entryTimeReady(state = {}) {
  if (!exactClockReady(state)) return false;
  const clock = state.diagnostics?.marketClock || {};
  const expiration = expirationObservation(state);
  const operation = operationRequirement(state);
  if (!expirationTimingCompatible(expiration, operation)) return false;
  const clockTf = normTf(clock.timeframe);
  const stateTf = normTf(state.analysisTimeframe || state.timeframe);
  const controlTf = normTf(state.platformControls?.observed?.timeframe);
  if (!clockTf || clockTf !== operation.timeframe) return false;
  if (expiration.value !== operation.expiration) return false;
  if (stateTf && stateTf !== clockTf) return false;
  if (controlTf && controlTf !== clockTf) return false;
  return state.professionalDecision?.timeReady === true && state.professionalDecision?.expirationReady === true;
}

function completeCandle(row = {}) {
  return [row.open, row.high, row.low, row.close].every(value => num(value) != null);
}

function liveCycleKey(state = {}) {
  const tf = normTf(state.analysisTimeframe || state.timeframe);
  const seconds = timeframeSeconds(tf);
  if (!state.asset || !tf || !seconds) return '';
  let targetStart = num(state.diagnostics?.marketClock?.closeAt) ?? num(state.signal?.targetStart);
  if (targetStart != null) {
    if (targetStart <= Date.now() - 500) {
      targetStart += Math.ceil((Date.now() - targetStart + 500) / (seconds * 1000)) * seconds * 1000;
    }
    return `${marketId(state.asset)}|${tf}|${Math.round(targetStart / 1000) * 1000}`;
  }
  const remaining = num(state.diagnostics?.marketClock?.secondsRemaining);
  if (remaining == null) return `${marketId(state.asset)}|${tf}|unknown`;
  const estimatedClose = Date.now() + remaining * 1000;
  return `${marketId(state.asset)}|${tf}|${Math.round(estimatedClose / Math.max(1000, seconds * 1000))}`;
}

function currentOhlc(state = {}) {
  const direct = state.signal?.currentCandle || state.currentCandle || null;
  if (direct && completeCandle(direct)) {
    return {
      open: num(direct.open), high: num(direct.high), low: num(direct.low), close: num(direct.close),
      approximate: direct.partial === true || direct.openReliable === false || direct.rangeReliable === false,
      source: direct.source || 'casatrade'
    };
  }

  const tf = normTf(state.analysisTimeframe || state.timeframe);
  const durationMs = (timeframeSeconds(tf) || 0) * 1000;
  const now = Date.now();
  const rows = (Array.isArray(state.candles) ? state.candles : []).filter(completeCandle);
  const matching = rows.map(row => {
    let time = num(row.time ?? row.timestamp);
    if (time != null && time > 0 && time < 1e11) time *= 1000;
    return { row, time };
  }).filter(item => item.time && durationMs && now >= item.time - 1500 && now < item.time + durationMs + 1500).sort((a, b) => b.time - a.time)[0];
  if (matching) {
    return { open: num(matching.row.open), high: num(matching.row.high), low: num(matching.row.low), close: num(matching.row.close), approximate: false, source: 'structured-casatrade' };
  }

  const price = num(state.price);
  const key = liveCycleKey(state);
  if (price == null || !key) return { open: null, high: null, low: null, close: price, approximate: true, source: 'unavailable' };
  if (!liveOhlc || liveOhlc.key !== key) liveOhlc = { key, open: price, high: price, low: price, close: price };
  liveOhlc.high = Math.max(liveOhlc.high, price);
  liveOhlc.low = Math.min(liveOhlc.low, price);
  liveOhlc.close = price;
  return { ...liveOhlc, approximate: true, source: 'live-price-observed' };
}

function entryBlockReason(state = {}) {
  const operation = operationRequirement(state);
  const expirationLabel = operation.expiration === '300s' ? '5 MINUTOS' : '1 MINUTO';
  const expiration = expirationObservation(state);
  if (!expiration.value) return 'EXPIRAÇÃO PENDENTE — informe a duração da operação ou aguarde a leitura da CasaTrade';
  if (expiration.verified !== true) return 'EXPIRAÇÃO MANUAL ACEITA — aguardando apenas o countdown real da CasaTrade';
  if (expiration.value !== operation.expiration) return `AJUSTE A EXPIRAÇÃO DA CASATRADE PARA ${expirationLabel}`;

  const clock = state.diagnostics?.marketClock || {};
  if (!exactClockReady(state)) return 'COUNTDOWN REAL PENDENTE — AGUARDANDO TEMPO EXATO DA CASATRADE';

  const clockTf = normTf(clock.timeframe);
  if (clockTf !== operation.timeframe) return `AJUSTE O TIMEFRAME DA CASATRADE PARA ${operation.timeframe}`;
  return 'ENTRADA AINDA NÃO LIBERADA';
}

function gateKind(state = {}) {
  const operation = operationRequirement(state);
  const expiration = expirationObservation(state);
  if (!expiration.value) return 'waiting';
  if (expiration.verified !== true) return 'waiting';
  if (expiration.value !== operation.expiration) return 'rule';
  if (!exactClockReady(state)) return 'waiting';
  const clockTf = normTf(state.diagnostics?.marketClock?.timeframe);
  if (clockTf !== operation.timeframe) return 'rule';
  return 'waiting';
}

function decisionModel(state = {}) {
  if (!activeLicense(state)) return { uiState: 'WAIT', title: 'AGUARDAR', text: 'AGUARDAR', sub: 'Ative o acesso para iniciar a leitura.', tone: 'waiting', reason: 'Aguardando licença ativa.', score: 0, actionable: false };
  if (!marketIdentityReady(state)) return { uiState: 'ANALYZING_MARKET', title: 'ATUALIZANDO ATIVO', text: 'AGUARDAR', sub: 'Bloqueio de segurança: confirmando que gráfico, sessão, velas e sinal pertencem ao mesmo ativo.', tone: 'waiting', reason: 'Ativo técnico divergiu do gráfico atual da CasaTrade.', score: 0, actionable: false };
  const pending = transitionAsset(state);
  if (pending) return { uiState: 'ANALYZING_MARKET', title: 'ATUALIZANDO ATIVO', text: `ATUALIZANDO PARA ${pending}`, sub: 'Limpando dados anteriores e confirmando preço + velas do novo ativo.', tone: 'waiting', reason: 'Troca de ativo em validação.', score: 0, actionable: false };
  if (!marketDataReady(state) || !focusReady(state)) return { uiState: 'ANALYZING_MARKET', title: 'AGUARDAR', text: 'AGUARDAR', sub: 'Confirmando ativo, preço e velas reais.', tone: 'waiting', reason: 'Identificando o gráfico atual da CasaTrade.', score: 0, actionable: false };
  // The sidepanel is a new observation surface. Never render a persisted
  // POSSÍVEL/ENTER from before this panel was opened; wait for a fresh focus
  // sample from the currently open CasaTrade tab.
  if (!focusConfirmedThisPanel(state)) return {
    uiState: 'ANALYZING_MARKET',
    title: 'AGUARDAR',
    text: 'AGUARDAR',
    sub: 'Aguardando confirmação nova do gráfico da CasaTrade.',
    tone: 'waiting',
    reason: 'Leitura anterior descartada até o gráfico atual ser confirmado.',
    score: 0,
    actionable: false
  };

  // A POSSÍVEL is a technical pre-signal and must remain visible even when
  // the final entry timing gate is still waiting for an exact clock/expiration.
  // This does not create a signal or change thresholds; it only prevents the
  // UI timing gate from hiding a decision already produced by the engine.
  const earlyProfessional = state.professionalDecision || {};
  const earlyTechnical = state.signal || {};
  const earlyTechnicalUi = String(earlyTechnical.uiState || '').toUpperCase();
  const earlyProfessionalAsset = marketId(earlyProfessional.asset || earlyProfessional.market || earlyProfessional.symbol || '');
  const earlyProfessionalMatches = !earlyProfessionalAsset || sameMarket(earlyProfessionalAsset, state.asset);
  const earlyProfessionalUi = earlyProfessionalMatches ? String(earlyProfessional.uiState || '').toUpperCase() : '';
  const earlyUi = ['POSSIBLE_BUY','POSSIBLE_SELL'].includes(earlyTechnicalUi)
    ? earlyTechnicalUi
    : (earlyProfessionalUi || earlyTechnicalUi);
  const earlyDirection = earlyUi.endsWith('_BUY') ? 'BUY' : earlyUi.endsWith('_SELL') ? 'SELL' : null;
  const earlyPossible = ['POSSIBLE_BUY','POSSIBLE_SELL'].includes(earlyUi) && earlyDirection;
  if (earlyTechnicalUi === 'OPERATION_ACTIVE') {
    const activeRow = (Array.isArray(state.signalHistory) ? state.signalHistory : [])
      .filter(row => row && !row.result && String(row.status || '').toLowerCase() !== 'resolved')
      .at(-1);
    const activeDirection = String(activeRow?.direction || '').toUpperCase();
    const side = activeDirection === 'BUY' ? 'COMPRA' : activeDirection === 'SELL' ? 'VENDA' : '';
    const activePrice = num(activeRow?.entryPrice ?? earlyTechnical.entryPrice);
    const activeTarget = num(activeRow?.entryTime ?? activeRow?.targetStart ?? earlyTechnical.targetStart);
    let schedule = '';
    try { if (activeTarget != null) schedule = new Date(activeTarget).toLocaleTimeString('pt-BR', {hour:'2-digit',minute:'2-digit'}); } catch {}
    const priceText = activePrice != null ? ` Preço de entrada: ${fmtPrice(activePrice)}.` : '';
    return {
      uiState: 'OPERATION_ACTIVE',
      title: 'OPERAÇÃO EM ANDAMENTO',
      text: side ? `OPERAÇÃO ${side}` : 'OPERAÇÃO EM ANDAMENTO',
      sub: activePrice != null
        ? `Entrada oficial ${schedule ? 'às ' + schedule + ' • ' : ''}${fmtPrice(activePrice)} • aguardando resultado.`
        : `Próxima vela ${schedule || '—'} • aguardando captura do preço de abertura.`,
      tone: 'waiting',
      reason: clean(earlyTechnical.reason || 'Operação aberta. Nenhuma nova entrada será liberada até a resolução.'),
      score: Number(earlyTechnical.analysisScore ?? earlyTechnical.score ?? 0) || 0,
      actionable: false,
      direction: activeDirection || null,
      operationId: earlyTechnical.operationId || activeRow?.id || null,
      targetStart: activeTarget,
      entryPrice: activePrice,
      operationStatus: activePrice != null ? 'open' : 'waiting_candle_open'
    };
  }

  if (earlyPossible) {
    const earlyScore = Number(earlyProfessional.score ?? earlyTechnical.analysisScore ?? earlyTechnical.score ?? 0) || 0;
    const earlyReason = clean(earlyProfessional.reason || earlyTechnical.reason || 'Alta confiança técnica detectada.');
    return {
      uiState: earlyDirection === 'BUY' ? 'POSSIBLE_BUY' : 'POSSIBLE_SELL',
      title: earlyDirection === 'BUY' ? 'COMPRA — POSSÍVEL' : 'VENDA — POSSÍVEL',
      text: earlyDirection === 'BUY' ? 'POSSÍVEL COMPRA' : 'POSSÍVEL VENDA',
      sub: liveTimingReady(state) ? 'Alta confiança detectada; aguardando janela final.' : 'Pré-sinal técnico detectado; aguardando sincronização final da entrada.',
      tone: earlyDirection === 'BUY' ? 'possible-buy' : 'possible-sell', reason: earlyReason, score: earlyScore, actionable: false, direction: earlyDirection
    };
  }

  const timingReady = liveTimingReady(state);
  if (!timingReady) {
    const blocked = entryBlockReason(state);
    return {
      uiState: 'WAIT',
      title: 'AGUARDAR',
      text: 'AGUARDAR',
      sub: blocked,
      tone: 'waiting',
      reason: blocked,
      score: 0,
      actionable: false
    };
  }

  const p = state.professionalDecision || {};
  const technical = state.signal || {};
  const technicalUi = String(technical.uiState || '').toUpperCase();
  const professionalAsset = marketId(p.asset || p.market || p.symbol || '');
  const professionalMatchesCurrent = !professionalAsset || sameMarket(professionalAsset, state.asset);
  const professionalUi = professionalMatchesCurrent ? String(p.uiState || '').toUpperCase() : '';
  const technicalPossible = ['POSSIBLE_BUY','POSSIBLE_SELL'].includes(technicalUi);
  const ui = technicalPossible
    ? technicalUi
    : String(professionalUi || technicalUi || '').toUpperCase();
  const direction = String((technicalPossible ? technical.direction : (p.direction || technical.direction || technical.analysisDirection)) || '').toUpperCase();
  const score = Number(p.score ?? technical.analysisScore ?? technical.score ?? 0) || 0;
  const reason = clean(p.reason || technical.reason || 'Aguardando confluência técnica.');
  const timeReady = entryTimeReady(state);
  const blocked = timeReady ? '' : entryBlockReason(state);

  if (!timeReady) {
    const possibleUi = ['POSSIBLE_BUY','POSSIBLE_SELL','ENTER_BUY','ENTER_SELL'].includes(ui)
      ? ui
      : ['POSSIBLE_BUY','POSSIBLE_SELL','ENTER_BUY','ENTER_SELL'].includes(technicalUi) ? technicalUi : '';
    const possibleDirection = possibleUi.includes('BUY') ? 'BUY' : possibleUi.includes('SELL') ? 'SELL' : null;
    if (possibleDirection) {
      const side = possibleDirection === 'BUY' ? 'COMPRA' : 'VENDA';
      return {
        uiState: possibleDirection === 'BUY' ? 'POSSIBLE_BUY' : 'POSSIBLE_SELL',
        title: `${side} — POSSÍVEL`,
        text: `POSSÍVEL ${side}`,
        sub: blocked,
        tone: possibleDirection === 'BUY' ? 'possible-buy' : 'possible-sell',
        reason: `${reason} • ${blocked}`,
        score,
        actionable: false,
        direction: possibleDirection
      };
    }
    return { uiState: 'WAIT', title: 'AGUARDAR', text: 'AGUARDAR', sub: blocked, tone: gateKind(state) === 'technical' ? 'waiting' : 'no-trade', reason: blocked, score, actionable: false };
  }

  if (ui === 'ANALYZING_MARKET') return { uiState: ui, title: 'ANALISANDO MERCADO', text: 'ANALISANDO MERCADO', sub: reason, tone: 'waiting', reason, score, actionable: false };
  if (ui === 'BUILDING_PATTERN' || ui === 'DECIDING') return { uiState: ui, title: 'AGUARDAR', text: 'AGUARDAR', sub: 'Buscando alta confiança técnica.', tone: 'waiting', reason, score, actionable: false };
  if (ui === 'POSSIBLE_BUY') return { uiState: ui, title: 'COMPRA — ALTA CONFIANÇA', text: 'PRÉ-SINAL: COMPRA', sub: 'Alta confiança detectada; aguardando janela final.', tone: 'possible-buy', reason, score, actionable: false, direction: 'BUY' };
  if (ui === 'POSSIBLE_SELL') return { uiState: ui, title: 'VENDA — ALTA CONFIANÇA', text: 'PRÉ-SINAL: VENDA', sub: 'Alta confiança detectada; aguardando janela final.', tone: 'possible-sell', reason, score, actionable: false, direction: 'SELL' };
  if (ui === 'ENTER_BUY' && p.actionable === true) return { uiState: ui, title: 'COMPRA — ALTA CONFIANÇA', text: 'COMPRA — ALTA CONFIANÇA', sub: 'ENTRAR NA PRÓXIMA VELA', tone: 'buy', reason, score, actionable: true, direction: 'BUY' };
  if (ui === 'ENTER_SELL' && p.actionable === true) return { uiState: ui, title: 'VENDA — ALTA CONFIANÇA', text: 'VENDA — ALTA CONFIANÇA', sub: 'ENTRAR NA PRÓXIMA VELA', tone: 'sell', reason, score, actionable: true, direction: 'SELL' };
  return { uiState: 'WAIT', title: 'AGUARDAR', text: 'AGUARDAR', sub: 'Padrão sem confirmação suficiente.', tone: 'no-trade', reason: reason.startsWith('AGUARDAR') ? reason : `AGUARDAR — ${reason}`, score, actionable: false };
}

function setText(id, value) { const el = $(id); if (el) el.textContent = value; }
function setBadge(id, value, tone = '') { const el = $(id); if (!el) return; el.textContent = value; el.className = `badge ${tone}`.trim(); }
function setSourceState(id, value, tone = 'stale', title = '') {
  const el = $(id); if (!el) return;
  el.textContent = value;
  el.className = `source-state ${tone}`;
  el.title = title || value;
}

function renderCandles(state = {}) {
  const rows = (Array.isArray(state.candles) ? state.candles : []).filter(completeCandle).slice(-10);
  const historyAge = Number(state.diagnostics?.marketSession?.startedAt || state.diagnostics?.target?.connectedAt || 0);
  const waiting = rows.length === 0 && (!historyAge || Date.now() - historyAge < 8000);
  setText('recentCandleCount', waiting ? 'CARREGANDO' : rows.length ? `${rows.length}/10` : 'SEM HISTÓRICO');
  const box = $('recentCandles');
  if (!box) return;
  box.replaceChildren();
  const padded = Array(Math.max(0, 10 - rows.length)).fill(null).concat(rows);
  for (const row of padded) {
    const slot = document.createElement('span');
    slot.className = 'mini-candle-slot empty';
    if (row) {
      const open = Number(row.open), close = Number(row.close), high = Number(row.high), low = Number(row.low);
      const range = Math.max(1e-12, high - low);
      const top = 7 + ((high - Math.max(open, close)) / range) * 76;
      const bottom = 7 + ((Math.min(open, close) - low) / range) * 76;
      slot.className = `mini-candle-slot ${close > open ? 'buy' : close < open ? 'sell' : 'doji'}`;
      const wick = document.createElement('i'); wick.className = 'mini-wick';
      const body = document.createElement('i'); body.className = 'mini-body';
      body.style.top = `${Math.max(7, Math.min(85, top))}%`;
      body.style.bottom = `${Math.max(7, Math.min(85, bottom))}%`;
      slot.append(wick, body);
    }
    box.append(slot);
  }
}

function renderOhlc(state = {}) {
  const row = currentOhlc(state);
  const mark = row.approximate ? '≈' : '';
  setText('currentOpen', row.open == null ? '—' : `${mark}${fmtPrice(row.open)}`);
  setText('currentHigh', row.high == null ? '—' : `${mark}${fmtPrice(row.high)}`);
  setText('currentLow', row.low == null ? '—' : `${mark}${fmtPrice(row.low)}`);
  setText('currentClose', row.close == null ? '—' : fmtPrice(row.close));
  setText('ohlcQuality', row.source === 'structured-casatrade'
    ? 'OHLC estruturado recebido da CasaTrade.'
    : row.open != null
      ? '≈ OHLC parcial montado apenas com preços reais observados nesta vela.'
      : 'Aguardando abertura/range confiáveis da vela atual.');
}

function ensureLicenseGateUi() {
  const main = document.querySelector('main.shell');
  const card = $('licenseCard');
  if (!main || !card) return;
  if (!$('atsLicenseGateStyle')) {
    const style = document.createElement('style');
    style.id = 'atsLicenseGateStyle';
    style.textContent = `
      main.license-gate-locked{padding-bottom:18px}
      main.license-gate-locked > :not(.topbar):not(#licenseCard){display:none!important}
      main.license-gate-locked > #licenseCard{display:block!important;margin-top:14px;min-height:280px}
      main.license-gate-locked > .topbar .top-status #connectScanner{display:none!important}
      #licenseCard.license-gate-card{box-shadow:0 16px 45px rgba(0,0,0,.25)}
      #licenseCard .license-gate-intro{margin:4px 0 16px;color:#9db7c9;line-height:1.55}
    `;
    document.head.append(style);
  }
  const topbar = main.querySelector('.topbar');
  if (topbar && card.previousElementSibling !== topbar) topbar.insertAdjacentElement('afterend', card);
  card.classList.add('license-gate-card');
}

function renderLicense(state = {}) {
  ensureLicenseGateUi();
  const license = state.license || {};
  const active = activeLicense(state);
  const main = document.querySelector('main.shell');
  const card = $('licenseCard');
  if (main) main.classList.toggle('license-gate-locked', !active);
  if (card) {
    card.classList.toggle('active', active);
    card.hidden = active;
    const intro = card.querySelector('.license-gate-intro');
    if (intro) intro.textContent = active
      ? 'Acesso validado. O robô pode monitorar o mercado aberto.'
      : 'Ative sua chave para liberar o robô. Antes da ativação, a tela operacional permanece bloqueada.';
    card.querySelectorAll('.secondary').forEach(button => { button.hidden = !active; });
  }
  setText('licenseTitle', active ? 'Licença ' + (license.planLabel || license.plan || 'ATIVA') : 'Ativação necessária');
  setBadge('licenseHealth', active ? 'ATIVA' : 'INATIVA', active ? 'ok' : 'warn');
  setText('licenseText', active
    ? 'Acesso validado. O robô pode monitorar o mercado aberto.'
    : (license.error ? 'Acesso: ' + license.error : 'Digite sua chave para iniciar.'));
  const box = $('activationBox'); if (box) box.hidden = active;
  return active;
}

function ensureEntryScheduleUi() {
  const card = $('decisionCard');
  if (!card) return;
  if (!$('atsEntryScheduleStyle')) {
    const style = document.createElement('style');
    style.id = 'atsEntryScheduleStyle';
    style.textContent = `
      .entry-schedule{display:grid;gap:3px;margin:8px 0 12px;padding:13px 14px;border:1px solid #294862;border-radius:16px;background:linear-gradient(180deg,#0a1a29,#081521);text-align:center}
      .entry-schedule span{font-size:10px;font-weight:800;letter-spacing:.11em;color:#7fa0b8}
      .entry-schedule b{font-size:34px;line-height:1.05;letter-spacing:.03em;color:#edf8ff}
      .entry-schedule small{font-size:12px;font-weight:800;letter-spacing:.08em}
      .entry-schedule em{display:block;margin-top:4px;font-size:11px;font-style:normal;font-weight:900;color:#9db3c5}
      .entry-schedule .entry-now{display:block;margin-top:7px;font-size:12px;font-weight:800;color:#d8e7f3}
      .entry-schedule .entry-now strong{font-size:15px}
      .entry-schedule .entry-action{display:block;margin-top:5px;font-size:11px;font-weight:900;letter-spacing:.05em}
      .entry-schedule.buy{border-color:#27654f;background:#0b241e}.entry-schedule.buy small{color:#72d7b2}
      .entry-schedule.buy .entry-action{color:#72d7b2}
      .entry-schedule.sell{border-color:#6b3343;background:#241019}.entry-schedule.sell small{color:#ee829b}
      .entry-schedule.sell .entry-action{color:#ee829b}
      .entry-schedule.waiting{border-color:#5f4f28;background:#1c180b}.entry-schedule.waiting small{color:#e0c56e}
      .entry-schedule.waiting .entry-action{color:#e0c56e}
    `;
    document.head.append(style);
  }
  let box = $('entrySchedule');
  if (!box) {
    const head = card.querySelector('.compact-decision-head');
    box = document.createElement('div');
    box.id = 'entrySchedule';
    box.className = 'entry-schedule waiting';
    box.hidden = true;
    box.innerHTML = '<span id="entryScheduleLabel">PRÓXIMA VELA</span><b id="entryScheduleTime">—</b><small id="entryScheduleDirection">AGUARDAR</small><em id="entrySchedulePrice"></em>';
    head?.insertAdjacentElement('afterend', box);
  }
}

function tickEntryScheduleClock() {
  const box = $('entrySchedule');
  if (!box || box.hidden) return;
  const target = Number(box.dataset.entryTarget || 0);
  if (!Number.isFinite(target) || target <= 0) return;

  const now = Date.now();
  const remaining = Math.max(0, Math.ceil((target - now) / 1000));
  const nowText = new Date(now).toLocaleTimeString('pt-BR', { hour:'2-digit', minute:'2-digit', second:'2-digit' });
  const targetText = new Date(target).toLocaleTimeString('pt-BR', { hour:'2-digit', minute:'2-digit', second:'2-digit' });

  setText('entryScheduleTime', targetText);
  setText('entrySchedulePrice', remaining > 0 ? 'VIRA EM ' + remaining + 's' : 'VIRANDO AGORA');

  const nowEl = $('entryScheduleNow');
  if (nowEl) nowEl.innerHTML = 'AGORA <strong>' + nowText + '</strong>';

  const actionEl = $('entryScheduleAction');
  if (actionEl && remaining > 0) {
    const action = box.dataset.entryAction || 'NÃO ENTRAR';
    const side = box.dataset.entryDirection || '';
    actionEl.textContent = action + (side ? ' • ' + side : '');
  }
}

function renderEntrySchedule(state = {}, model = {}) {
  ensureEntryScheduleUi();
  const box = $('entrySchedule');
  if (!box) return;
  const ui = String(model.uiState || '').toUpperCase();
  const signal = state.signal || {};
  const clock = state.diagnostics?.marketClock || {};
  const tf = normTf(state.analysisTimeframe || state.timeframe || clock.timeframe);
  const tfMs = timeframeSeconds(tf) * 1000;
  const activeRow = (Array.isArray(state.signalHistory) ? state.signalHistory : [])
    .filter(row => row && !row.result && String(row.status || '').toLowerCase() !== 'resolved')
    .at(-1);

  const signalVisible = ['POSSIBLE_BUY','POSSIBLE_SELL','ENTER_BUY','ENTER_SELL','OPERATION_ACTIVE'].includes(ui);
  const visible = signalVisible || (ui === 'OPERATION_ACTIVE' && !!activeRow);
  if (!visible || !state.asset || !tf) {
    box.hidden = true;
    return;
  }

  // Never display a stale target from a previous candle/session. CasaTrade's
  // exact closeAt is preferred; otherwise advance a valid signal target or use
  // the local timeframe grid only as a display fallback.
  let target = num(clock.closeAt);
  if (target == null || target <= Date.now() + 500) {
    const candidate = num(signal.targetStart ?? signal.entryAt ?? activeRow?.targetStart ?? state.decisionCycle?.targetStart);
    if (candidate != null && candidate > Date.now() + 500) target = candidate;
  }
  if ((target == null || target <= Date.now() + 500) && tfMs) {
    target = Math.floor(Date.now() / tfMs) * tfMs + tfMs;
  }
  if (target == null) {
    box.hidden = true;
    return;
  }

  const nowText = new Date().toLocaleTimeString('pt-BR', { hour:'2-digit', minute:'2-digit', second:'2-digit' });
  const targetText = new Date(Number(target)).toLocaleTimeString('pt-BR', { hour:'2-digit', minute:'2-digit', second:'2-digit' });
  const remainingSeconds = Math.max(0, Math.ceil((Number(target) - Date.now()) / 1000));
  const direction = activeRow?.direction || model.direction || signal.direction || '';
  const side = direction === 'BUY' ? 'COMPRA' : direction === 'SELL' ? 'VENDA' : '';

  let status = 'AGUARDAR — SEM ENTRADA';
  let action = 'NÃO ENTRAR';
  if (ui === 'OPERATION_ACTIVE' || activeRow) {
    status = 'OPERAÇÃO EM ANDAMENTO';
    action = 'AGUARDE O RESULTADO';
  } else if (model.actionable === true && String(model.uiState || '').startsWith('ENTER_')) {
    status = 'ENTRADA CONFIRMADA';
    action = 'PREPARE O TOQUE MANUAL';
  } else if (String(model.uiState || '').startsWith('POSSIBLE_')) {
    status = 'PRÉ-SINAL — POSSÍVEL';
    action = 'NÃO ENTRAR AINDA';
  }

  box.hidden = false;
  box.dataset.entryTarget = String(Number(target));
  box.dataset.entryDirection = side || '';
  box.dataset.entryUiState = ui;
  box.dataset.entryAction = action;
  box.className = 'entry-schedule ' + (side === 'COMPRA' ? 'buy' : side === 'VENDA' ? 'sell' : 'waiting');
  setText('entryScheduleLabel', status);
  setText('entryScheduleTime', targetText);
  setText('entryScheduleDirection', side || 'AGUARDAR');
  setText('entrySchedulePrice', remainingSeconds > 0 ? 'VIRA EM ' + remainingSeconds + 's' : 'VIRANDO AGORA');
  const priceEl = $('entrySchedulePrice');
  if (priceEl) priceEl.hidden = false;

  let nowEl = $('entryScheduleNow');
  if (!nowEl) {
    nowEl = document.createElement('span');
    nowEl.id = 'entryScheduleNow';
    nowEl.className = 'entry-now';
    box.appendChild(nowEl);
  }
  nowEl.innerHTML = 'AGORA <strong>' + nowText + '</strong>';

  let actionEl = $('entryScheduleAction');
  if (!actionEl) {
    actionEl = document.createElement('span');
    actionEl.id = 'entryScheduleAction';
    actionEl.className = 'entry-action';
    box.appendChild(actionEl);
  }
  actionEl.textContent = action + (side ? ' • ' + side : '');
}


function normalizeOperationalPulseLabels() {
  const replacements = { funnelCandidates: 'PRÉ-SINAIS ANALISADOS', funnelPossible: 'ENTRADAS CONFIRMADAS', funnelEntries: 'OPERAÇÕES FINALIZADAS' };
  for (const [id, label] of Object.entries(replacements)) {
    const value = $(id);
    const small = value?.parentElement?.querySelector('small');
    if (small) small.textContent = label;
  }
  const blocker = $('currentBlocker');
  if (blocker && /CANDIDATO MANTIDO/i.test(blocker.textContent || '')) blocker.textContent = blocker.textContent.replace(/CANDIDATO MANTIDO/ig, 'PRÉ-SINAL MANTIDO');
}

let lastRenderedState = {};
let countdownUi = { value: null, at: 0, cycle: '' };

function projectedRemaining(state = {}) {
  // Keep the real CasaTrade observation as the only clock authority, but project
  // between two exact samples so the UI does not freeze at 0s during the DOM
  // rollover. Projection is bounded to one candle and never invents a source.
  if (!exactClockReady(state)) return null;
  const clock = state.diagnostics?.marketClock || {};
  const raw = num(clock.secondsRemaining);
  const observedAt = Number(clock.at || 0);
  if (raw == null) return null;
  const elapsed = observedAt > 0 ? Math.max(0, (Date.now() - observedAt) / 1000) : 0;
  const duration = timeframeSeconds(clock.timeframe || state.analysisTimeframe || state.timeframe);
  const projected = raw - elapsed;
  return Math.max(0, projected);
}

function smoothedRemaining(state = {}) {
  const raw = projectedRemaining(state);
  if (raw == null) {
    countdownUi = { value: null, at: 0, cycle: '' };
    return null;
  }
  return Math.max(0, Math.round(raw));
}

function render(state = {}) {
  const licensed = renderLicense(state);
  if (!licensed) return;
  const model = decisionModel(state);
  renderEntrySchedule(state, model);
  const clock = state.diagnostics?.marketClock || {};
  const exact = exactClockReady(state);
  const dataLive = sessionReady(state);
  const timeReady = entryTimeReady(state);
  lastRenderedState = state;
  syncSettingsUi(state);

  const remaining = smoothedRemaining(state);
  const actualTf = normTf(clock.timeframe || state.platformControls?.observed?.timeframe || state.analysisTimeframe || state.timeframe);
  const expirationObs = expirationObservation(state);
  const actualExp = expirationObs.value;
  const operation = operationRequirement(state);
  const pending = transitionAsset(state);
  const session = sessionInfo(state);
  const panelFocusFresh = focusConfirmedThisPanel(state);
  const freshMarket = marketDataReady(state) && focusReady(state) && panelFocusFresh && sameMarket(state.diagnostics?.focusedAsset?.asset, state.asset);
  const visibleAsset = freshMarket ? marketId(session.confirmedAsset || state.asset) : '';
  const bootAwaitingFocus = !!state.targetTabId && !panelFocusFresh;

  setText('asset', visibleAsset || (pending ? `Atualizando para ${pending}…` : bootAwaitingFocus ? 'ATUALIZANDO…' : '—'));
  // The summary TF represents the bot operation mode, not a separate live
  // observation. The live CasaTrade timeframe is still validated below as an
  // entry gate, but every mode label now has one canonical source.
  setText('timeframe', freshMarket || pending || bootAwaitingFocus ? operation.timeframe : '—');
  setText('price', freshMarket ? fmtPrice(state.price) : '—');

  if (freshMarket) setSourceState('assetSource', 'REAL', 'real', 'Ativo confirmado pelo gráfico + feed da CasaTrade.');
  else if (pending || bootAwaitingFocus) setSourceState('assetSource', 'ATUALIZANDO', 'estimated', 'Confirmando novamente o ativo visível na CasaTrade.');
  else setSourceState('assetSource', 'STALE', 'stale', 'Ativo ainda não confirmado.');

  if (actualExp) {
    const expirationGuardSource = expirationObs.source || clean(state.diagnostics?.expirationGuard?.source || '');
    if (expirationObs.verified !== true || expirationGuardSource === 'user-declared') {
      const informedLabel = `${expLabel(actualExp)} (informada)`;
      setText('heroExpiration', informedLabel);
      setText('expiration', informedLabel);
      setSourceState('expirationSource', 'INFORMADA', 'estimated', 'Informada por você, não verificada pela CasaTrade');
    } else {
      setText('heroExpiration', actualExp === operation.expiration ? `${expLabel(actualExp)} ✓` : expLabel(actualExp));
      setText('expiration', actualExp === operation.expiration ? `${expLabel(actualExp)} ✓` : expLabel(actualExp));
      setSourceState('expirationSource', 'REAL', 'real', 'Expiração relida diretamente do controle da CasaTrade.');
    }
  } else {
    setText('heroExpiration', 'PENDENTE');
    setText('expiration', 'PENDENTE');
    setSourceState('expirationSource', 'PENDENTE', 'estimated', 'Aguardando leitura real do seletor de expiração da CasaTrade.');
  }

  const countdownText = remaining == null ? '—' : `${remaining}s`;
  setText('heroCountdown', countdownText);
  setText('secondsRemaining', remaining == null ? '—' : String(remaining));
  if (exact) setSourceState('countdownSource', 'REAL', 'real', 'Countdown exato lido da CasaTrade.');
  else setSourceState('countdownSource', 'PENDENTE', 'estimated', 'Aguardando countdown real da CasaTrade; nenhum tempo local é usado.');

  setText('heroTimeStatus', timeReady ? 'OK' : 'AGUARDAR');
  setText('sessionMode', timeReady ? 'LIVE' : exact ? 'LIVE • GATE' : 'LIVE • CLOCK PENDENTE');
  setText('timeSyncStatus', exact ? 'EXATO • CASATRADE' : 'PENDENTE');

  setText('signalTitle', model.title);
  setText('decisionText', model.text);
  setText('decisionSubtext', model.sub);
  setText('signalReason', model.reason);
  const setupLabel = liveTimingReady(state)
    ? (clean(state.signal?.setup || state.signal?.regime?.type || '—') || '—')
    : '—';
  setText('setupType', /^analista$/i.test(setupLabel) ? '—' : setupLabel);

  const decisionCard = $('decisionCard');
  if (decisionCard) decisionCard.className = `card decision-card ${model.tone}`;
  const banner = $('decisionBanner');
  if (banner) banner.className = `decision-banner ${model.tone}`;
  const badgeTone = ['buy','possible-buy'].includes(model.tone) ? 'ok' : ['sell','possible-sell'].includes(model.tone) ? 'bad' : 'warn';
  setBadge('signalBadge', model.actionable ? 'ENTRAR' : model.uiState.startsWith('POSSIBLE_') ? 'POSSÍVEL' : 'AGUARDAR', badgeTone);

  const duration = timeframeSeconds(actualTf);
  const progress = $('candleProgress');
  if (progress) {
    const pct = duration && remaining != null ? Math.max(0, Math.min(100, ((duration - remaining) / duration) * 100)) : 0;
    progress.style.width = `${pct}%`;
  }

  const buy = $('prepareBuy'), sell = $('prepareSell');
  const canBuy = model.actionable && model.direction === 'BUY' && timeReady;
  const canSell = model.actionable && model.direction === 'SELL' && timeReady;
  if (buy) { buy.disabled = !canBuy; buy.classList.toggle('selected', canBuy); }
  if (sell) { sell.disabled = !canSell; sell.classList.toggle('selected', canSell); }

  const actionStatus = $('tradeActionStatus');
  if (actionStatus) {
    const kind = gateKind(state);
    actionStatus.classList.remove('rule-block','technical-block');
    if (model.actionable && timeReady) {
      const target = num(state.signal?.targetStart ?? state.decisionCycle?.targetStart);
      let schedule = 'PRÓXIMA VELA';
      try { if (target != null) schedule = 'PRÓXIMA VELA • ' + new Date(target).toLocaleTimeString('pt-BR', {hour:'2-digit',minute:'2-digit'}); } catch {}
      actionStatus.textContent = 'ENTRADA CONFIRMADA: ' + (model.direction === 'BUY' ? 'COMPRA' : 'VENDA') + ' • ' + schedule + '.';
    } else if (model.uiState === 'OPERATION_ACTIVE') {
      actionStatus.textContent = 'OPERAÇÃO EM ANDAMENTO • aguarde a resolução antes de uma nova entrada.';
    } else if (!timeReady) {
      const block = entryBlockReason(state);
      if (kind === 'rule') {
        actionStatus.classList.add('rule-block');
        actionStatus.textContent = `Bloqueado por regra: ${block}`;
      } else if (kind === 'technical') {
        actionStatus.classList.add('technical-block');
        actionStatus.textContent = `Falha técnica: ${block}`;
      } else {
        actionStatus.textContent = block;
      }
    } else if (model.uiState.startsWith('POSSIBLE_')) {
      const target = num(state.signal?.targetStart ?? state.decisionCycle?.targetStart);
      let schedule = 'PRÓXIMA VELA';
      try { if (target != null) schedule = 'PRÓXIMA VELA • ' + new Date(target).toLocaleTimeString('pt-BR', {hour:'2-digit',minute:'2-digit'}); } catch {}
      actionStatus.textContent = 'PRÉ-SINAL: ' + (model.direction === 'BUY' ? 'COMPRA' : 'VENDA') + ' • ' + schedule + '.';
    } else {
      actionStatus.textContent = 'Aguardando nova entrada confirmada.';
    }
  }

  const expected = marketId(prefs.expectedAsset || '');
  const selectedNow = marketId(visibleAsset || pending);
  const warning = $('expectedAssetWarning');
  if (warning) {
    const mismatch = !!expected && !!selectedNow && !sameMarket(expected, selectedNow);
    warning.hidden = !mismatch;
    warning.textContent = mismatch ? `Você trocou para ${selectedNow}. Ativo esperado: ${expected}. Deseja continuar a análise nele?` : '';
  }

  const log = $('assetSwitchLog');
  if (log) {
    const rows = Array.isArray(state.diagnostics?.assetSwitchLog) ? state.diagnostics.assetSwitchLog.slice(-6).reverse() : [];
    log.replaceChildren();
    if (!rows.length) {
      const empty = document.createElement('span'); empty.textContent = 'Nenhuma troca registrada.'; log.append(empty);
    } else {
      for (const row of rows) {
        const item = document.createElement('span');
        item.className = row.cleanupOk ? 'ok' : '';
        const when = new Date(Number(row.at || 0)).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
        item.textContent = `${when} • ${row.from || '—'} → ${row.to || '—'} • limpeza ${row.cleanupOk ? 'OK' : 'PENDENTE'}`;
        log.append(item);
      }
    }
  }

  const retry = $('retryLiveRead');
  if (retry) {
    const age = sessionAgeMs(state);
    const marketTimedOut = activeLicense(state)
      && !!state.targetTabId
      && state.scanner === 'scanning'
      && !freshMarket
      && age >= 4000;
    // Expiration is recovered automatically by ATS_PROBE_PLATFORM_CONTROLS.
    // Do not surface a manual retry button just because the expiration reader
    // has not answered yet.
    retry.hidden = !marketTimedOut;
  }

  renderOhlc(freshMarket ? state : {});
  renderCandles(freshMarket ? state : {});
  normalizeOperationalPulseLabels();
  globalThis.__ATS_MARK_UI_READY__?.();
  setTimeout(normalizeOperationalPulseLabels, 0);
}

function tone(frequency, delay, duration, gain = .12) {
  try {
    audioContext ||= new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioContext.createOscillator();
    const amp = audioContext.createGain();
    const start = audioContext.currentTime + delay;
    osc.frequency.value = frequency;
    osc.type = 'sine';
    amp.gain.setValueAtTime(.0001, start);
    amp.gain.exponentialRampToValueAtTime(gain, start + .02);
    amp.gain.exponentialRampToValueAtTime(.0001, start + duration);
    osc.connect(amp); amp.connect(audioContext.destination); osc.start(start); osc.stop(start + duration + .03);
  } catch {}
}
function play(kind) {
  if (kind === 'possible') {
    tone(660,0,.14,.11); tone(820,.17,.13,.10);
    try { navigator?.vibrate?.([55,35,70]); } catch {}
    return;
  }
  tone(760,0,.18,.17); tone(940,.17,.19,.19); tone(1120,.31,.22,.22);
  try { navigator?.vibrate?.([110,55,150,55,210]); } catch {}
}
function syncSettingsUi(state = null) {
  const stateMode = clean(state?.analystPreferences?.operationMode || '').toUpperCase();
  const operationMode = stateMode === 'M5' ? 'M5' : stateMode === 'M1' ? 'M1' : (prefs.operationMode === 'M5' ? 'M5' : 'M1');
  if (stateMode === 'M1' || stateMode === 'M5') prefs = { ...prefs, operationMode };
  const operationExpirationLabel = operationMode === 'M5' ? '5 min' : '1 min';
  const payoutMap = prefs.payoutByMode && typeof prefs.payoutByMode === 'object' ? prefs.payoutByMode : { M1: 88, M5: 88 };
  if ($('operationMode')) $('operationMode').value = operationMode;
  if ($('signalPayout')) $('signalPayout').value = String(Number(payoutMap[operationMode] ?? 88));
  setText('scannerModeTitle', `${operationMode} • BOT ATIVO`);
  setText('scannerModeHeading', `Bot ${operationMode}`);
  setText('operationTimeframeDisplay', operationMode);
  setText('operationExpirationDisplay', operationExpirationLabel);
  setText('operationModeNote', `Modo ${operationMode}: timeframe ${operationMode} + expiração de ${operationMode === 'M5' ? '5 minutos' : '1 minuto'}. A execução continua manual na CasaTrade.`);
  if ($('overlayToggle')) $('overlayToggle').checked = !!prefs.overlayEnabled;
  if ($('geminiToggle')) $('geminiToggle').checked = prefs.geminiEnabled !== false;
  if ($('signalSensitivityProfile')) $('signalSensitivityProfile').value = ['RIGIDO','MEDIO','SOLTO'].includes(prefs.sensitivityProfile) ? prefs.sensitivityProfile : 'MEDIO';
  if ($('signalHoldDisplay')) $('signalHoldDisplay').textContent = `${profileHoldSeconds(prefs.sensitivityProfile)} s`;
  if ($('analystMode')) $('analystMode').value = prefs.analystMode === 'A_PLUS' ? 'A_PLUS' : 'NORMAL';
  if ($('notificationToggle')) $('notificationToggle').checked = prefs.notificationsEnabled !== false;
  if ($('alertLevel')) $('alertLevel').value = ['off','discrete','strong'].includes(prefs.alertLevel) ? prefs.alertLevel : DEFAULT_PREFS.alertLevel;
  if ($('holdSeconds')) $('holdSeconds').value = String(profileHoldSeconds(prefs.sensitivityProfile));
  if ($('possibleSoundToggle')) $('possibleSoundToggle').checked = prefs.alertLevel === 'discrete' || prefs.alertLevel === 'strong';
  if ($('confirmSoundToggle')) $('confirmSoundToggle').checked = prefs.alertLevel === 'strong';
  if ($('expectedAsset')) $('expectedAsset').value = clean(prefs.expectedAsset || '');
  document.querySelectorAll('.toggle-row').forEach(row => row.classList.toggle('active', !!row.querySelector('input[type=checkbox]')?.checked));
}

async function pushAnalystPreferences() {
  await chrome.runtime.sendMessage({
    type: 'ATS_SET_ANALYST_PREFERENCES',
    mode: 'NORMAL',
    geminiEnabled: prefs.geminiEnabled,
    operationMode: prefs.operationMode === 'M5' ? 'M5' : 'M1',
    sensitivityProfile: ['RIGIDO','MEDIO','SOLTO'].includes(prefs.sensitivityProfile) ? prefs.sensitivityProfile : 'MEDIO',
    preferredExpiration: null
  }).catch(() => null);
}

async function savePrefs() {
  await chrome.storage.local.set({ [PREF_KEY]: prefs }).catch(() => {});
  await pushAnalystPreferences();
}

async function setPref(key, value) {
  prefs = { ...prefs, [key]: value };
  if (key === 'sensitivityProfile') prefs = { ...prefs, holdSeconds: profileHoldSeconds(value) };
  if (key === 'possibleSoundEnabled' && value) play('possible');
  if (key === 'confirmSoundEnabled' && value) play('confirm');
  if (key === 'alertLevel' && value === 'discrete') play('possible');
  if (key === 'alertLevel' && value === 'strong') play('confirm');
  syncSettingsUi();
  await savePrefs();
}

async function loadPrefs() {
  const stored = await chrome.storage.local.get(PREF_KEY).catch(() => ({}));
  const raw = stored?.[PREF_KEY] || {};
  const migratedAlert = raw.alertLevel || (raw.confirmSoundEnabled ? 'strong' : raw.possibleSoundEnabled ? 'discrete' : DEFAULT_PREFS.alertLevel);
  prefs = {
    ...DEFAULT_PREFS,
    ...raw,
    overlayEnabled: false,
    notificationsEnabled: raw.notificationsEnabled !== false,
    alertLevel: ['off','discrete','strong'].includes(migratedAlert) ? migratedAlert : DEFAULT_PREFS.alertLevel,
    analystMode: 'NORMAL',
    geminiEnabled: raw.geminiEnabled !== false,
    operationMode: String(raw.operationMode || '').toUpperCase() === 'M5' ? 'M5' : 'M1',
    payoutByMode: {
      M1: Math.max(1, Math.min(200, Number(raw.payoutByMode?.M1 ?? 88) || 88)),
      M5: Math.max(1, Math.min(200, Number(raw.payoutByMode?.M5 ?? 88) || 88))
    },
    sensitivityProfile: ['RIGIDO','MEDIO','SOLTO'].includes(String(raw.sensitivityProfile || '').toUpperCase()) ? String(raw.sensitivityProfile).toUpperCase() : 'MEDIO',
    holdSeconds: profileHoldSeconds(raw.sensitivityProfile || 'MEDIO'),
    expectedAsset: clean(raw.expectedAsset || '')
  };
  syncSettingsUi();
  await pushAnalystPreferences();
}

$('overlayToggle')?.addEventListener('change', event => setPref('overlayEnabled', !!event.currentTarget.checked));
$('geminiToggle')?.addEventListener('change', event => setPref('geminiEnabled', !!event.currentTarget.checked));
$('operationMode')?.addEventListener('change', event => {
  const value = String(event.currentTarget.value || '').toUpperCase() === 'M5' ? 'M5' : 'M1';
  setPref('operationMode', value);
});
$('signalSensitivityProfile')?.addEventListener('change', event => {
  const value = String(event.currentTarget.value || '').toUpperCase();
  setPref('sensitivityProfile', ['RIGIDO','MEDIO','SOLTO'].includes(value) ? value : 'MEDIO');
});
$('signalPayout')?.addEventListener('change', async event => {
  const mode = prefs.operationMode === 'M5' ? 'M5' : 'M1';
  const value = Math.max(1, Math.min(200, Number(event.currentTarget.value) || 88));
  prefs = {
    ...prefs,
    payoutByMode: {
      ...(prefs.payoutByMode || { M1: 88, M5: 88 }),
      [mode]: value
    }
  };
  syncSettingsUi();
  await savePrefs();
});
$('notificationToggle')?.addEventListener('change', event => setPref('notificationsEnabled', !!event.currentTarget.checked));
$('analystMode')?.addEventListener('change', event => setPref('analystMode', event.currentTarget.value === 'A_PLUS' ? 'A_PLUS' : 'NORMAL'));
$('alertLevel')?.addEventListener('change', event => setPref('alertLevel', event.currentTarget.value));
$('holdSeconds')?.addEventListener('change', () => setPref('holdSeconds', profileHoldSeconds(prefs.sensitivityProfile)));
$('possibleSoundToggle')?.addEventListener('change', event => setPref('possibleSoundEnabled', !!event.currentTarget.checked));
$('confirmSoundToggle')?.addEventListener('change', event => setPref('confirmSoundEnabled', !!event.currentTarget.checked));
$('expectedAsset')?.addEventListener('change', event => setPref('expectedAsset', clean(event.currentTarget.value || '')));

$('activateLicense')?.addEventListener('click', async () => {
  const key = clean($('licenseKey')?.value || '');
  if (!key) return;
  const response = await chrome.runtime.sendMessage({ type: 'ATS_ACTIVATE_LICENSE', key }).catch(() => null);
  if (response?.state) render(response.state);
});

let periodicStateReadBusy = false;
setInterval(() => {
  try { normalizeOperationalPulseLabels(); } catch {}
  try { tickEntryScheduleClock(); } catch {}

  // Re-evaluate the decision against the same scanner state every second.
  // This makes the POSSÍVEL -> ENTRADA CONFIRMADA transition independent of
  // a new storage event and keeps the live countdown synchronized.
  if (!lastRenderedState || !Object.keys(lastRenderedState).length || periodicStateReadBusy) return;
  periodicStateReadBusy = true;
  chrome.runtime.sendMessage({ type: 'ATS_READ_SCANNER_STATE' })
    .then(response => { if (response?.state) render(response.state); })
    .catch(() => {})
    .finally(() => { periodicStateReadBusy = false; });
  const duration = timeframeSeconds(actualTf);
  const progress = $('candleProgress');
  if (progress) {
    const pct = duration && remaining != null ? Math.max(0, Math.min(100, ((duration - remaining) / duration) * 100)) : 0;
    progress.style.width = `${pct}%`;
  }
}, 250);

chrome.storage.onChanged.addListener(changes => {
  if (changes.scannerState?.newValue) render(changes.scannerState.newValue || {});
  if (changes[PREF_KEY]?.newValue) {
    const raw = changes[PREF_KEY].newValue || {};
    prefs = { ...prefs, ...raw };
    syncSettingsUi();
  }
});

(async () => {
  setText('extensionVersion', `v${chrome.runtime.getManifest().version}`);
  await loadPrefs();
  const response = await chrome.runtime.sendMessage({ type: 'ATS_READ_SCANNER_STATE' });
  if (response?.state) render(response.state);

  // Never trust a focus snapshot that predates this panel boot. Force one
  // passive refresh; the UI keeps the old asset hidden until the fresh visual
  // focus arrives, avoiding the EUR/USD vs NZD/USD frame-1 regression.
  const sourceTabId = Number(new URLSearchParams(location.search).get('sourceTabId') || 0);
  const refreshed = await chrome.runtime.sendMessage(
    sourceTabId > 0
      ? { type: 'ATS_CONNECT_ACTIVE_TAB', sourceTabId }
      : { type: 'ATS_REFRESH_MARKET' }
  ).catch(() => null);
  if (refreshed?.state) render(refreshed.state);
})().catch(() => render({}));
