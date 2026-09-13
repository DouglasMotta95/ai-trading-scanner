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
  const sig = online ? (s.signal || {}) : {};
  const current = online ? (sig.currentCandle || s.currentCandle || {}) : {};
  const phase = sig.phase || 'ANALYZING';

  if ($('connectionBadge')) {
    $('connectionBadge').textContent = !active ? 'BLOQUEADO' : online ? 'CONECTADO' : 'CONECTANDO';
    $('connectionBadge').className = `badge ${online ? 'ok' : 'warn'}`;
  }

  if ($('analysisTitle')) {
    $('analysisTitle').textContent = !active
      ? 'Ative a licença para conectar'
      : !online
        ? 'Confirmando ativo aberto na CasaTrade…'
        : !s.asset || s.price == null
          ? 'Lendo mercado real…'
          : phase === 'POSSIBLE'
            ? `Pré-sinal: possível ${sig.direction === 'SELL' ? 'VENDA' : 'COMPRA'}`
            : phase === 'FINAL'
              ? 'Confirmação final da vela'
              : 'Analisando vela atual';
  }

  if ($('asset')) $('asset').textContent = online && s.asset ? s.asset : '—';
  if ($('price')) $('price').textContent = online && s.price != null ? String(s.price) : '—';
  if ($('secondsRemaining')) $('secondsRemaining').textContent = online && num(sig.secondsRemaining) != null ? String(Math.max(0, Math.ceil(Number(sig.secondsRemaining)))) : '—';
  if ($('timeframe')) $('timeframe').textContent = online ? (s.analysisTimeframe || sig.timeframe || s.timeframe || 'M1') : '—';
  if ($('expiration')) $('expiration').textContent = online ? (s.targetExpiration || sig.targetExpiration || s.expiration || '—') : '—';
  if ($('candleProgress')) $('candleProgress').style.width = `${online && num(sig.progress) != null ? Math.max(0, Math.min(100, Number(sig.progress))) : 0}%`;

  if ($('analysisReason')) {
    $('analysisReason').textContent = !active
      ? 'Nenhum dado de mercado é analisado antes da licença ficar ATIVA.'
      : online
        ? (sig.phase === 'POSSIBLE'
          ? 'Padrão encontrado. Ainda não entrar: a extensão continua acompanhando a vela até a confirmação final.'
          : sig.phase === 'FINAL'
            ? 'Janela final: o score continua sendo recalculado a cada novo tick até o fechamento.'
            : sig.reason || 'Analisando somente o ativo realmente aberto na tela.')
        : 'Aguardando confirmar o ativo selecionado e receber cotações correspondentes.';
  }

  if ($('currentOpen')) $('currentOpen').textContent = priceText(current.open);
  if ($('currentHigh')) $('currentHigh').textContent = priceText(current.high);
  if ($('currentLow')) $('currentLow').textContent = priceText(current.low);
  if ($('currentClose')) $('currentClose').textContent = priceText(current.close);
  renderRecentCandles(online ? s : { candles: [] });
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
      ? `Janela final: ${sig.direction === 'BUY' ? 'COMPRA' : 'VENDA'} indicada para a próxima vela; o cálculo continua até o fechamento.`
      : possible
        ? `Pré-sinal de ${sig.direction === 'BUY' ? 'COMPRA' : 'VENDA'}; aguarde os últimos 10s.`
        : 'COMPRA/VENDA só libera quando a confirmação final estiver pronta.';
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
    $('analyzingNow').textContent = 'Aguardando dados reais da CasaTrade.';
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
    $('analyzingNow').textContent = `Aguardando histórico mínimo: ${count}/${required} velas fechadas • janela atual ${windowCount}/10.`;
    return;
  }

  const lean = liveDirection === 'BUY' ? 'Pendendo para COMPRA' : liveDirection === 'SELL' ? 'Pendendo para VENDA' : 'Sem direção firme';
  if (sig.phase === 'FINAL') {
    $('analyzingNow').textContent = `${lean}${scoreText} • últimos ${Math.max(0, Math.ceil(Number(sig.secondsRemaining || 0)))}s, recalculando a cada tick até fechar.`;
  } else if (sig.phase === 'POSSIBLE') {
    $('analyzingNow').textContent = `${lean}${scoreText} • pré-sinal em formação • ${windowCount}/10 velas fechadas.`;
  } else {
    $('analyzingNow').textContent = `${lean}${scoreText} • cálculo em tempo real • ${windowCount}/10 velas fechadas.`;
  }
}

