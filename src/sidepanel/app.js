const LAST_VALID_LICENSE_KEY = 'atsLastValidLicense';
const $ = id => document.getElementById(id);
let lastState = {};
let reconnectBusy = false;

if ($('extensionVersion')) $('extensionVersion').textContent = `v${chrome.runtime.getManifest().version}`;

const num = v => v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null;
const fresh = s => s.connection === 'online' && s.lastSeen && Date.now() - Number(s.lastSeen) < 8000;
const priceText = v => num(v) == null ? '—' : String(v);

const licenseStillValid = l => {
  if (l?.status !== 'active') return false;
  if (!l.expiresAt) return true;
  const t = Date.parse(l.expiresAt);
  return Number.isFinite(t) && t > Date.now();
};

const effectiveLicense = (stateLicense = {}, cachedEntry = null) => {
  if (licenseStillValid(stateLicense)) return stateLicense;
  if (['expired', 'limit', 'device_locked'].includes(String(stateLicense?.status || ''))) return stateLicense;
  const cached = cachedEntry?.license;
  if (licenseStillValid(cached)) return { ...cached, status: 'active', error: null, syncPending: false };
  return stateLicense;
};

function renderLicense(s = {}) {
  const l = s.license || {};
  const active = l.status === 'active';
  $('licenseCard')?.classList.toggle('active', active);
  if ($('activationBox')) $('activationBox').hidden = active;
  if ($('licenseHealth')) {
    $('licenseHealth').textContent = active ? 'ATIVA' : String(l.status || 'INATIVA').toUpperCase();
    $('licenseHealth').className = `badge ${active ? 'ok' : l.status === 'expired' || l.status === 'device_locked' ? 'bad' : ''}`;
  }
  if ($('licenseTitle')) $('licenseTitle').textContent = active ? 'Licença ativa' : l.status === 'expired' ? 'Licença expirada' : 'Ativação necessária';
  if ($('licenseText')) {
    $('licenseText').textContent = active
      ? `${l.planLabel || l.plan || 'Plano'} ativo${l.expiresAt ? ` • vence ${new Date(l.expiresAt).toLocaleDateString('pt-BR')}` : ''}.`
      : l.error === 'backend_unreachable'
        ? 'Servidor indisponível. O último acesso válido será mantido quando existir.'
        : 'Ative sua licença para usar o scanner.';
  }
}

