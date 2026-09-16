import { assessEntryConfidence } from '../core/entry-confidence.js';

const $ = id => document.getElementById(id);
const num = value => value == null || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null;
const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();

function fmt(value) {
  const n = num(value);
  if (n == null) return '—';
  const a = Math.abs(n);
  const digits = a >= 1000 ? 2 : a >= 100 ? 3 : a >= 1 ? 5 : 8;
  return n.toFixed(digits).replace(/0+$/, '').replace(/\.$/, '');
}

function guidance(state = {}) {
  const technical = state.signal || {};
  const decision = state.professionalDecision || {};
  const ui = clean(decision.uiState).toUpperCase();
  const direction = clean(decision.direction).toUpperCase();
  const side = direction === 'BUY' ? 'COMPRA' : direction === 'SELL' ? 'VENDA' : 'ENTRADA';
  const timeReady = decision.timeReady === true && decision.expirationReady === true;

  if (!timeReady) {
    return {
      tone: 'skip',
      title: 'TEMPO CASATRADE',
      value: 'AGUARDAR',
      hint: clean(decision.reason || 'Countdown, timeframe ou expiração real ainda não foram confirmados.')
    };
  }

  if (ui === 'ENTER_BUY' || ui === 'ENTER_SELL') {
    return {
      tone: direction === 'BUY' ? 'buy' : 'sell',
      title: 'GATILHO CONFIRMADO',
      value: `ENTRAR ${side}`,
      hint: `${clean(decision.reason || 'Confluência mantida durante o hold.')} Entrada manual somente na próxima vela.`
    };
  }

  if (ui === 'POSSIBLE_BUY' || ui === 'POSSIBLE_SELL') {
    const remaining = Math.ceil(Math.max(0, Number(decision.holdRemainingMs || 0)) / 1000);
    const suffix = remaining > 0 ? ` • hold ${remaining}s` : '';
    return {
      tone: 'possible',
      title: `POSSÍVEL ${side}`,
      value: `PRÓXIMA VELA${suffix}`,
      hint: clean(decision.reason || 'Padrão encontrado; aguardando estabilidade antes de confirmar.')
    };
  }

  if (ui === 'BUILDING_PATTERN') {
    return {
      tone: 'waiting',
      title: 'MONTANDO PADRÃO',
      value: 'PRÓXIMA VELA',
      hint: clean(decision.reason || 'Lendo força, rejeição, continuidade, momentum e estrutura.')
    };
  }

  if (ui === 'ANALYZING_MARKET') {
    return {
      tone: 'waiting',
      title: 'ANALISANDO MERCADO',
      value: 'AGUARDAR',
      hint: clean(decision.reason || 'Confirmando o mercado atual antes de procurar um setup.')
    };
  }

  const waiting = technical.waitingFor || {};
  if (waiting.type === 'breakout' && num(waiting.level) != null) {
    return { tone: 'skip', title: 'AGUARDAR', value: `NÍVEL ${fmt(waiting.level)}`, hint: clean(decision.reason || waiting.text || 'Rompimento ainda não confirmou.') };
  }
  return { tone: 'skip', title: 'AGUARDAR', value: 'SEM ENTRADA', hint: clean(decision.reason || 'Padrão sem qualidade suficiente.') };
}

function render(state = {}) {
  const technicalConfidence = assessEntryConfidence(state);
  const decision = state.professionalDecision || {};
  const score = Number.isFinite(Number(decision.score)) ? Math.round(Number(decision.score)) : technicalConfidence.score;
  const guide = guidance(state);
  const card = $('triggerCard');
  if (card) card.className = `trigger-card ${guide.tone}`;
  if ($('triggerTitle')) $('triggerTitle').textContent = guide.title;
  if ($('triggerValue')) $('triggerValue').textContent = guide.value;
  if ($('triggerHint')) $('triggerHint').textContent = guide.hint;
  if ($('technicalConfidence')) $('technicalConfidence').textContent = `${Math.max(0, Math.min(100, score || 0))}/100`;
  if ($('technicalConfidenceLabel')) $('technicalConfidenceLabel').textContent = decision.uiState?.startsWith('ENTER_') ? 'CONFIRMADO' : decision.uiState?.startsWith('POSSIBLE_') ? 'EM HOLD' : technicalConfidence.label;
  if ($('confidenceNote')) $('confidenceNote').textContent = 'Força técnica interna; não representa garantia de resultado.';
}

async function readState() {
  const response = await chrome.runtime.sendMessage({ type: 'ATS_READ_SCANNER_STATE' }).catch(() => null);
  render(response?.state || {});
}

chrome.storage.onChanged.addListener(changes => {
  if (changes.scannerState) render(changes.scannerState.newValue || {});
});

readState().catch(() => render({}));
