const $ = id => document.getElementById(id);
const badge = $('aiAuditBadge');
const title = $('aiAuditTitle');
const summary = $('aiAuditSummary');
const direction = $('aiAuditDirection');
const alignment = $('aiAuditAlignment');
const impact = $('aiAuditImpact');
const evidence = $('aiAuditEvidence');
const meta = $('aiAuditMeta');
const card = $('aiAuditCard');
const decisionCard = $('decisionCard');
const syncStrip = $('syncStrip');

// The next-candle decision is the primary action surface. Keep it at the top,
// immediately after synchronization status, and keep Gemini directly below it.
if (syncStrip && decisionCard) syncStrip.after(decisionCard);
if (decisionCard && card) decisionCard.after(card);

let topStatus = $('aiTopStatus');
if (!topStatus) {
  topStatus = document.createElement('span');
  topStatus.id = 'aiTopStatus';
  topStatus.className = 'badge';
  topStatus.textContent = 'IA EM ESPERA';
  const version = $('extensionVersion');
  if (version?.parentElement) version.before(topStatus);
}

const ui = {
  reinforce: { title: 'REFORÇA A LEITURA', badge: 'ALINHADA', cls: 'ok' },
  caution: { title: 'PEDE CAUTELA', badge: 'ATENÇÃO', cls: 'warn' },
  insufficient: { title: 'SEM CONVICÇÃO ADICIONAL', badge: 'NEUTRA', cls: 'warn' }
};

function setText(node, value) { if (node) node.textContent = value; }
function setTop(text, cls = '') {
  if (!topStatus) return;
  topStatus.textContent = text;
  topStatus.className = `badge ${cls}`.trim();
}
function pct(value) { const n = Number(value); return Number.isFinite(n) ? `${Math.max(0, Math.min(100, Math.round(n)))}/100` : '—'; }
function impactText(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n === 0) return '0 pts';
  return `${n > 0 ? '+' : ''}${Math.round(n)} pts`;
}

function resetEvidence(rows = []) {
  if (!evidence) return;
  evidence.replaceChildren();
  for (const row of rows.slice(0, 3)) {
    const li = document.createElement('li');
    li.textContent = String(row || '').slice(0, 160);
    evidence.appendChild(li);
  }
  evidence.hidden = evidence.childElementCount === 0;
}

function render(state = {}) {
  const ai = state.aiAudit || {};
  if (!card) return;
  card.classList.remove('loading', 'reinforce', 'caution', 'error');

  if (!ai.status) {
    setTop('IA EM ESPERA');
    setText(title, 'AGUARDANDO O SCANNER');
    setText(badge, 'EM ESPERA');
    if (badge) badge.className = 'badge';
    setText(summary, 'A Gemini entra como segunda leitura quando o scanner encontra um possível sinal para a próxima vela.');
    setText(direction, '—');
    setText(alignment, '—');
    setText(impact, '—');
    resetEvidence([]);
    setText(meta, 'Motor técnico principal ativo • IA ainda não acionada');
    return;
  }

  if (ai.status === 'loading') {
    card.classList.add('loading');
    setTop('IA ANALISANDO', 'warn');
    setText(title, 'GEMINI ANALISANDO');
    setText(badge, 'AO VIVO');
    if (badge) badge.className = 'badge warn';
    setText(summary, 'Comparando o mesmo ativo, as velas recentes, força, momentum, rejeição, continuidade e regime do motor técnico.');
    setText(direction, ai.scannerDirection || '—');
    setText(alignment, 'ANALISANDO');
    setText(impact, '—');
    resetEvidence([]);
    setText(meta, 'Segunda leitura independente • sem alterar o sinal enquanto processa');
    return;
  }

  if (ai.status === 'error') {
    card.classList.add('error');
    setTop('IA FALLBACK', 'warn');
    setText(title, 'IA TEMPORARIAMENTE INDISPONÍVEL');
    setText(badge, 'FALLBACK');
    if (badge) badge.className = 'badge warn';
    setText(summary, 'O motor técnico continua funcionando normalmente. A camada Gemini não bloqueia nem inventa sinal quando a API falha.');
    setText(direction, ai.scannerDirection || '—');
    setText(alignment, '—');
    setText(impact, '0 pts');
    resetEvidence([]);
    setText(meta, `Erro: ${String(ai.error || 'ai_analysis_failed').slice(0, 60)}`);
    return;
  }

  const preset = ui[ai.verdict] || ui.insufficient;
  card.classList.add(ai.verdict === 'reinforce' ? 'reinforce' : ai.verdict === 'caution' ? 'caution' : 'loading');
  setTop(ai.verdict === 'reinforce' ? 'IA ALINHADA' : ai.verdict === 'caution' ? 'IA CAUTELA' : 'IA NEUTRA', preset.cls);
  setText(title, preset.title);
  setText(badge, preset.badge);
  if (badge) badge.className = `badge ${preset.cls}`;
  setText(summary, ai.summary || 'Sem observação adicional.');
  setText(direction, ai.direction || 'WAIT');
  setText(alignment, ai.alignment === 'aligned' ? 'ALINHADA' : ai.alignment === 'conflict' ? 'DIVERGE' : 'NEUTRA');
  setText(impact, impactText(ai.confidenceAdjustment));
  resetEvidence([...(Array.isArray(ai.evidence) ? ai.evidence : []), ...(Array.isArray(ai.risks) ? ai.risks.map(x => `Risco: ${x}`) : [])]);
  const model = ai.model || 'Gemini';
  const latency = Number(ai.latencyMs);
  setText(meta, `${model} • confiança IA ${pct(ai.modelConfidence)}${Number.isFinite(latency) ? ` • ${latency} ms` : ''}`);
}

chrome.storage?.local?.get?.('scannerState', stored => render(stored?.scannerState || {}));
chrome.storage?.onChanged?.addListener?.((changes, area) => {
  if (area === 'local' && changes.scannerState) render(changes.scannerState.newValue || {});
});