function renderAnalysis(s = {}) {
  const online = fresh(s) && s.platformId === 'casatrade';
  const sig = online ? (s.signal || {}) : {};
  const current = sig.currentCandle || s.currentCandle || {};
  const phase = sig.phase || 'ANALYZING';

  if ($('connectionBadge')) {
    $('connectionBadge').textContent = online ? 'CONECTADO' : 'CONECTANDO';
    $('connectionBadge').className = `badge ${online ? 'ok' : 'warn'}`;
  }

  if ($('analysisTitle')) {
    $('analysisTitle').textContent = !online
      ? 'Conectando à CasaTrade'
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
  if ($('timeframe')) $('timeframe').textContent = s.analysisTimeframe || sig.timeframe || s.timeframe || 'M1';
  if ($('expiration')) $('expiration').textContent = s.targetExpiration || sig.targetExpiration || s.expiration || '—';
  if ($('candleProgress')) $('candleProgress').style.width = `${online && num(sig.progress) != null ? Math.max(0, Math.min(100, Number(sig.progress))) : 0}%`;

  if ($('analysisReason')) {
    $('analysisReason').textContent = online
      ? (sig.phase === 'POSSIBLE'
        ? 'Padrão encontrado. Ainda não entrar: a extensão continua acompanhando a vela até a confirmação final.'
        : sig.phase === 'FINAL'
          ? 'Janela final: decisão travada para a próxima vela.'
          : sig.reason || 'Analisando velas anteriores + vela atual em tempo real.')
      : 'Abra a CasaTrade e mantenha a aba ativa. A conexão é automática.';
  }

  if ($('currentOpen')) $('currentOpen').textContent = priceText(current.open);
  if ($('currentHigh')) $('currentHigh').textContent = priceText(current.high);
  if ($('currentLow')) $('currentLow').textContent = priceText(current.low);
  if ($('currentClose')) $('currentClose').textContent = priceText(current.close ?? s.price);
}

function renderDecision(s = {}) {
  const online = fresh(s) && s.platformId === 'casatrade';
  const sig = online ? (s.signal || {}) : {};
  const card = $('decisionCard');
  const banner = $('decisionBanner');

  card?.classList.remove('buy', 'sell', 'no-trade');
  banner?.classList.remove('waiting', 'possible', 'buy', 'sell', 'no-trade');

  let title = 'ANALISANDO';
  let badge = 'AGUARDANDO';
  let badgeClass = 'badge';
  let decision = 'ANALISANDO';
  let sub = 'O pré-sinal aparece nos últimos 30s e a decisão final nos últimos 10s.';
  let bannerClass = 'waiting';

  if (!online) {
    title = 'AGUARDANDO CASATRADE';
    decision = 'SEM LEITURA';
    sub = 'A extensão conecta automaticamente quando a CasaTrade estiver ativa.';
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
    badge = 'CONFIRMADO';
    badgeClass = 'badge ok';
    decision = `${buy ? '🟢 ENTRAR EM COMPRA' : '🔴 ENTRAR EM VENDA'}`;
    sub = `Entrada manual na próxima vela${sig.targetLabel ? ` • ${sig.targetLabel}` : ''}.`;
    bannerClass = buy ? 'buy' : 'sell';
    card?.classList.add(buy ? 'buy' : 'sell');
  } else if (sig.state === 'NO_TRADE' && sig.phase === 'FINAL') {
    title = 'NÃO ENTRAR';
    badge = 'SEM ENTRADA';
    badgeClass = 'badge warn';
    decision = '⛔ NÃO ENTRAR';
    sub = 'A confirmação final não manteve força suficiente. Aguarde a próxima análise.';
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
  if ($('signalReason')) $('signalReason').textContent = online ? (sig.reason || sig.hint || 'Analisando o mercado.') : 'Plataforma não suportada/não conectado.';
  if ($('signalScore')) $('signalScore').textContent = online && num(sig.score) != null ? `${Math.round(Number(sig.score))}/100` : '—';
  if ($('targetTime')) $('targetTime').textContent = online && sig.targetLabel ? sig.targetLabel : '—';
}

function render(s = {}) {
  lastState = s;
  renderLicense(s);
  renderAnalysis(s);
  renderDecision(s);
}

async function getState() {
  // Do not trigger a fresh DOM scan on every 500 ms UI refresh. The CasaTrade
  // readers write scannerState continuously; the panel should only render it.
  // This prevents a partial direct scan from overwriting a valid live snapshot.
  const stored = await chrome.storage.local.get(['scannerState', LAST_VALID_LICENSE_KEY]).catch(() => ({}));
  const state = stored.scannerState || {};
  const license = effectiveLicense(state?.license || {}, stored[LAST_VALID_LICENSE_KEY] || null);
  const rendered = { ...state, license };
  render(rendered);
  return rendered;
}

async function autoConnect(force = false) {
  if (reconnectBusy) return;
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
  const key = $('licenseKey')?.value?.trim();
  if (!key) return;
  const result = await chrome.runtime.sendMessage({ type: 'ATS_ACTIVATE_LICENSE', key }).catch(() => ({ ok: false }));
  if (result?.ok && $('licenseKey')) $('licenseKey').value = '';
  await getState();
});

chrome.storage.onChanged.addListener(changes => {
  if (changes.scannerState || changes[LAST_VALID_LICENSE_KEY]) getState().catch(() => {});
});

(async () => {
  await autoConnect(true);
  await getState();

  setInterval(() => getState().catch(() => {}), 500);
  setInterval(() => {
    if (!fresh(lastState) || lastState.platformId !== 'casatrade') autoConnect().catch(() => {});
  }, 2000);
})();
