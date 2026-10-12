import { assessEntryConfidence } from '../core/entry-confidence.js';
import { getOperationMode } from '../core/analysis.js';
import { canShowFinalEntry, canShowTechnicalAnalysis, selectTechnicalScore } from '../core/decision-display.js';

const $ = id => document.getElementById(id);
const num = value => value == null || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null;
const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();

function marketId(value = '') {
  const raw = clean(value).toUpperCase();
  if (!raw) return '';
  const otc = /(?:\(|\b|[_-])OTC(?:\)|\b)?/.test(raw);
  const match = raw.match(/\b([A-Z0-9]{2,20})\s*[\/_-]\s*([A-Z0-9]{2,12})/);
  return match ? `${match[1]}/${match[2]}${otc ? ' (OTC)' : ''}` : '';
}
const sameMarket = (a, b) => !!marketId(a) && marketId(a) === marketId(b);

function marketReady(state = {}) {
  const session = state.diagnostics?.marketSession || {};
  const focus = state.diagnostics?.focusedAsset || {};
  const signal = state.signal || {};
  const rows = (Array.isArray(state.candles) ? state.candles : [])
    .filter(row => [row?.open,row?.high,row?.low,row?.close].every(value => num(value) != null));
  const ambiguousPassive = Number(focus.ambiguityCount || 0) > 0
    && focus.explicit !== true
    && focus.interactionHint !== true;
  const signalMatches = !signal.asset || sameMarket(signal.asset, state.asset);
  const candleMatches = !state.currentCandle?.asset || sameMarket(state.currentCandle.asset, state.asset);
  return state.connection === 'online'
    && session.dataReady === true
    && !!state.asset
    && sameMarket(session.confirmedAsset, state.asset)
    && sameMarket(focus.asset, state.asset)
    && signalMatches
    && candleMatches
    && focus.reliable === true
    && focus.chartScoped === true
    && focus.visualAuthority !== false
    && !ambiguousPassive
    && num(state.price) != null
    && rows.length >= 2;
}

function normTf(value = '') {
  const raw = clean(value).toUpperCase().replace(/\s+/g, '');
  let match = raw.match(/^([SMH])(\d{1,5})$/);
  if (match && Number(match[2]) > 0) return `${match[1]}${Number(match[2])}`;
  match = raw.match(/^(\d{1,4})(?:M|MIN)$/);
  return match && Number(match[1]) > 0 ? `M${Number(match[1])}` : null;
}

function clockBoundToFocus(clock = {}, focus = {}) {
  const sameFrame = Number(clock.frameId) === Number(focus.frameId)
    && clean(clock.frameHost).toLowerCase() === clean(focus.frameHost).toLowerCase();
  const boundControlFrame = clock.crossFrameControl === true
    && Number(clock.boundFocusFrameId) === Number(focus.frameId)
    && clean(clock.boundFocusFrameHost).toLowerCase() === clean(focus.frameHost).toLowerCase();
  return sameFrame || boundControlFrame;
}

function timingReady(state = {}) {
  const operationMode = getOperationMode(state.analystPreferences?.operationMode || 'M1');
  const focus = state.diagnostics?.focusedAsset || {};
  const clock = state.diagnostics?.marketClock || {};
  const controls = state.platformControls || {};
  const expAt = Number(controls.realExpirationAt || 0);
  const expSource = clean(controls.realExpirationSource || controls.expirationSource || '');
  const expiration = expAt > 0 && Date.now() - expAt < 15000 && expSource !== 'user-declared'
    ? clean(controls.realExpiration)
    : '';
  return expiration === operationMode.expiration
    && state.diagnostics?.expirationGuard?.verified === true
    && clock.verified === true
    && clock.available !== false
    && ['trader-dom-countdown','network-server-cycle'].includes(clean(clock.source))
    && normTf(clock.timeframe) === operationMode.timeframe
    && sameMarket(clock.asset, state.asset)
    && clockBoundToFocus(clock, focus)
    && Number(clock.at || 0) > 0
    && Date.now() - Number(clock.at) < 4500
    && num(clock.secondsRemaining) != null;
}

// Candle analysis and permission to enter are separate concerns.
// A stale/unverified clock must block a trade, not erase the technical score.
function analysisReady(state = {}) {
  return canShowTechnicalAnalysis({ marketReady: marketReady(state) });
}

