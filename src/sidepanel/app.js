const LAST_VALID_LICENSE_KEY = 'atsLastValidLicense';
const $ = id => document.getElementById(id);
let lastState = {};
let reconnectBusy = false;

if ($('extensionVersion')) $('extensionVersion').textContent = `v${chrome.runtime.getManifest().version}`;

const num = v => v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null;
const fresh = s => licenseStillValid(s?.license) && s.connection === 'online' && !!s.asset && num(s.price) != null && s.lastSeen && Date.now() - Number(s.lastSeen) < 8000;
const priceText = v => num(v) == null ? '—' : String(v);

function expiryMs(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number' || /^\d+(?:\.\d+)?$/.test(String(value).trim())) {
    let n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return null;
    if (n < 1e12) n *= 1000;
    return n;
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

const licenseStillValid = l => {
  const status = String(l?.status || '').toLowerCase();
  if (status !== 'active' && status !== 'valid') return false;
  if (!l.expiresAt) return true;
  const t = expiryMs(l.expiresAt);
  return t != null && t > Date.now();
};

const effectiveLicense = (stateLicense = {}, cachedEntry = null) => {
  if (licenseStillValid(stateLicense)) return { ...stateLicense, status: 'active' };
  if (['expired', 'limit', 'device_locked'].includes(String(stateLicense?.status || ''))) return stateLicense;
  const cached = cachedEntry?.license;
  if (licenseStillValid(cached)) return { ...cached, status: 'active', error: null, syncPending: false };
  return stateLicense;
};

const licenseErrorText = error => ({
  license_required: 'Digite sua chave ATS para ativar.',
  license_not_found: 'Chave não encontrada. Confira e tente novamente.',
  license_inactive: 'Essa chave está inativa.',
  license_expired: 'Essa chave está expirada.',
  device_limit_reached: 'Essa chave atingiu o limite de dispositivos.',
  backend_unreachable: 'Não foi possível falar com o servidor de licenças. A chave não foi ativada.'
}[String(error || '')] || 'Não foi possível ativar a chave. Ela foi mantida no campo para você conferir.');

function marketStep(s = {}) {
  const acquisition = s.diagnostics?.acquisition || {};
  const signal = s.signal || {};
  const candleCount = Math.max(0, Number(signal.candleCount ?? acquisition.candleCount ?? s.candles?.length ?? 0));
  if (!licenseStillValid(s.license)) return { stage: 'blocked', reason: 'Ative a licença para conectar à CasaTrade.', candleCount };
  if (!s.platformId) return { stage: 'connecting', reason: acquisition.reason || 'Conectando à aba da CasaTrade.', candleCount };
  if (!s.asset) return { stage: 'confirming_asset', reason: acquisition.reason || 'Confirmando o ativo aberto na CasaTrade.', candleCount };
  if (num(s.price) == null) return { stage: 'reading_price', reason: acquisition.reason || 'Ativo encontrado. Aguardando uma cotação real.', candleCount };
  if (s.connection !== 'online') return { stage: acquisition.stage || 'connecting', reason: acquisition.reason || 'Ativo e cotação detectados; concluindo sincronização.', candleCount };
  if (!s.lastSeen || Date.now() - Number(s.lastSeen) >= 8000) return { stage: 'reading_price', reason: 'A última cotação ficou desatualizada. Aguardando nova leitura real.', candleCount };
  if (candleCount < 3 || signal.state === 'SEARCHING' || signal.phase === 'HISTORY') {
    return { stage: 'reading_history', reason: acquisition.reason || `Lendo histórico de velas (${candleCount}/3).`, candleCount };
  }
  if (!signal.currentCandle && !s.currentCandle) return { stage: 'analyzing_current', reason: 'Histórico mínimo pronto. Montando a vela atual.', candleCount };
  return { stage: 'diagnosing_next_candle', reason: acquisition.reason || signal.reason || 'Analisando a vela atual para diagnosticar a próxima vela.', candleCount };
}

const stepTitle = step => ({
  blocked: 'Ative a licença para conectar',
  connecting: 'Conectando à CasaTrade…',
  confirming_asset: 'Confirmando ativo aberto…',
  reading_price: 'Lendo preço real…',
  reading_history: `Lendo histórico de velas (${step.candleCount}/3)`,
  analyzing_current: 'Analisando vela atual',
  diagnosing_next_candle: 'Diagnóstico da próxima vela'
}[step.stage] || 'Conectando à CasaTrade…');

function renderLicense(s = {}) {
  const l = s.license || {};
  const active = licenseStillValid(l);
  $('licenseCard')?.classList.toggle('active', active);
  if ($('activationBox')) $('activationBox').hidden = active;
  if ($('licenseHealth')) {
    $('licenseHealth').textContent = active ? 'ATIVA' : String(l.status || 'INATIVA').toUpperCase();
    $('licenseHealth').className = `badge ${active ? 'ok' : l.status === 'expired' || l.status === 'device_locked' ? 'bad' : ''}`;
  }
  if ($('licenseTitle')) $('licenseTitle').textContent = active ? 'Licença ativa' : l.status === 'expired' ? 'Licença expirada' : 'Ativação necessária';
  if ($('licenseText')) {
    const expiry = expiryMs(l.expiresAt);
    $('licenseText').textContent = active
      ? `${l.planLabel || l.plan || 'Plano'} ativo${expiry ? ` • vence ${new Date(expiry).toLocaleDateString('pt-BR')}` : ''}.`
      : l.error
        ? licenseErrorText(l.error)
        : 'Ative sua licença para usar o scanner. O mercado só conecta depois da ativação.';
  }
}

function renderRecentCandles(s = {}) {
  const box = $('recentCandles');
  if (!box) return;
  const rows = (Array.isArray(s.candles) ? s.candles : []).filter(c => [c?.open, c?.high, c?.low, c?.close].every(v => num(v) != null)).slice(-10);
  if ($('recentCandleCount')) $('recentCandleCount').textContent = `${rows.length}/10`;
  box.replaceChildren();

  for (let i = 0; i < 10; i++) {
    const candle = rows[i - (10 - rows.length)];
    const slot = document.createElement('div');
    slot.className = 'mini-candle-slot';
    if (!candle) {
      slot.classList.add('empty');
      box.appendChild(slot);
      continue;
    }

    const open = Number(candle.open), high = Number(candle.high), low = Number(candle.low), close = Number(candle.close);
    const range = Math.max(1e-12, high - low);
    const top = ((high - Math.max(open, close)) / range) * 100;
    const body = Math.max(10, (Math.abs(close - open) / range) * 100);
    const dir = close > open ? 'buy' : close < open ? 'sell' : 'doji';
    slot.classList.add(dir);
    slot.title = `${dir === 'buy' ? 'Alta' : dir === 'sell' ? 'Baixa' : 'Neutra'} • ${open} → ${close}`;

    const wick = document.createElement('i');
    wick.className = 'mini-wick';
    const bodyEl = document.createElement('b');
    bodyEl.className = 'mini-body';
    bodyEl.style.top = `${Math.max(0, Math.min(88, top))}%`;
    bodyEl.style.height = `${Math.max(10, Math.min(90, body))}%`;
    slot.append(wick, bodyEl);
    box.appendChild(slot);
  }
}

function renderAnalysis(s = {}) {
  const active = licenseStillValid(s.license);
  const online = active && fresh(s) && s.platformId === 'casatrade';
  const sig = online ? (s.signal || {}) : (s.signal || {});
  const current = online ? (sig.currentCandle || s.currentCandle || {}) : {};
  const step = marketStep(s);

  if ($('connectionBadge')) {
    const connected = active && s.connection === 'online' && !!s.asset && num(s.price) != null;
    $('connectionBadge').textContent = !active ? 'BLOQUEADO' : connected ? 'CONECTADO' : step.stage === 'reading_price' ? 'AGUARDANDO PREÇO' : 'CONECTANDO';
    $('connectionBadge').className = `badge ${connected ? 'ok' : 'warn'}`;
  }

  if ($('analysisTitle')) $('analysisTitle').textContent = stepTitle(step);

  if ($('asset')) $('asset').textContent = active && s.asset ? s.asset : '—';
  if ($('price')) $('price').textContent = online && s.price != null ? String(s.price) : '—';
  if ($('secondsRemaining')) $('secondsRemaining').textContent = online && num(sig.secondsRemaining) != null ? String(Math.max(0, Math.ceil(Number(sig.secondsRemaining)))) : '—';
  if ($('timeframe')) $('timeframe').textContent = online ? (s.analysisTimeframe || sig.timeframe || s.timeframe || 'M1') : '—';
  if ($('expiration')) $('expiration').textContent = online ? (s.targetExpiration || sig.targetExpiration || s.expiration || '—') : '—';
  if ($('candleProgress')) $('candleProgress').style.width = `${online && num(sig.progress) != null ? Math.max(0, Math.min(100, Number(sig.progress))) : 0}%`;

  if ($('analysisReason')) {
    $('analysisReason').textContent = !active
      ? 'Nenhum dado de mercado é analisado antes da licença ficar ATIVA.'
      : online
        ? (sig.reason || step.reason || 'Analisando a vela atual para a próxima vela.')
        : step.reason;
  }

  if ($('currentOpen')) $('currentOpen').textContent = priceText(current.open);
  if ($('currentHigh')) $('currentHigh').textContent = priceText(current.high);
  if ($('currentLow')) $('currentLow').textContent = priceText(current.low);
  if ($('currentClose')) $('currentClose').textContent = priceText(current.close);
  renderRecentCandles(active && Array.isArray(s.candles) ? s : { candles: [] });
}

function renderTradeActions(s = {}, online = false) {
  const sig = online ? (s.signal || {}) : {};
  const confirmed = sig.state === 'CONFIRM' && sig.provisional === false && ['BUY', 'SELL'].includes(sig.direction);
  const possible = sig.state === 'WATCH' && ['BUY', 'SELL'].includes(sig.direction);
  const buy = $('prepareBuy');
  const sell = $('prepareSell');

  if (buy) {
    buy.disabled = !(confirmed && sig.direction === 'BUY');
    buy.className = `trade-choice buy-choice${sig.direction === 'BUY' && (confirmed || possible) ? ' selected' : ''}${possible && sig.direction === 'BUY' ? ' possible' : ''}`;
  }
  if (sell) {
    sell.disabled = !(confirmed && sig.direction === 'SELL');
    sell.className = `trade-choice sell-choice${sig.direction === 'SELL' && (confirmed || possible) ? ' selected' : ''}${possible && sig.direction === 'SELL' ? ' possible' : ''}`;
  }

  if ($('tradeActionStatus')) {
    $('tradeActionStatus').textContent = confirmed
      ? `Confirmação forte: ${sig.direction === 'BUY' ? 'COMPRA' : 'VENDA'} indicada para a próxima vela; confirme manualmente na CasaTrade.`
      : possible
        ? `Diagnóstico pendendo para ${sig.direction === 'BUY' ? 'COMPRA' : 'VENDA'}, mas ainda é pré-sinal. Aguarde a confirmação.`
        : 'Entrada bloqueada enquanto o diagnóstico não atingir a confirmação mínima.';
  }
}

function decisionTime(value) {
  const t = Number(value);
  if (!Number.isFinite(t) || t <= 0) return '';
  return new Date(t).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function renderSeparatedSignalState(s = {}, online = false) {
  const sig = online ? (s.signal || {}) : {};
  const last = online ? (s.lastConfirmed || null) : null;
  const step = marketStep(s);

  if ($('lastConfirmed')) {
    if (!last) {
      $('lastConfirmed').textContent = 'Nenhuma decisão finalizada nesta sessão.';
    } else {
      const result = last.state === 'CONFIRM'
        ? (last.direction === 'SELL' ? 'VENDA' : 'COMPRA')
        : 'SEM ENTRADA';
      const at = decisionTime(last.time || last.targetStart);
      $('lastConfirmed').textContent = `${result}${at ? ` • ${at}` : ''}${num(last.score) != null ? ` • ${Math.round(Number(last.score))}/100` : ''}`;
    }
  }

  if (!$('analyzingNow')) return;
  if (!online) {
    $('analyzingNow').textContent = step.reason;
    return;
  }

  const count = Math.max(0, Number(sig.candleCount || 0));
  const required = Math.max(1, Number(sig.warmup?.required || 3));
  const windowCount = Math.min(10, count);
  const liveDirection = ['BUY', 'SELL'].includes(sig.analysisDirection)
    ? sig.analysisDirection
    : ['BUY', 'SELL'].includes(sig.direction) ? sig.direction : null;
  const liveScore = num(sig.analysisScore) != null ? Number(sig.analysisScore) : num(sig.score);
  const scoreText = liveScore != null ? ` • ${Math.round(liveScore)}/100` : '';

  if (count < required || sig.state === 'SEARCHING') {
    $('analyzingNow').textContent = `Lendo histórico de velas: ${count}/${required} fechadas.`;
    return;
  }

  const lean = liveDirection === 'BUY' ? 'Pendendo para COMPRA' : liveDirection === 'SELL' ? 'Pendendo para VENDA' : 'AGUARDAR';
  if (sig.phase === 'FINAL') {
    $('analyzingNow').textContent = `${lean}${scoreText} • confirmação da próxima vela nos últimos ${Math.max(0, Math.ceil(Number(sig.secondsRemaining || 0)))}s.`;
  } else if (sig.phase === 'POSSIBLE') {
    $('analyzingNow').textContent = `${lean}${scoreText} • pré-sinal em formação • ${windowCount}/10 velas fechadas.`;
  } else {
    $('analyzingNow').textContent = `${lean}${scoreText} • analisando vela atual para a próxima vela • ${windowCount}/10 fechadas.`;
  }
}

function renderDecision(s = {}) {
  const active = licenseStillValid(s.license);
  const online = active && fresh(s) && s.platformId === 'casatrade';
  const sig = online ? (s.signal || {}) : {};
  const step = marketStep(s);
  const card = $('decisionCard');
  const banner = $('decisionBanner');

  card?.classList.remove('buy', 'sell', 'no-trade');
  banner?.classList.remove('waiting', 'possible', 'buy', 'sell', 'no-trade');

  let title = 'DIAGNÓSTICO: AGUARDAR';
  let badge = 'AGUARDAR';
  let badgeClass = 'badge';
  let decision = '🟡 AGUARDAR';
  let sub = sig.reason || 'Aguardando força suficiente para a próxima vela.';
  let bannerClass = 'waiting';

  if (!active) {
    title = 'ATIVAÇÃO NECESSÁRIA';
    badge = 'BLOQUEADO';
    badgeClass = 'badge warn';
    decision = '🔒 ATIVE A LICENÇA';
    sub = 'O scanner só conecta e começa a analisar depois que a chave for validada.';
  } else if (!online) {
    title = stepTitle(step).toUpperCase();
    badge = 'AGUARDAR';
    decision = '🟡 AGUARDAR';
    sub = step.reason;
  } else if (sig.state === 'SEARCHING') {
    title = 'LENDO HISTÓRICO';
    badge = 'ANALISANDO';
    badgeClass = 'badge warn';
    decision = `VELAS ${Math.max(0, Number(sig.candleCount || 0))}/3`;
    sub = 'Aguardando pelo menos 3 velas fechadas reais antes do diagnóstico operacional.';
  } else if (sig.state === 'WATCH' && sig.direction) {
    const buy = sig.direction === 'BUY';
    title = `DIAGNÓSTICO: ${buy ? 'COMPRA' : 'VENDA'}`;
    badge = 'PRÉ-SINAL';
    badgeClass = 'badge warn';
    decision = `${buy ? '🟢 COMPRA' : '🔴 VENDA'} • AGUARDE CONFIRMAÇÃO`;
    sub = sig.reason || 'Direção encontrada, mas a entrada ainda está bloqueada até a confirmação final.';
    bannerClass = 'possible';
  } else if (sig.state === 'CONFIRM' && sig.direction) {
    const buy = sig.direction === 'BUY';
    title = `DIAGNÓSTICO: ${buy ? 'COMPRA' : 'VENDA'}`;
    badge = 'CONFIRMADO';
    badgeClass = 'badge ok';
    decision = `${buy ? '🟢 COMPRA' : '🔴 VENDA'} NA PRÓXIMA VELA`;
    sub = sig.reason || `Indicação confirmada para a próxima vela${sig.targetLabel ? ` • ${sig.targetLabel}` : ''}.`;
    bannerClass = buy ? 'buy' : 'sell';
    card?.classList.add(buy ? 'buy' : 'sell');
  } else if (sig.state === 'NO_TRADE' && sig.phase === 'FINAL') {
    title = 'DIAGNÓSTICO: AGUARDAR';
    badge = 'SEM ENTRADA';
    badgeClass = 'badge warn';
    decision = '🟡 AGUARDAR';
    sub = sig.reason || 'A próxima vela não tem força suficiente para liberar entrada.';
    bannerClass = 'no-trade';
    card?.classList.add('no-trade');
  }

  if ($('signalTitle')) $('signalTitle').textContent = title;
  if ($('signalBadge')) {
    $('signalBadge').textContent = badge;
    $('signalBadge').className = badgeClass;
  }
  if (banner) banner.classList.add(bannerClass);
  if ($('decisionText')) $('decisionText').textContent = decision;
  if ($('decisionSubtext')) $('decisionSubtext').textContent = sub;
  renderSeparatedSignalState(s, online);
  if ($('signalReason')) $('signalReason').textContent = !active
    ? 'Ative a licença para liberar a conexão com a CasaTrade.'
    : online
      ? (sig.reason || sig.hint || 'Analisando a próxima vela.')
      : s.platformId && s.platformId !== 'casatrade'
        ? 'Plataforma não suportada/não conectada.'
        : step.reason;
  if ($('signalScore')) $('signalScore').textContent = online && num(sig.score) != null ? `${Math.round(Number(sig.score))}/100` : '—';
  if ($('targetTime')) {
    const realEntry = num(s.lastConfirmed?.entryPrice);
    $('targetTime').textContent = !online
      ? '—'
      : sig.state === 'CONFIRM'
        ? 'AGUARDANDO ABERTURA REAL'
        : realEntry != null ? String(realEntry) : '—';
  }
  renderTradeActions(s, online);
}

function render(s = {}) {
  lastState = s;
  renderLicense(s);
  renderAnalysis(s);
  renderDecision(s);
}

async function getState() {
  const stored = await chrome.storage.local.get(['scannerState', LAST_VALID_LICENSE_KEY]).catch(() => ({}));
  const state = stored.scannerState || {};
  const license = effectiveLicense(state?.license || {}, stored[LAST_VALID_LICENSE_KEY] || null);
  const rendered = { ...state, license };
  render(rendered);
  return rendered;
}

async function autoConnect(force = false) {
  if (reconnectBusy || !licenseStillValid(lastState.license)) return;
  if (!force && fresh(lastState) && lastState.platformId === 'casatrade') return;
  reconnectBusy = true;
  try {
    await chrome.runtime.sendMessage({ type: 'ATS_CONNECT_ACTIVE_TAB' }).catch(() => ({ ok: false }));
    await getState();
  } finally {
    reconnectBusy = false;
  }
}

$('activateLicense')?.addEventListener('click', async () => {
  const input = $('licenseKey');
  const button = $('activateLicense');
  const key = input?.value?.trim();
  if (!key || button?.disabled) return;

  if (button) {
    button.disabled = true;
    button.textContent = 'ATIVANDO…';
  }
  if ($('licenseText')) $('licenseText').textContent = 'Validando chave no servidor…';

  try {
    const result = await chrome.runtime.sendMessage({ type: 'ATS_ACTIVATE_LICENSE', key })
      .catch(() => ({ ok: false, error: 'backend_unreachable' }));
    const activated = !!result?.ok && licenseStillValid(result?.license);

    if (activated) {
      if (input) input.value = '';
      await getState();
      await autoConnect(true);
    } else {
      await getState();
      if ($('licenseText')) $('licenseText').textContent = licenseErrorText(result?.error);
    }
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = 'ATIVAR';
    }
  }
});

async function prepare(direction) {
  const status = $('tradeActionStatus');
  if (status) status.textContent = `Preparando ${direction === 'BUY' ? 'COMPRA' : 'VENDA'} na CasaTrade…`;
  const result = await chrome.runtime.sendMessage({ type: 'ATS_PREPARE_TRADE', direction }).catch(() => ({ ok: false }));
  if (status) status.textContent = result?.ok
    ? `${direction === 'BUY' ? 'COMPRA' : 'VENDA'} destacada na CasaTrade. Confirme manualmente.`
    : 'A entrada ainda não está confirmada para esta vela.';
}

$('prepareBuy')?.addEventListener('click', () => prepare('BUY'));
$('prepareSell')?.addEventListener('click', () => prepare('SELL'));

chrome.storage.onChanged.addListener(changes => {
  if (changes.scannerState || changes[LAST_VALID_LICENSE_KEY]) getState().catch(() => {});
});

(async () => {
  await getState();
  if (licenseStillValid(lastState.license)) await autoConnect(true);
  setInterval(() => getState().catch(() => {}), 500);
  setInterval(() => {
    if (licenseStillValid(lastState.license) && (!fresh(lastState) || lastState.platformId !== 'casatrade')) {
      autoConnect().catch(() => {});
    }
  }, 2000);
})();
