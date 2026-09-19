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
  const signal = state.signal || {};
  const ui = clean(signal.uiState).toUpperCase();
  const direction = ui.includes('BUY') ? 'BUY' : ui.includes('SELL') ? 'SELL' : null;
  const side = direction === 'BUY' ? 'COMPRA' : direction === 'SELL' ? 'VENDA' : '';

  if (signal.directionTransition?.from && signal.directionTransition?.to) {
    const from = signal.directionTransition.from === 'BUY' ? 'COMPRA' : 'VENDA';
    const to = signal.directionTransition.to === 'BUY' ? 'COMPRA' : 'VENDA';
    return {
      tone: 'possible',
      value: `PADRÃO ${to}`,
      hint: `${from} → ${to}. A nova direção substituiu a anterior após confirmação forte e sustentada.`
    };
  }

  if (ui === 'ENTER_BUY' || ui === 'ENTER_SELL') {
    return {
      tone: direction === 'BUY' ? 'buy' : 'sell',
      value: `CONFIRMADO • ${side}`,
      hint: clean(signal.reason || 'Confirmação técnica concluída para a entrada.')
    };
  }

  if (ui === 'POSSIBLE_BUY' || ui === 'POSSIBLE_SELL') {
    return {
      tone: 'possible',
      value: `PADRÃO ${side}`,
      hint: clean(signal.reason || `Padrão ${side.toLowerCase()} mantido nesta vela; aguardando confirmação final perto de 10s.`)
    };
  }

  if (ui === 'BUILDING_PATTERN' || ui === 'ANALYZING_MARKET' || ui === 'DECIDING') {
    return {
      tone: 'waiting',
      value: 'ANALISANDO',
      hint: clean(signal.reason || 'Lendo preço, força, rejeição, momentum e estrutura.')
    };
  }

  return {
    tone: 'skip',
    value: 'SEM PADRÃO',
    hint: clean(signal.reason || 'Nenhum padrão técnico válido neste momento.')
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