function timingBlockReason(state = {}) {
  const operation = getOperationMode(state.analystPreferences?.operationMode || 'M1');
  const controls = state.platformControls || {};
  const clock = state.diagnostics?.marketClock || {};
  const focus = state.diagnostics?.focusedAsset || {};
  const now = Date.now();
  const expAt = Number(controls.realExpirationAt || 0);
  const expSource = clean(controls.realExpirationSource || controls.expirationSource || '');
  const observedExpiration = expAt > 0 && now - expAt >= 0 && now - expAt < 15000 && expSource !== 'user-declared'
    ? clean(controls.realExpiration)
    : '';
  if (observedExpiration !== operation.expiration) {
    return `Expiração real de ${operation.expiration === '300s' ? '5 minutos' : '1 minuto'} ainda não foi confirmada; valor informado não libera entrada.`;
  }
  if (state.diagnostics?.expirationGuard?.verified !== true) {
    return 'A CasaTrade ainda não confirmou a expiração real do ativo selecionado.';
  }
  if (clock.verified !== true || clock.available === false
    || !['trader-dom-countdown','network-server-cycle'].includes(clean(clock.source))) {
    return 'Countdown exato da CasaTrade ainda não está validado.';
  }
  if (normTf(clock.timeframe) !== operation.timeframe) {
    return `Timeframe real é ${normTf(clock.timeframe) || 'não confirmado'}; o modo ativo exige ${operation.timeframe}.`;
  }
  if (!sameMarket(clock.asset, state.asset)) return 'O relógio observado pertence a outro ativo.';
  if (!clockBoundToFocus(clock, focus)) return 'O relógio ainda não está vinculado ao frame do gráfico ativo.';
  const age = now - Number(clock.at || 0);
  if (!(Number(clock.at || 0) > 0 && age >= 0 && age < 4500)) return 'A leitura do countdown ficou desatualizada.';
  if (num(clock.secondsRemaining) == null) return 'Countdown da próxima vela indisponível.';
  return 'Timeframe e expiração ainda não foram confirmados juntos.';
}

function technicalDirection(state = {}) {
  const signal = state.signal || {};
  const ui = clean(signal.uiState).toUpperCase();
  if (ui.includes('BUY')) return 'BUY';
  if (ui.includes('SELL')) return 'SELL';
  const direction = clean(signal.direction || signal.analysisDirection).toUpperCase();
  return ['BUY','SELL'].includes(direction) ? direction : null;
}

function guidance(state = {}) {
  if (!marketReady(state)) {
    return {
      tone: 'waiting',
      value: 'AGUARDANDO DADOS',
      hint: 'Confirmando ativo, preço e velas reais da CasaTrade antes de calcular o score.'
    };
  }
  const technical = state.signal || {};
  const decision = state.professionalDecision || {};
  const professionalUi = clean(decision.uiState).toUpperCase();
  const technicalUi = clean(technical.uiState).toUpperCase();
  const direction = technicalDirection(state);
  const side = direction === 'BUY' ? 'COMPRA' : direction === 'SELL' ? 'VENDA' : '';
  const clockAndExpiryReady = timingReady(state);
  const timeReady = clockAndExpiryReady && decision.timeReady === true && decision.expirationReady === true;
  const timingBlock = clockAndExpiryReady ? '' : timingBlockReason(state);
  const block = clean(decision.reason || '');

  if (technical.directionTransition?.from && technical.directionTransition?.to) {
    const from = technical.directionTransition.from === 'BUY' ? 'COMPRA' : 'VENDA';
    const to = technical.directionTransition.to === 'BUY' ? 'COMPRA' : 'VENDA';
    return {
      tone: 'waiting',
      value: 'PADRÃO MUDANDO — REAVALIANDO',
      hint: `${from} → ${to}. A nova direção precisa se sustentar antes de substituir o padrão atual.`
    };
  }

  if ((professionalUi === 'ENTER_BUY' || professionalUi === 'ENTER_SELL') && canShowFinalEntry({ marketReady: marketReady(state), timingReady: clockAndExpiryReady, decisionTimeReady: decision.timeReady === true, expirationReady: decision.expirationReady === true, actionable: decision.actionable === true }) && timeReady) {
    return {
      tone: direction === 'BUY' ? 'buy' : 'sell',
      value: `CONFIRMADO • ${side}`,
      hint: clean(decision.reason || 'Confirmação técnica concluída. Entrada manual somente na próxima vela.')
    };
  }

  if (['POSSIBLE_BUY','POSSIBLE_SELL','ENTER_BUY','ENTER_SELL'].includes(professionalUi) && direction) {
    const remaining = Math.ceil(Math.max(0, Number(decision.holdRemainingMs || 0)) / 1000);
    const technicalReason = clean(decision.reason || 'Padrão técnico em confirmação.');
    const blocked = !timeReady ? ` Entrada bloqueada: ${timingBlock || 'tempo/expiração não confirmados'}.` : '';
    return {
      tone: timeReady && professionalUi.startsWith('ENTER_') && decision.actionable === true
        ? (direction === 'BUY' ? 'buy' : 'sell')
        : 'possible',
      value: !timeReady ? `PADRÃO ${side} • BLOQUEADO` : `PADRÃO ${side || 'EM OBSERVAÇÃO'}`,
      hint: `${technicalReason}${blocked}${remaining > 0 ? ` Hold: ${remaining}s.` : ''}`
    };
  }

  // Keep showing the primary technical engine even when the user-facing funnel
  // is blocked by clock/timeframe/expiration. This is analysis, not authorization.
  if (direction && ['POSSIBLE_BUY','POSSIBLE_SELL','ENTER_BUY','ENTER_SELL','DECIDING'].includes(technicalUi)) {
    return {
      tone: 'possible',
      value: !timeReady ? `PADRÃO ${side} • BLOQUEADO` : `PADRÃO ${side}`,
      hint: timeReady
        ? clean(technical.reason || 'Padrão técnico detectado; aguardando confirmação final.')
        : `${clean(technical.reason || 'Padrão técnico detectado.')} Entrada bloqueada: ${timingBlock || block || 'tempo/expiração ainda não confirmados.'}`
    };
  }

  if (technicalUi === 'BUILDING_PATTERN' || technicalUi === 'ANALYZING_MARKET') {
    return {
      tone: 'waiting',
      value: 'ANALISANDO',
      hint: `${clean(technical.reason || 'Lendo preço, força, rejeição, momentum e estrutura.')}${!timeReady ? ` Entrada bloqueada: ${timingBlock || block || 'tempo/expiração não confirmados'}.` : ''}`
    };
  }

  return {
    tone: 'skip',
    value: 'SEM PADRÃO',
    hint: `${clean(technical.reason || block || 'Nenhum padrão técnico válido neste momento.')}${!timeReady ? ` Entrada bloqueada: ${timingBlock || block || 'tempo/expiração não confirmados'}.` : ''}`
  };
}