function renderDecision(s = {}) {
  const active = licenseStillValid(s.license);
  const online = active && fresh(s) && s.platformId === 'casatrade';
  const sig = online ? (s.signal || {}) : {};
  const card = $('decisionCard');
  const banner = $('decisionBanner');

  card?.classList.remove('buy', 'sell', 'no-trade');
  banner?.classList.remove('waiting', 'possible', 'buy', 'sell', 'no-trade');

  let title = 'ANALISANDO';
  let badge = 'AGUARDANDO';
  let badgeClass = 'badge';
  let decision = 'ANALISANDO';
  let sub = 'O pré-sinal aparece nos últimos 30s e a decisão final é recalculada até o fechamento.';
  let bannerClass = 'waiting';

  if (!active) {
    title = 'ATIVAÇÃO NECESSÁRIA';
    badge = 'BLOQUEADO';
    badgeClass = 'badge warn';
    decision = '🔒 ATIVE A LICENÇA';
    sub = 'O scanner só conecta e começa a analisar depois que a chave for validada.';
  } else if (!online) {
    title = 'CONFIRMANDO ATIVO';
    decision = 'AGUARDANDO LEITURA REAL';
    sub = 'Aguardando o ativo aberto na tela ficar estável e a cotação correspondente chegar.';
  } else if (sig.state === 'WATCH' && sig.direction) {
    const buy = sig.direction === 'BUY';
    title = `POSSÍVEL ${buy ? 'COMPRA' : 'VENDA'}`;
    badge = 'PRÉ-SINAL';
    badgeClass = 'badge warn';
    decision = `🟡 POSSÍVEL ${buy ? 'COMPRA' : 'VENDA'}`;
    sub = 'Ainda não entrar. A confirmação final será feita nos últimos 10 segundos.';
    bannerClass = 'possible';
  } else if (sig.state === 'CONFIRM' && sig.direction) {
    const buy = sig.direction === 'BUY';
    title = `${buy ? 'COMPRA' : 'VENDA'} NA PRÓXIMA VELA`;
    badge = 'JANELA FINAL';
    badgeClass = 'badge ok';
    decision = `${buy ? '🟢 ENTRAR EM COMPRA' : '🔴 ENTRAR EM VENDA'}`;
    sub = `Indicação atual para a próxima vela${sig.targetLabel ? ` • ${sig.targetLabel}` : ''}; recalculando até o fechamento.`;
    bannerClass = buy ? 'buy' : 'sell';
    card?.classList.add(buy ? 'buy' : 'sell');
  } else if (sig.state === 'NO_TRADE' && sig.phase === 'FINAL') {
    title = 'NÃO ENTRAR';
    badge = 'JANELA FINAL';
    badgeClass = 'badge warn';
    decision = '⛔ NÃO ENTRAR';
    sub = 'A indicação atual não tem força suficiente; o cálculo continua até a vela fechar.';
    bannerClass = 'no-trade';
    card?.classList.add('no-trade');
  } else if (sig.state === 'SEARCHING') {
    title = 'LENDO HISTÓRICO';
    badge = 'ANALISANDO';
    badgeClass = 'badge warn';
    decision = 'LENDO VELAS';
    sub = 'Aguardando pelo menos 3 velas fechadas reais antes do pré-sinal.';
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
      ? (sig.reason || sig.hint || 'Analisando o mercado.')
      : s.platformId && s.platformId !== 'casatrade'
        ? 'Plataforma não suportada/não conectado.'
        : 'Aguardando leitura real do ativo aberto.';
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
