import { assessEntryConfidence } from '../core/entry-confidence.js';

const $ = id => document.getElementById(id);
const num = value => value == null || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null;

function fmt(value) {
  const n = num(value);
  if (n == null) return '—';
  const a = Math.abs(n);
  const digits = a >= 1000 ? 2 : a >= 100 ? 3 : a >= 1 ? 5 : 8;
  return n.toFixed(digits).replace(/0+$/, '').replace(/\.$/, '');
}

function guidance(state = {}) {
  const signal = state.signal || {};
  const waiting = signal.waitingFor || {};
  const ui = String(signal.uiState || '');
  const direction = ui.includes('BUY') || signal.analysisDirection === 'BUY' ? 'BUY'
    : ui.includes('SELL') || signal.analysisDirection === 'SELL' ? 'SELL' : null;
  const side = direction === 'BUY' ? 'COMPRA' : direction === 'SELL' ? 'VENDA' : 'ENTRADA';

  if (ui === 'ENTER_BUY' || ui === 'ENTER_SELL') {
    return { tone: direction === 'BUY' ? 'buy' : 'sell', title: 'GATILHO CONFIRMADO', value: `ENTRAR ${side}`, hint: 'Entrada manual na abertura da próxima vela. O sinal fica travado até a virada.' };
  }
  if (ui === 'SKIP') return { tone: 'skip', title: 'SEM GATILHO VÁLIDO', value: 'PULAR PRÓXIMA VELA', hint: 'A confirmação mínima não chegou dentro desta vela.' };
  if (!['POSSIBLE_BUY','POSSIBLE_SELL','DECIDING'].includes(ui)) {
    return { tone: 'waiting', title: 'PROCURANDO GATILHO', value: 'ANALISANDO', hint: 'Lendo estrutura, força, rompimento, rejeição e continuidade antes de antecipar a próxima vela.' };
  }

  if (waiting.type === 'breakout' && num(waiting.level) != null) {
    return {
      tone: 'possible', title: `GATILHO DE ${side}`,
      value: `${direction === 'BUY' ? 'ROMPER ACIMA DE' : 'ROMPER ABAIXO DE'} ${fmt(waiting.level)}`,
      hint: `Possível ${side.toLowerCase()}. Aguardando o preço atingir e confirmar esse nível antes da próxima vela.`
    };
  }
  if (waiting.type === 'rejection') return { tone: 'possible', title: `REJEIÇÃO PARA ${side}`, value: `${Math.round(Number(waiting.current || 0))}% / ${Math.round(Number(waiting.required || 0))}%`, hint: waiting.text || 'Aguardando rejeição suficiente no nível atual.' };
  if (waiting.type === 'power') return { tone: 'possible', title: `PODER ${direction === 'BUY' ? 'COMPRADOR' : 'VENDEDOR'}`, value: `${Math.round(Number(waiting.current || 0))}% / ${Math.round(Number(waiting.required || 0))}%`, hint: waiting.text || 'Aguardando força direcional suficiente.' };
  if (waiting.type === 'candle_strength') return { tone: 'possible', title: 'FORÇA DA VELA', value: `${Math.round(Number(waiting.current || 0))}% / ${Math.round(Number(waiting.required || 0))}%`, hint: waiting.text || 'Aguardando a vela atual ganhar força.' };
  if (waiting.type === 'continuation') return { tone: 'possible', title: `CONTINUAÇÃO ${side}`, value: `${Math.round(Number(waiting.current || 0))}% / ${Math.round(Number(waiting.required || 0))}%`, hint: waiting.text || 'Aguardando continuidade consistente.' };
  if (waiting.type === 'possible_score' || waiting.type === 'confirm_score') return { tone: 'possible', title: 'FORÇA DO PADRÃO', value: `${Math.round(Number(waiting.current || 0))}/100 → ${Math.round(Number(waiting.required || 0))}/100`, hint: waiting.text || 'Aguardando o padrão alcançar a confirmação.' };
  return { tone: 'possible', title: `POSSÍVEL ${side}`, value: 'AGUARDANDO CONFIRMAÇÃO', hint: waiting.text || 'Aguardando nova confirmação estável antes da próxima vela.' };
}

function render(state = {}) {
  const confidence = assessEntryConfidence(state);
  const guide = guidance(state);
  const card = $('triggerCard');
  if (card) card.className = `trigger-card ${guide.tone}`;
  if ($('triggerTitle')) $('triggerTitle').textContent = guide.title;
  if ($('triggerValue')) $('triggerValue').textContent = guide.value;
  if ($('triggerHint')) $('triggerHint').textContent = guide.hint;
  if ($('technicalConfidence')) $('technicalConfidence').textContent = `${confidence.score}/100`;
  if ($('technicalConfidenceLabel')) $('technicalConfidenceLabel').textContent = confidence.label;
  if ($('confidenceNote')) $('confidenceNote').textContent = confidence.calibratedProbability == null
    ? 'Confiança técnica interna; a taxa real é mostrada na validação abaixo.'
    : `Probabilidade calibrada: ${confidence.calibratedProbability}%`;
}

async function readState() {
  const response = await chrome.runtime.sendMessage({ type: 'ATS_READ_SCANNER_STATE' }).catch(() => null);
  render(response?.state || {});
}

chrome.storage.onChanged.addListener(changes => {
  if (changes.scannerState) render(changes.scannerState.newValue || {});
});

readState().catch(() => render({}));
