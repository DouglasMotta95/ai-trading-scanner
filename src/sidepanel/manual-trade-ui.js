const $ = id => document.getElementById(id);
const num = value => value == null || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null;
const price = value => num(value) == null ? '—' : String(value);

function render(data = {}) {
  const metrics = data.metrics || {};
  const last = metrics.last || (Array.isArray(data.rows) ? data.rows.at(-1) : null);
  const card = $('manualTradeCard');
  if (!card) return;

  if (!last) {
    card.className = 'card manual-trade-card waiting';
    if ($('manualTradeBadge')) { $('manualTradeBadge').textContent = 'AGUARDANDO CLIQUE'; $('manualTradeBadge').className = 'badge warn'; }
    if ($('manualTradeTitle')) $('manualTradeTitle').textContent = 'Nenhuma operação registrada';
    if ($('manualTradeDirection')) $('manualTradeDirection').textContent = '—';
    if ($('manualTradeEntry')) $('manualTradeEntry').textContent = '—';
    if ($('manualTradeExit')) $('manualTradeExit').textContent = '—';
    if ($('manualTradeResult')) $('manualTradeResult').textContent = '—';
    if ($('manualTradeMatch')) $('manualTradeMatch').textContent = '—';
    if ($('manualTradeNote')) $('manualTradeNote').textContent = 'Quando você clicar em COMPRA ou VENDA na CasaTrade, a extensão registra a cotação e acompanha o fechamento.';
    return;
  }

  const result = String(last.result || last.status || 'PENDING').toUpperCase();
  const tone = result === 'WIN' ? 'win' : result === 'LOSS' ? 'loss' : result === 'DRAW' ? 'draw' : 'pending';
  card.className = `card manual-trade-card ${tone}`;
  if ($('manualTradeBadge')) {
    $('manualTradeBadge').textContent = result === 'PENDING' ? 'EM ABERTO' : result === 'UNVERIFIED_ENTRY' ? 'NÃO CONFIRMADA' : result;
    $('manualTradeBadge').className = `badge ${result === 'WIN' ? 'ok' : result === 'LOSS' ? 'bad' : 'warn'}`;
  }
  if ($('manualTradeTitle')) $('manualTradeTitle').textContent = `${last.direction === 'BUY' ? 'COMPRA' : 'VENDA'} • ${last.asset || '—'} • ${last.timeframe || '—'}`;
  if ($('manualTradeDirection')) $('manualTradeDirection').textContent = last.direction === 'BUY' ? 'COMPRA' : 'VENDA';
  if ($('manualTradeEntry')) $('manualTradeEntry').textContent = price(last.entryPrice);
  if ($('manualTradeExit')) $('manualTradeExit').textContent = price(last.exitPrice);
  if ($('manualTradeResult')) $('manualTradeResult').textContent = result === 'PENDING' ? 'AGUARDANDO EXPIRAÇÃO' : result;
  if ($('manualTradeMatch')) $('manualTradeMatch').textContent = last.matchedSignal ? 'SINAL + TIMING OK' : 'MANUAL / FORA DO TIMING';
  if ($('manualTradeNote')) {
    const source = last.resultSource === 'target_candle_close' ? 'resultado inferido pelo fechamento exato da vela-alvo' : 'aguardando fechamento';
    $('manualTradeNote').textContent = last.matchedSignal
      ? `Operação vinculada ao sinal do scanner; ${source}.`
      : `Clique registrado, mas fora da janela/direção do sinal confirmado; não entra na taxa de acerto do scanner.`;
  }

  if ($('manualTradeStats')) {
    const rate = metrics.winRate == null ? '—' : `${metrics.winRate}%`;
    $('manualTradeStats').textContent = `${metrics.matchedSignals || 0} executadas no sinal • ${metrics.wins || 0}W/${metrics.losses || 0}L • ${rate}`;
  }
}

async function refresh() {
  const response = await chrome.runtime.sendMessage({ type: 'ATS_GET_MANUAL_TRADE_LEDGER' }).catch(() => null);
  if (response?.ok) render(response);
}

chrome.storage.onChanged.addListener(changes => {
  const value = changes.atsManualTradeLedgerV1?.newValue;
  if (value) render(value);
});

refresh().catch(() => {});
setInterval(() => refresh().catch(() => {}), 4000);
