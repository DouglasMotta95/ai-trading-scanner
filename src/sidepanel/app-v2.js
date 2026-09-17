const $ = id => document.getElementById(id);
const clean = v => String(v ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
const num = v => v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null;
const fmt = v => {
  const n = num(v);
  if (n == null) return '—';
  const d = Math.abs(n) >= 100 ? 3 : Math.abs(n) >= 1 ? 5 : 8;
  return n.toFixed(d).replace(/0+$/, '').replace(/\.$/, '');
};
const activeAccess = s => ['active', 'valid'].includes(String(s?.license?.status || '').toLowerCase())
  || s?.license?.devMode === true
  || s?.license?.plan === 'OWNER_DEV';
const exactClock = s => {
  const c = s?.diagnostics?.marketClock || {};
  return c.verified === true
    && c.available !== false
    && c.role === 'candle-close'
    && c.source === 'casatrade-platform-clock'
    && Date.now() - Number(c.at || 0) < 3500;
};

function signalModel(state = {}) {
  const sig = state.signal || {};
  const ui = String(sig.uiState || '').toUpperCase();
  const score = Number(sig.analysisScore ?? sig.score ?? 0) || 0;
  if (!activeAccess(state)) return { tone: 'wait', phase: 'ACESSO', title: 'AGUARDANDO ACESSO', reason: 'A extensão ainda não está liberada.', score };
  if (!state.asset || num(state.price) == null) return { tone: 'wait', phase: 'CAPTURA', title: 'LENDO GRÁFICO', reason: state.diagnostics?.acquisition?.reason || 'Identificando o ativo e a cotação atual.', score };
  if ((state.candles || []).length < 3) return { tone: 'wait', phase: 'OHLC', title: 'COLETANDO VELAS', reason: state.diagnostics?.acquisition?.reason || 'Montando histórico OHLC numérico.', score };
  if (!exactClock(state)) return { tone: 'wait', phase: 'RELÓGIO', title: 'SINCRONIZANDO VELA', reason: state.diagnostics?.acquisition?.reason || 'Ancorando o fechamento real da vela M1.', score };
  if (ui === 'ENTER_BUY') return { tone: 'buy', phase: 'DECISÃO FINAL', title: 'COMPRAR NA PRÓXIMA VELA', reason: clean(sig.reason), score };
  if (ui === 'ENTER_SELL') return { tone: 'sell', phase: 'DECISÃO FINAL', title: 'VENDER NA PRÓXIMA VELA', reason: clean(sig.reason), score };
  if (ui === 'POSSIBLE_BUY') return { tone: 'possible', phase: 'PREPARAÇÃO', title: 'POSSÍVEL COMPRA', reason: clean(sig.reason), score };
  if (ui === 'POSSIBLE_SELL') return { tone: 'possible', phase: 'PREPARAÇÃO', title: 'POSSÍVEL VENDA', reason: clean(sig.reason), score };
  if (ui === 'NO_ENTRY') return { tone: 'skip', phase: 'DECISÃO FINAL', title: 'SEM ENTRADA NESTA VELA', reason: clean(sig.reason), score };
  return { tone: 'wait', phase: 'ANÁLISE', title: 'ANALISANDO PADRÃO', reason: clean(sig.reason || state.diagnostics?.acquisition?.reason || 'Lendo as últimas velas e a vela atual.'), score };
}

function connectionModel(state = {}) {
  const stage = String(state.diagnostics?.acquisition?.stage || '');
  if (['injection_failed', 'page_world_timeout', 'asset_timeout', 'ohlc_timeout', 'clock_timeout'].includes(stage)) return { text: 'ERRO DE CAPTURA', tone: 'bad' };
  if (exactClock(state) && state.connection === 'online') return { text: 'AO VIVO', tone: 'ok' };
  return { text: 'SINCRONIZANDO', tone: 'wait' };
}

function render(state = {}) {
  const c = state.diagnostics?.marketClock || {};
  const model = signalModel(state);
  const connection = connectionModel(state);
  const remaining = num(c.secondsRemaining);

  $('asset').textContent = state.asset || '—';
  $('price').textContent = fmt(state.price);
  $('timeframe').textContent = state.analysisTimeframe || state.timeframe || 'M1';
  $('countdown').textContent = remaining == null ? '—' : `${Math.max(0, Math.ceil(remaining))}s`;
  $('status').textContent = connection.text;
  $('status').className = `pill ${connection.tone}`;
  $('decision').className = `decision ${model.tone}`;
  $('phase').textContent = model.phase;
  $('signal').textContent = model.title;
  $('reason').textContent = model.reason || state.diagnostics?.acquisition?.reason || '—';
  $('score').textContent = `${Math.round(model.score)}/100`;
  $('ohlcCount').textContent = `${Array.isArray(state.candles) ? state.candles.length : 0} velas`;
  $('clockStatus').textContent = exactClock(state) ? 'EXATO • CASATRADE' : 'AGUARDANDO';
  $('expiration').textContent = state.platformControls?.observed?.expiration || state.targetExpiration || state.expiration || '—';
  $('phase30').classList.toggle('active', remaining != null && remaining <= 30 && remaining > 10);
  $('phase10').classList.toggle('active', remaining != null && remaining <= 10);
  window.__ATS_LAST_STATE__ = state;
}

function renderTrade(data = {}) {
  const m = data.metrics || {};
  const last = m.last || (Array.isArray(data.rows) ? data.rows.at(-1) : null);
  $('tradeScore').textContent = `${m.wins || 0}W / ${m.losses || 0}L`;
  if (!last) {
    $('tradeTitle').textContent = 'Nenhuma entrada registrada';
    $('tradeResult').textContent = '—';
    $('tradeResult').className = 'pill neutral';
    return;
  }
  $('tradeTitle').textContent = `${last.direction === 'BUY' ? 'COMPRA' : 'VENDA'} • ${last.asset || '—'}`;
  $('tradeEntry').textContent = fmt(last.entryPrice);
  $('tradeExit').textContent = fmt(last.exitPrice);
  const r = String(last.result || last.status || 'PENDING').toUpperCase();
  $('tradeResult').textContent = r === 'WIN' ? 'GREEN / WIN' : r === 'LOSS' ? 'LOSS' : r === 'DRAW' ? 'EMPATE' : 'EM ABERTO';
  $('tradeResult').className = `pill ${r === 'WIN' ? 'ok' : r === 'LOSS' ? 'bad' : 'wait'}`;
  $('tradeNote').textContent = last.matchedSignal
    ? 'Operação vinculada ao sinal; resultado calculado pelo fechamento da vela-alvo.'
    : 'Clique registrado fora do timing/direção do sinal; não entra no placar do scanner.';
}

async function read() {
  const r = await chrome.runtime.sendMessage({ type: 'ATS_READ_SCANNER_STATE' }).catch(() => null);
  if (r?.state) render(r.state);
  const t = await chrome.runtime.sendMessage({ type: 'ATS_GET_SNIPER_LEDGER' }).catch(() => null);
  if (t?.ok) renderTrade(t);
}

$('connect')?.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'ATS_CONNECT_ACTIVE_TAB' }).catch(() => null);
  await chrome.runtime.sendMessage({ type: 'ATS_SET_SCANNER', enabled: true }).catch(() => null);
  read();
});

