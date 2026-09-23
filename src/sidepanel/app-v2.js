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
  // A verified CasaTrade expiration survives short control re-renders. Manual
  // fallback is visible to the user but never counts as verified timing.
  const realFresh = !!realValue && realAt > 0 && Date.now() - realAt < 15000 && realSource !== 'user-declared';
  const at = realFresh ? realAt : observedAt;
  const manualFresh = observedAt > 0 && Date.now() - observedAt < 7000;
  const manualValue = manualFresh ? normExp(controls.observed?.expiration || controls.userDeclaredExpiration || '') : null;
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
    && Date.now() - Number(focus.at) < 5500;
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
  return focusReady(state)
    && clock.available !== false
    && clock.role === 'candle-close'
    && sameMarket(clock.asset, state.asset)
    && clockBoundToFocus(clock, focus)
    && Number(clock.at || 0) > 0
    && Date.now() - Number(clock.at) < 4500
    && num(clock.secondsRemaining) != null;
}

function exactClockReady(state = {}) {
  const clock = state.diagnostics?.marketClock || {};
  if (!clockBaseReady(state)) return false;
  return clock.verified === true && ['trader-dom-countdown', 'network-server-cycle'].includes(String(clock.source || ''));
}

function operationalClockReady(state = {}) {
  // There is no operational fallback clock anymore. The scanner may only use
  // an exact CasaTrade countdown source as time authority.
  return exactClockReady(state);
}

function sessionReady(state = {}) {
  return activeLicense(state)
    && state.connection === 'online'
    && marketDataReady(state)
    && focusReady(state)
    && operationalClockReady(state);
}

function liveTimingReady(state = {}) {
  if (!exactClockReady(state)) return false;
  const clock = state.diagnostics?.marketClock || {};
  const expiration = expirationObservation(state);
  const operation = operationRequirement(state);
  return expiration.verified === true
    && expiration.value === operation.expiration
    && normTf(clock.timeframe) === operation.timeframe;
}

