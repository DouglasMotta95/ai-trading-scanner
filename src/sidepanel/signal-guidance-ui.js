import { assessEntryConfidence } from '../core/entry-confidence.js';

const $ = id => document.getElementById(id);
const num = value => value == null || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null;
const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();

function technicalDirection(state = {}) {
  const signal = state.signal || {};
  const ui = clean(signal.uiState).toUpperCase();
  if (ui.includes('BUY')) return 'BUY';
  if (ui.includes('SELL')) return 'SELL';
  const direction = clean(signal.direction || signal.analysisDirection).toUpperCase();
  return ['BUY','SELL'].includes(direction) ? direction : null;
}

function guidance(state = {}) {
  const technical = state.signal || {};
  const decision = state.professionalDecision || {};
  const professionalUi = clean(decision.uiState).toUpperCase();
  const technicalUi = clean(technical.uiState).toUpperCase();
  const direction = technicalDirection(state);
  const side = direction === 'BUY' ? 'COMPRA' : direction === 'SELL' ? 'VENDA' : '';
  const entryReady = decision.actionable === true;

  if (technical.directionTransition?.from && technical.directionTransition?.to) {
    const from = technical.directionTransition.from === 'BUY' ? 'COMPRA' : 'VENDA';
    const to = technical.directionTransition.to === 'BUY' ? 'COMPRA' : 'VENDA';
    return {
      tone: 'waiting',
      value: 'PADRÃO MUDANDO — REAVALIANDO',
      hint: `${from} → ${to}. A nova direção precisa se sustentar antes de substituir o padrão atual.`
    };
  }

  if ((professionalUi === 'ENTER_BUY' || professionalUi === 'ENTER_SELL') && entryReady) {
    return {
      tone: direction === 'BUY' ? 'buy' : 'sell',
      value: `CONFIRMADO • ${side}`,
      hint: clean(decision.reason || 'Confirmação técnica concluída. Entrada manual somente na próxima vela.')
    };
  }

  if (professionalUi === 'POSSIBLE_BUY' || professionalUi === 'POSSIBLE_SELL') {
    const remaining = Math.ceil(Math.max(0, Number(decision.holdRemainingMs || 0)) / 1000);
    return {
      tone: 'possible',
      value: `PADRÃO ${side || 'EM OBSERVAÇÃO'}`,
      hint: `${clean(decision.reason || 'Padrão técnico em confirmação.')}${remaining > 0 ? ` Hold: ${remaining}s.` : ''}`
    };
  }

  // Keep showing the primary technical engine even when the user-facing funnel
  // is blocked by clock/timeframe/expiration. This is analysis, not authorization.
  if (direction && ['POSSIBLE_BUY','POSSIBLE_SELL','ENTER_BUY','ENTER_SELL','DECIDING'].includes(technicalUi)) {
    return {
      tone: 'possible',
      value: `PADRÃO ${side}`,
      hint: clean(technical.reason || 'Padrão técnico detectado; aguardando a confirmação final perto de 10s.')
    };
  }

  if (technicalUi === 'BUILDING_PATTERN' || technicalUi === 'ANALYZING_MARKET') {
    return {
      tone: 'waiting',
      value: 'ANALISANDO',
      hint: clean(technical.reason || 'Lendo preço, força, rejeição, momentum e estrutura.')
    };
  }

  return {
    tone: 'skip',
    value: 'SEM PADRÃO',
    hint: clean(technical.reason || block || 'Nenhum padrão técnico válido neste momento.')
  };
}

function render(state = {}) {
  const technicalConfidence = assessEntryConfidence(state);
  const decision = state.professionalDecision || {};
  const technical = state.signal || {};
  const scoreRaw = decision.score ?? technical.analysisScore ?? technical.score ?? technicalConfidence.score;
  const score = Math.max(0, Math.min(100, Math.round(Number(scoreRaw) || 0)));
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