$('copyDiagnostic')?.addEventListener('click', async () => {
  const s = window.__ATS_LAST_STATE__ || {};
  const c = s.diagnostics?.marketClock || {};
  const out = {
    generatedAt: new Date().toISOString(),
    extensionVersion: chrome.runtime.getManifest().version,
    access: {
      ownerDev: s.license?.plan === 'OWNER_DEV',
      licensed: activeAccess(s),
      status: s.license?.status || ''
    },
    connection: s.connection || '',
    acquisition: s.diagnostics?.acquisition || null,
    runtimeInjection: s.diagnostics?.runtimeInjection || null,
    runtimeBoot: s.diagnostics?.runtimeBoot || null,
    asset: s.asset || '',
    price: s.price ?? null,
    timeframe: s.analysisTimeframe || s.timeframe || '',
    candlesAvailable: Array.isArray(s.candles) ? s.candles.length : 0,
    clock: {
      source: c.source || '',
      verified: c.verified === true,
      secondsRemaining: c.secondsRemaining ?? null,
      closeAt: c.closeAt ?? null,
      sourceNow: c.sourceNow ?? null,
      ageMs: c.at ? Date.now() - Number(c.at) : null
    },
    platformControls: s.platformControls?.observed || {},
    feedGate: s.diagnostics?.confirmationFeedGate || null,
    signal: {
      uiState: s.signal?.uiState || '',
      direction: s.signal?.direction || '',
      score: s.signal?.analysisScore ?? s.signal?.score ?? null,
      reason: s.signal?.reason || ''
    },
    aiAudit: s.aiAudit || null,
    session: s.diagnostics?.marketSession || null
  };
  await navigator.clipboard.writeText(`AI Trading Scanner — diagnóstico Sniper\n${JSON.stringify(out, null, 2)}`).catch(() => {});
  $('copyDiagnostic').textContent = 'COPIADO';
  setTimeout(() => $('copyDiagnostic').textContent = 'COPIAR DIAGNÓSTICO', 1200);
});

chrome.storage.onChanged.addListener(changes => {
  if (changes.scannerState?.newValue) render(changes.scannerState.newValue);
  if (changes.atsSniperTradeLedgerV1?.newValue) renderTrade(changes.atsSniperTradeLedgerV1.newValue);
});

$('version').textContent = `v${chrome.runtime.getManifest().version} • sniper 30/10`;
read();
setTimeout(function poll() {
  read();
  setTimeout(poll, 2500);
}, 2500);