let displayedScore = null;
let displayedScoreKey = '';

function visibleScoreKey(state = {}) {
  const candle = state.signal?.currentCandle || state.currentCandle || {};
  const clock = state.diagnostics?.marketClock || {};
  return [
    clean(state.asset || ''),
    clean(state.analysisTimeframe || state.timeframe || state.signal?.timeframe || ''),
    Number(candle.time ?? candle.timestamp ?? clock.openAt ?? clock.candleOpenAt ?? 0)
  ].join('|');
}

function stabilizedVisibleScore(state = {}, rawScore = 0, ready = false) {
  if (!ready) {
    displayedScore = 0;
    displayedScoreKey = '';
    return 0;
  }
  const raw = Math.max(0, Math.min(100, Number(rawScore) || 0));
  const key = visibleScoreKey(state);
  if (!key || key !== displayedScoreKey) {
    displayedScoreKey = key;
    displayedScore = raw;
    return Math.round(displayedScore);
  }
  // The candle is live and the raw score may jump on every price tick. Keep the
  // presentation readable without changing the underlying decision score.
  const delta = raw - displayedScore;
  if (Math.abs(delta) <= 2) displayedScore = raw;
  else displayedScore += delta * 0.20;
  displayedScore = Math.max(0, Math.min(100, displayedScore));
  return Math.round(displayedScore);
}

function render(state = {}) {
  const ready = analysisReady(state);
  const technicalConfidence = ready ? assessEntryConfidence(state) : { score: 0 };
  const decision = ready ? (state.professionalDecision || {}) : {};
  const technical = ready ? (state.signal || {}) : {};
  const scoreRaw = ready ? selectTechnicalScore({
    analysisScore: technical.analysisScore,
    technicalScore: technical.score,
    decisionScore: decision.score,
    confidenceScore: technicalConfidence.score
  }) : 0;
  const score = stabilizedVisibleScore(state, scoreRaw, ready);
  const guide = guidance(state);
  const card = $('triggerCard');

  if (card) card.className = `trigger-card ${guide.tone} compact-trigger analysis-status-card`;
  if ($('triggerTitle')) $('triggerTitle').textContent = 'ANÁLISE TÉCNICA';
  if ($('triggerValue')) $('triggerValue').textContent = guide.value;
  if ($('triggerHint')) $('triggerHint').textContent = guide.hint;
  if ($('technicalConfidence')) $('technicalConfidence').textContent = `${score}/100`;
  if ($('technicalConfidenceLabel')) $('technicalConfidenceLabel').textContent = 'SCORE';
  if ($('confidenceNote')) $('confidenceNote').textContent = 'Score técnico interno de 0 a 100; não representa garantia de resultado.';
}

async function readState() {
  const response = await chrome.runtime.sendMessage({ type: 'ATS_READ_SCANNER_STATE' }).catch(() => null);
  render(response?.state || {});
}

chrome.storage.onChanged.addListener(changes => {
  if (changes.scannerState) render(changes.scannerState.newValue || {});
});

readState().catch(() => render({}));