function entryTimeReady(state = {}) {
  if (!exactClockReady(state)) return false;
  const clock = state.diagnostics?.marketClock || {};
  const expiration = expirationObservation(state);
  const actualExpiration = expiration.value;
  if (!actualExpiration || expiration.verified !== true) return false;
  const operation = operationRequirement(state);
  const clockTf = normTf(clock.timeframe);
  const stateTf = normTf(state.analysisTimeframe || state.timeframe);
  const controlTf = normTf(state.platformControls?.observed?.timeframe);
  if (!clockTf || clockTf !== operation.timeframe) return false;
  if (actualExpiration !== operation.expiration) return false;
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
  const targetStart = num(state.signal?.targetStart) ?? num(state.diagnostics?.marketClock?.closeAt);
  if (targetStart != null) return `${marketId(state.asset)}|${tf}|${Math.round(targetStart / 1000) * 1000}`;
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
  if (!expiration.value) return 'EXPIRAÇÃO REAL PENDENTE — AGUARDANDO LEITURA DA CASATRADE';
  if (expiration.verified !== true) return 'EXPIRAÇÃO INFORMADA, MAS NÃO VERIFICADA — AGUARDANDO A CASATRADE';
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

  // A POSSÍVEL is a technical pre-signal and must remain visible even when
  // the final entry timing gate is still waiting for an exact clock/expiration.
  // This does not create a signal or change thresholds; it only prevents the
  // UI timing gate from hiding a decision already produced by the engine.
  const earlyProfessional = state.professionalDecision || {};
  const earlyTechnical = state.signal || {};
  const earlyUi = String(earlyProfessional.uiState || earlyTechnical.uiState || '').toUpperCase();
  const earlyDirection = earlyUi.endsWith('_BUY') ? 'BUY' : earlyUi.endsWith('_SELL') ? 'SELL' : null;
  const earlyPossible = ['POSSIBLE_BUY','POSSIBLE_SELL'].includes(earlyUi) && earlyDirection;
  if (earlyPossible) {
    const earlyScore = Number(earlyProfessional.score ?? earlyTechnical.analysisScore ?? earlyTechnical.score ?? 0) || 0;
    const earlyReason = clean(earlyProfessional.reason || earlyTechnical.reason || 'Alta confiança técnica detectada.');
    return {
      uiState: earlyDirection === 'BUY' ? 'POSSIBLE_BUY' : 'POSSIBLE_SELL',
      title: earlyDirection === 'BUY' ? 'COMPRA — POSSÍVEL' : 'VENDA — POSSÍVEL',
      text: earlyDirection === 'BUY' ? 'POSSÍVEL COMPRA' : 'POSSÍVEL VENDA',
      sub: liveTimingReady(state) ? 'Alta confiança detectada; aguardando janela final.' : 'Pré-sinal técnico detectado; aguardando sincronização final da entrada.',
      tone: 'possible', reason: earlyReason, score: earlyScore, actionable: false, direction: earlyDirection
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
  const ui = String(p.uiState || technical.uiState || '').toUpperCase();
  const technicalUi = String(technical.uiState || '').toUpperCase();
  const direction = String(p.direction || technical.direction || technical.analysisDirection || '').toUpperCase();
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
        title: `${side} — ALTA CONFIANÇA`,
        text: `PRÉ-SINAL: ${side}`,
        sub: blocked,
        tone: 'possible',
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
  if (ui === 'POSSIBLE_BUY') return { uiState: ui, title: 'COMPRA — ALTA CONFIANÇA', text: 'PRÉ-SINAL: COMPRA', sub: 'Alta confiança detectada; aguardando janela final.', tone: 'possible', reason, score, actionable: false, direction: 'BUY' };
  if (ui === 'POSSIBLE_SELL') return { uiState: ui, title: 'VENDA — ALTA CONFIANÇA', text: 'PRÉ-SINAL: VENDA', sub: 'Alta confiança detectada; aguardando janela final.', tone: 'possible', reason, score, actionable: false, direction: 'SELL' };
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

function renderLicense(state = {}) {
  const license = state.license || {};
  const active = activeLicense(state);
  const card = $('licenseCard');
  if (card) card.classList.toggle('active', active);
  setText('licenseTitle', active ? `Licença ${license.planLabel || license.plan || 'ATIVA'}` : 'Licença necessária');
  setBadge('licenseHealth', active ? 'ATIVA' : 'INATIVA', active ? 'ok' : 'warn');
  setText('licenseText', active ? 'Acesso validado. O scanner pode ler o mercado aberto.' : (license.error ? `Acesso: ${license.error}` : 'Insira sua chave para ativar.'));
  const box = $('activationBox'); if (box) box.hidden = active;
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
  if (projected > 0) return projected;
  if (duration && elapsed <= 4) {
    const wrapped = duration + projected;
    if (wrapped > 0 && wrapped <= duration) return wrapped;
  }
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
  const model = decisionModel(state);
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
  // The summary TF represents the scanner operation mode, not a separate live
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
  const badgeTone = model.tone === 'buy' ? 'ok' : model.tone === 'sell' ? 'bad' : 'warn';
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
      actionStatus.textContent = `Entrada manual liberada para ${model.direction === 'BUY' ? 'COMPRA' : 'VENDA'} na próxima vela.`;
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
      actionStatus.textContent = `Possível sinal em hold (${Math.ceil(Number(state.professionalDecision?.holdRemainingMs || 0) / 1000)}s restantes).`;
    } else {
      actionStatus.textContent = 'Aguardando decisão final desta vela.';
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
  renderLicense(state);
  globalThis.__ATS_MARK_UI_READY__?.();
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
  setText('scannerModeTitle', `${operationMode} AO VIVO`);
  setText('scannerModeHeading', `Scanner ${operationMode}`);
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

setInterval(() => {
  if (!lastRenderedState || !Object.keys(lastRenderedState).length) return;
  const remaining = smoothedRemaining(lastRenderedState);
  const exact = exactClockReady(lastRenderedState);
  const actualTf = normTf(lastRenderedState.diagnostics?.marketClock?.timeframe || lastRenderedState.analysisTimeframe || lastRenderedState.timeframe);
  setText('heroCountdown', remaining == null ? '—' : exact ? `${Math.ceil(remaining)}s` : `~${Math.ceil(remaining)}s`);
  setText('secondsRemaining', remaining == null ? '—' : exact ? String(Math.max(0, Math.ceil(remaining))) : `~${Math.max(0, Math.ceil(remaining))}`);
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
  const refreshed = await chrome.runtime.sendMessage({ type: 'ATS_REFRESH_MARKET' }).catch(() => null);
  if (refreshed?.state) render(refreshed.state);
})().catch(() => render({}));
