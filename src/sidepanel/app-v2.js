const $ = id => document.getElementById(id);
const PREF_KEY = 'atsScannerUiPreferences';
const DEFAULT_PREFS = Object.freeze({
  overlayEnabled: false,
  possibleSoundEnabled: false,
  confirmSoundEnabled: false,
  alertLevel: 'discrete',
  notificationsEnabled: true,
  analystMode: 'A_PLUS',
  operatingTimeframe: 'M5',
  geminiEnabled: true,
  holdSeconds: 3,
  expectedAsset: ''
});

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
  const rows = (Array.isArray(state.candles) ? state.candles : []).filter(row => [row?.open,row?.high,row?.low,row?.close].every(value => num(value) != null));
  return session.dataReady === true
    && !!state.asset
    && sameMarket(session.confirmedAsset, state.asset)
    && num(state.price) != null
    && rows.length >= 2;
}
function expirationObservation(state = {}) {
  const controls = state.platformControls || {};
  const at = Number(controls.expirationCheckedAt || controls.observed?.observedAt?.expiration || 0);
  const value = normExp(controls.observed?.expiration);
  const fresh = at > 0 && !!value;
  return { value, fresh, at, ageMs: at > 0 ? Date.now() - at : Infinity };
}
function sessionAgeMs(state = {}) {
  const at = Number(sessionInfo(state).startedAt || state.diagnostics?.target?.connectedAt || 0);
  const panelAge = Math.max(0, Date.now() - PANEL_OPENED_AT);
  if (!(at > 0)) return panelAge;
  return Math.min(Math.max(0, Date.now() - at), panelAge);
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
function expLabel(value = '') {
  const exp = normExp(value);
  if (!exp) return '—';
  const seconds = Number(exp.replace(/\D/g, ''));
  if (seconds % 3600 === 0) return `${seconds / 3600} h`;
  if (seconds % 60 === 0) return `${seconds / 60} min`;
  return `${seconds} s`;
}

function normalizeOperatingTimeframe(value = '') {
  return clean(value).toUpperCase() === 'M1' ? 'M1' : 'M5';
}
function requiredExpirationForTimeframe(value = '') {
  return normalizeOperatingTimeframe(value) === 'M1' ? '60s' : '300s';
}
function contextTimeframeFor(value = '') {
  return normalizeOperatingTimeframe(value) === 'M1' ? 'M5' : 'M15';
}
function finalWindowForTimeframe(value = '') {
  return normalizeOperatingTimeframe(value) === 'M1' ? 10 : 20;
}
function selectedOperatingTimeframe(state = {}) {
  return normalizeOperatingTimeframe(
    state.analystPreferences?.operatingTimeframe
    || prefs.operatingTimeframe
    || DEFAULT_PREFS.operatingTimeframe
  );
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
  return focus.reliable === true
    && focus.chartScoped === true
    && focus.trustedChartFrame === true
    && (focus.embeddedTrader === true || focus.casaTradeFrame === true)
    && sameMarket(focus.asset, state.asset)
    && Number(focus.at || 0) > 0
    && Date.now() - Number(focus.at) < 5500;
}

function clockBaseReady(state = {}) {
  const clock = state.diagnostics?.marketClock || {};
  const focus = state.diagnostics?.focusedAsset || {};
  return focusReady(state)
    && clock.available !== false
    && clock.role === 'candle-close'
    && sameMarket(clock.asset, state.asset)
    && Number(clock.frameId) === Number(focus.frameId)
    && clean(clock.frameHost).toLowerCase() === clean(focus.frameHost).toLowerCase()
    && Number(clock.at || 0) > 0
    && Date.now() - Number(clock.at) < 3000
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
    && focusReady(state);
}

function entryTimeReady(state = {}) {
  const ui = clean(state.signal?.uiState).toUpperCase();
  return ui === 'ENTER_BUY' || ui === 'ENTER_SELL';
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

function entryBlockReason() {
  return 'Aguardando apenas a confirmação técnica da próxima entrada.';
}

function gateKind() {
  return 'waiting';
}

function activeEntryAdvice(state = {}) {
  const advice = state.entryAdvice || null;
  if (!advice?.direction || !advice?.asset) return null;
  const now = Date.now();
  const start = Number(advice.targetStart || 0);
  const end = Number(advice.activeUntil || 0);
  if (!start || !end || now < start || now >= end) return null;
  if (state.asset && !sameMarket(advice.asset, state.asset)) return null;
  return advice;
}

function decisionModel(state = {}) {
  if (!activeLicense(state)) return { uiState: 'WAIT', title: 'AGUARDAR', text: 'AGUARDAR', sub: 'Ative o acesso para iniciar a leitura.', tone: 'waiting', reason: 'Aguardando licença ativa.', score: 0, actionable: false };
  const pending = transitionAsset(state);
  if (pending) return { uiState: 'ANALYZING_MARKET', title: 'ATUALIZANDO ATIVO', text: `ATUALIZANDO PARA ${pending}`, sub: 'Limpando dados anteriores e confirmando o novo gráfico.', tone: 'waiting', reason: 'Troca de ativo em validação.', score: 0, actionable: false };
  if (!marketDataReady(state) || !focusReady(state)) return { uiState: 'ANALYZING_MARKET', title: 'AGUARDAR', text: 'AGUARDAR', sub: 'Confirmando ativo, preço e velas reais.', tone: 'waiting', reason: 'Identificando o gráfico atual da CasaTrade.', score: 0, actionable: false };

  const desiredTf = selectedOperatingTimeframe(state);
  const actualTf = normTf(state.diagnostics?.marketClock?.timeframe || state.analysisTimeframe || state.timeframe);
  if (actualTf && desiredTf !== actualTf) {
    return {
      uiState: 'WAIT',
      title: `AJUSTE PARA ${desiredTf}`,
      text: `AJUSTE O GRÁFICO PARA ${desiredTf}`,
      sub: `Modo selecionado: ${desiredTf}. Expiração recomendada: ${expLabel(requiredExpirationForTimeframe(desiredTf))}.`,
      tone: 'waiting',
      reason: `A extensão está configurada para ${desiredTf}, mas a CasaTrade está em ${actualTf}.`,
      score: 0,
      actionable: false
    };
  }

  const advice = activeEntryAdvice(state);
  if (advice) {
    const direction = String(advice.direction || '').toUpperCase();
    const side = direction === 'BUY' ? 'COMPRA' : 'VENDA';
    return {
      uiState: direction === 'BUY' ? 'ENTRY_ACTIVE_BUY' : 'ENTRY_ACTIVE_SELL',
      title: 'SINAL DA VELA',
      text: `SINAL DA VELA: ${side}`,
      sub: 'Sinal final emitido para a vela atual. Não repetir a entrada.',
      tone: direction === 'BUY' ? 'buy' : 'sell',
      reason: `${advice.setup ? advice.setup + ' • ' : ''}score ${Math.round(Number(advice.score || 0))}/100 • sinal mantido até o fechamento desta vela.`,
      score: Number(advice.score || 0),
      actionable: false,
      entryActive: true,
      direction
    };
  }

  const signal = state.signal || {};
  const ui = clean(signal.uiState).toUpperCase();
  const direction = ui.includes('BUY') ? 'BUY' : ui.includes('SELL') ? 'SELL' : null;
  const score = Number(signal.analysisScore ?? signal.score ?? 0) || 0;
  const reason = clean(signal.reason || 'Aguardando confluência técnica.');

  // The orchestrator signal is the only decision authority rendered by the UI.
  if (ui === 'ENTER_BUY') return { uiState: ui, title: 'ENTRADA', text: 'ENTRAR: COMPRA', sub: 'Entrada manual agora.', tone: 'buy', reason, score, actionable: true, direction: 'BUY' };
  if (ui === 'ENTER_SELL') return { uiState: ui, title: 'ENTRADA', text: 'ENTRAR: VENDA', sub: 'Entrada manual agora.', tone: 'sell', reason, score, actionable: true, direction: 'SELL' };
  if (ui === 'POSSIBLE_BUY') return { uiState: ui, title: 'POSSÍVEL COMPRA', text: 'POSSÍVEL COMPRA', sub: 'Candidato mantido nesta vela; aguardando confirmação final perto da janela operacional.', tone: 'possible', reason, score, actionable: false, direction: 'BUY' };
  if (ui === 'POSSIBLE_SELL') return { uiState: ui, title: 'POSSÍVEL VENDA', text: 'POSSÍVEL VENDA', sub: 'Candidato mantido nesta vela; aguardando confirmação final perto da janela operacional.', tone: 'possible', reason, score, actionable: false, direction: 'SELL' };
  if (ui === 'ANALYZING_MARKET') return { uiState: ui, title: 'ANALISANDO MERCADO', text: 'ANALISANDO MERCADO', sub: reason, tone: 'waiting', reason, score, actionable: false };
  if (ui === 'BUILDING_PATTERN' || ui === 'DECIDING') return { uiState: ui, title: 'ANALISANDO', text: 'ANALISANDO', sub: reason, tone: 'waiting', reason, score, actionable: false };
  return { uiState: 'WAIT', title: 'AGUARDAR', text: 'AGUARDAR', sub: 'Sem padrão técnico suficiente agora.', tone: 'no-trade', reason: reason.startsWith('AGUARDAR') ? reason : `AGUARDAR — ${reason}`, score, actionable: false };
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
  const tf = normTf(state.diagnostics?.marketClock?.timeframe || state.analysisTimeframe || state.timeframe || state.signal?.timeframe);
  const duration = timeframeSeconds(tf) || timeframeSeconds(selectedOperatingTimeframe(state)) || 60;
  const sources = [
    num(state.professionalDecision?.secondsRemaining),
    num(state.diagnostics?.marketClock?.secondsRemaining),
    num(state.signal?.secondsRemaining)
  ];
  const direct = sources.find(value => value != null && value >= 0 && value <= duration + 2);
  if (direct != null) return Math.max(0, direct);

  const candidates = [
    state.currentCandle,
    state.signal?.currentCandle,
    Array.isArray(state.candles) ? state.candles.at(-1) : null
  ].filter(Boolean);
  for (const row of candidates) {
    let openAt = num(row?.time ?? row?.timestamp);
    if (openAt != null && openAt > 0 && openAt < 1e12) openAt *= 1000;
    if (!Number.isFinite(openAt)) continue;
    const closeAt = openAt + duration * 1000;
    const now = Date.now();
    if (now < openAt - 1500 || now > closeAt + 1500) continue;
    return Math.max(0, Math.min(duration, Math.ceil((closeAt - now) / 1000)));
  }
  return null;
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

  const remaining = smoothedRemaining(state);
  const actualTf = normTf(clock.timeframe || state.platformControls?.observed?.timeframe || state.analysisTimeframe || state.timeframe);
  const desiredTf = selectedOperatingTimeframe(state);
  const requiredExp = requiredExpirationForTimeframe(desiredTf);
  const contextTf = contextTimeframeFor(desiredTf);
  const finalWindow = finalWindowForTimeframe(desiredTf);
  const expirationObs = expirationObservation(state);
  const actualExp = expirationObs.value;
  const pending = transitionAsset(state);
  const session = sessionInfo(state);
  const freshMarket = marketDataReady(state) && focusReady(state) && sameMarket(state.diagnostics?.focusedAsset?.asset, state.asset);
  const visibleAsset = freshMarket ? marketId(session.confirmedAsset || state.asset) : '';

  setText('asset', visibleAsset || (pending ? `Atualizando para ${pending}…` : '—'));
  setText('timeframe', freshMarket || pending ? (actualTf || '—') : '—');
  setText('price', freshMarket ? fmtPrice(state.price) : '—');
  setText('scannerModeTitle', `A+ ${desiredTf} AO VIVO`);
  setText('heroExpirationPlan', expLabel(requiredExp));
  setText('strategyTf', desiredTf);
  setText('strategyContext', contextTf);
  setText('strategyExpiration', expLabel(requiredExp));
  setText('strategyEntryWindow', `~${finalWindow} s`);
  setText('analysisEntryWindow', `~${finalWindow}s`);
  setText('strategyNote', `${desiredTf} operacional + contexto ${contextTf}. A entrada é na próxima vela de ${desiredTf === 'M1' ? '1' : '5'} minuto(s), com expiração manual de ${expLabel(requiredExp)}.`);

  if (freshMarket) setSourceState('assetSource', 'REAL', 'real', 'Ativo confirmado pelo gráfico + feed da CasaTrade.');
  else if (pending) setSourceState('assetSource', 'ATUALIZANDO', 'estimated', 'Troca detectada; preço e velas anteriores já foram descartados.');
  else setSourceState('assetSource', 'STALE', 'stale', 'Ativo ainda não confirmado.');


  const countdownText = remaining == null ? '—' : `${remaining}s`;
  setText('heroCountdown', countdownText);
  setText('secondsRemaining', remaining == null ? '—' : String(remaining));
  if (exact) setSourceState('countdownSource', 'REAL', 'real', 'Countdown exato lido da CasaTrade.');
  else setSourceState('countdownSource', 'PENDENTE', 'estimated', 'Aguardando countdown real da CasaTrade; nenhum tempo local é usado.');

  setText('heroTimeStatus', 'LIVE');
  setText('sessionMode', 'LIVE');

  setText('signalTitle', model.title);
  setText('decisionText', model.text);
  setText('decisionSubtext', model.sub);
  setText('signalReason', model.reason);
  const setupLabel = clean(state.signal?.setup || state.signal?.regime?.type || '—') || '—';
  setText('setupType', /^analista$/i.test(setupLabel) ? '—' : setupLabel);

  const decisionCard = $('decisionCard');
  if (decisionCard) decisionCard.className = `card decision-card ${model.tone}`;
  const banner = $('decisionBanner');
  if (banner) banner.className = `decision-banner ${model.tone}`;
  const badgeTone = model.tone === 'buy' ? 'ok' : model.tone === 'sell' ? 'bad' : 'warn';
  setBadge('signalBadge', model.entryActive ? 'SINAL DA VELA' : model.actionable ? 'ENTRAR' : model.uiState.startsWith('POSSIBLE_') ? 'POSSÍVEL' : 'AGUARDAR', badgeTone);

  const duration = timeframeSeconds(actualTf);
  const progress = $('candleProgress');
  if (progress) {
    const pct = duration && remaining != null ? Math.max(0, Math.min(100, ((duration - remaining) / duration) * 100)) : 0;
    progress.style.width = `${pct}%`;
  }

  const buy = $('prepareBuy'), sell = $('prepareSell');
  const canBuy = model.actionable && model.direction === 'BUY';
  const canSell = model.actionable && model.direction === 'SELL';
  if (buy) { buy.disabled = !canBuy; buy.classList.toggle('selected', canBuy); }
  if (sell) { sell.disabled = !canSell; sell.classList.toggle('selected', canSell); }

  const actionStatus = $('tradeActionStatus');
  if (actionStatus) {
    actionStatus.classList.remove('rule-block','technical-block');
    if (model.entryActive) {
      actionStatus.textContent = `Sinal ${model.direction === 'BUY' ? 'COMPRA' : 'VENDA'} já emitido para esta vela. Não repetir entrada.`;
    } else if (model.actionable) {
      actionStatus.textContent = `ENTRADA AGORA: ${model.direction === 'BUY' ? 'COMPRA' : 'VENDA'}.`;
    } else if (model.uiState.startsWith('POSSIBLE_')) {
      actionStatus.textContent = `Sinal possível detectado. Aguardando confirmação final perto de ${finalWindow}s.`;
    } else {
      actionStatus.textContent = 'Aguardando um sinal técnico válido.';
    }
  }

  const tfWarning = $('timeframeModeWarning');
  if (tfWarning) {
    const mismatch = !!actualTf && actualTf !== desiredTf;
    tfWarning.hidden = !mismatch;
    tfWarning.textContent = mismatch
      ? `Scanner em ${desiredTf}, mas a CasaTrade está em ${actualTf}. Troque o período da vela para ${desiredTf} antes de operar. Expiração: ${expLabel(requiredExp)}.`
      : '';
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
    const marketTimedOut = !!pending && sessionAgeMs(state) >= 8000;
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
function syncSettingsUi() {
  if ($('overlayToggle')) $('overlayToggle').checked = !!prefs.overlayEnabled;
  if ($('geminiToggle')) $('geminiToggle').checked = prefs.geminiEnabled !== false;
  if ($('analystMode')) $('analystMode').value = prefs.analystMode === 'A_PLUS' ? 'A_PLUS' : 'NORMAL';
  if ($('operatingTimeframe')) $('operatingTimeframe').value = normalizeOperatingTimeframe(prefs.operatingTimeframe);
  if ($('notificationToggle')) $('notificationToggle').checked = prefs.notificationsEnabled !== false;
  if ($('alertLevel')) $('alertLevel').value = ['off','discrete','strong'].includes(prefs.alertLevel) ? prefs.alertLevel : DEFAULT_PREFS.alertLevel;
  if ($('holdSeconds')) $('holdSeconds').value = String(Math.max(3, Math.min(5, Number(prefs.holdSeconds) || 3)));
  if ($('possibleSoundToggle')) $('possibleSoundToggle').checked = prefs.alertLevel === 'discrete' || prefs.alertLevel === 'strong';
  if ($('confirmSoundToggle')) $('confirmSoundToggle').checked = prefs.alertLevel === 'strong';
  if ($('expectedAsset')) $('expectedAsset').value = clean(prefs.expectedAsset || '');
  document.querySelectorAll('.toggle-row').forEach(row => row.classList.toggle('active', !!row.querySelector('input[type=checkbox]')?.checked));
}

async function pushAnalystPreferences() {
  await chrome.runtime.sendMessage({
    type: 'ATS_SET_ANALYST_PREFERENCES',
    mode: 'A_PLUS',
    operatingTimeframe: normalizeOperatingTimeframe(prefs.operatingTimeframe),
    geminiEnabled: prefs.geminiEnabled,
    holdSeconds: 3,
    preferredExpiration: requiredExpirationForTimeframe(prefs.operatingTimeframe)
  }).catch(() => null);
}

async function savePrefs() {
  await chrome.storage.local.set({ [PREF_KEY]: prefs }).catch(() => {});
  await pushAnalystPreferences();
}

async function setPref(key, value) {
  prefs = { ...prefs, [key]: value };
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
    analystMode: 'A_PLUS',
    operatingTimeframe: normalizeOperatingTimeframe(raw.operatingTimeframe || DEFAULT_PREFS.operatingTimeframe),
    geminiEnabled: raw.geminiEnabled !== false,
    holdSeconds: 3,
    expectedAsset: clean(raw.expectedAsset || '')
  };
  syncSettingsUi();
  await pushAnalystPreferences();
}

$('overlayToggle')?.addEventListener('change', event => setPref('overlayEnabled', !!event.currentTarget.checked));
$('geminiToggle')?.addEventListener('change', event => setPref('geminiEnabled', !!event.currentTarget.checked));
$('notificationToggle')?.addEventListener('change', event => setPref('notificationsEnabled', !!event.currentTarget.checked));
$('analystMode')?.addEventListener('change', event => setPref('analystMode', event.currentTarget.value === 'A_PLUS' ? 'A_PLUS' : 'NORMAL'));
$('operatingTimeframe')?.addEventListener('change', event => setPref('operatingTimeframe', normalizeOperatingTimeframe(event.currentTarget.value)));
$('alertLevel')?.addEventListener('change', event => setPref('alertLevel', event.currentTarget.value));
$('holdSeconds')?.addEventListener('change', event => setPref('holdSeconds', Math.max(3, Math.min(5, Number(event.currentTarget.value) || 3))));
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
})().catch(() => render({}));
