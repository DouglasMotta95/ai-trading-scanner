const LAST_VALID_LICENSE_KEY = 'atsLastValidLicense';
const $ = id => document.getElementById(id);
const amountInput = $('tradeAmount');
const tfSelect = $('analysisTimeframe');
const expSelect = $('targetExpiration');
const buyBtn = $('prepareBuy');
const sellBtn = $('prepareSell');
let lastState = {};
let prefs = {};
let syncBusy = false;
let syncTimer = null;
let sessionHistory = [];

if ($('extensionVersion')) $('extensionVersion').textContent = `v${chrome.runtime.getManifest().version}`;

const num = v => v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null;
const money = v => num(v) == null ? '—' : new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 8 }).format(Number(v));
const fresh = s => s.connection === 'online' && s.lastSeen && Date.now() - Number(s.lastSeen) < 8000;
const configuredPrefs = p => {
  const amount = num(p.tradeAmount ?? p.stake);
  return amount != null && amount > 0 && p.timeframe && p.timeframe !== 'AUTO' && p.expiration && p.expiration !== 'AUTO';
};
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
  if (licenseStillValid(cached)) return { ...cached, status: 'active', error: stateLicense?.error || null, syncPending: true };
  return stateLicense;
};

function ensureOption(select, value) {
  value = String(value || '').trim();
  if (!select || !value || [...select.options].some(o => o.value === value)) return;
  const option = document.createElement('option');
  option.value = value;
  option.textContent = value;
  select.appendChild(option);
}

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

function renderConnection(s = {}) {
  const online = fresh(s) && s.platformId === 'casatrade';
  const quality = online ? Math.max(0, Math.min(100, Math.round(Number(s.telemetry?.feedQuality ?? s.diagnostics?.network?.feedQuality ?? 0)))) : 0;
  if ($('connectionTitle')) $('connectionTitle').textContent = online ? 'CasaTrade conectada' : 'Não conectado';
  if ($('connectionBadge')) {
    $('connectionBadge').textContent = online ? 'CONECTADO' : 'OFFLINE';
    $('connectionBadge').className = `badge ${online ? 'ok' : 'bad'}`;
  }
  if ($('connectionText')) $('connectionText').textContent = online ? 'Recebendo dados da aba CasaTrade vinculada.' : 'Plataforma não suportada ou CasaTrade não conectada.';
  if ($('feedQuality')) $('feedQuality').textContent = online ? `${quality}/100` : '—';
  if ($('lastFeed')) $('lastFeed').textContent = online && s.lastSeen ? new Date(s.lastSeen).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';
  if ($('connectBtn')) $('connectBtn').textContent = online ? 'RECONECTAR CASATRADE' : 'CONECTAR CASATRADE';
}

function renderConfig(s = {}) {
  const observed = s.platformControls?.observed || {};
  const aligned = !!s.platformControls?.aligned && fresh(s);
  if ($('syncBadge')) {
    $('syncBadge').textContent = aligned ? 'SINCRONIZADO' : configuredPrefs(prefs) ? 'VERIFICAR' : 'CONFIGURAR';
    $('syncBadge').className = `badge ${aligned ? 'ok' : configuredPrefs(prefs) ? 'warn' : ''}`;
  }
  if ($('platformObserved')) {
    $('platformObserved').textContent = fresh(s)
      ? `CasaTrade: ${observed.amount == null ? 'valor não lido' : money(observed.amount)} • ${observed.timeframe || 'vela não lida'} • ${observed.expiration || 'expiração não lida'}`
      : 'CasaTrade ainda não lida.';
  }
}

function signalLabel(sig = {}) {
  if (sig.state === 'CONFIRM') return sig.direction === 'SELL' ? 'VENDA CONFIRMADA' : 'COMPRA CONFIRMADA';
  if (sig.state === 'WATCH') return 'CONFLUÊNCIA';
  if (sig.state === 'SEARCHING') return 'AGUARDANDO VELAS';
  if (sig.state === 'NO_TRADE') return 'NÃO ENTRAR';
  return 'AGUARDANDO';
}

function renderSignal(s = {}) {
  const online = fresh(s) && s.platformId === 'casatrade';
  const sig = online ? (s.signal || {}) : {};
  const label = signalLabel(sig);
  if ($('signalTitle')) $('signalTitle').textContent = label;
  if ($('signalBadge')) {
    $('signalBadge').textContent = sig.state === 'CONFIRM' ? sig.direction || 'CONFIRMADO' : sig.state === 'WATCH' ? 'CONFLUÊNCIA' : 'AGUARDANDO';
    $('signalBadge').className = `badge ${sig.state === 'CONFIRM' ? 'ok' : sig.state === 'WATCH' ? 'warn' : ''}`;
  }
  if ($('signalReason')) $('signalReason').textContent = online ? (sig.reason || sig.hint || 'Aguardando dados suficientes.') : 'Plataforma não suportada/não conectado.';
  if ($('asset')) $('asset').textContent = online && s.asset ? s.asset : '—';
  if ($('price')) $('price').textContent = online && s.price != null ? String(s.price) : '—';

  const confirmed = online && sig.state === 'CONFIRM' && !sig.provisional && !!s.platformControls?.aligned;
  buyBtn.disabled = !(confirmed && sig.direction === 'BUY');
  sellBtn.disabled = !(confirmed && sig.direction === 'SELL');
  if ($('entryText')) {
    $('entryText').textContent = confirmed
      ? `${sig.direction} ${s.asset || ''} • ${s.analysisTimeframe || s.timeframe || '—'} • expiração ${s.targetExpiration || s.expiration || '—'} • confirmação manual na CasaTrade.`
      : 'A entrada só é liberada quando houver sinal confirmado e configuração sincronizada.';
  }
}

function renderHistory(rows = []) {
  const valid = Array.isArray(rows) ? rows.filter(x => ['BUY', 'SELL'].includes(x.direction)) : [];
  if ($('historyCount')) $('historyCount').textContent = String(valid.length);
  if (!$('signalHistory')) return;
  $('signalHistory').innerHTML = valid.length ? valid.slice(0, 20).map(x => `
    <div class="history-row">
      <span class="history-dir ${x.direction === 'SELL' ? 'sell' : 'buy'}">${x.direction}</span>
      <div><b>${x.asset || '—'}</b><small>${x.timeframe || '—'} • ${x.expiration || '—'} • ${x.entryPrice ?? '—'}</small></div>
      <time>${new Date(x.at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</time>
    </div>`).join('') : '<div class="empty-state">Nenhum sinal confirmado nesta sessão.</div>';
}

function render(s = {}) {
  lastState = s;
  renderLicense(s);
  renderConnection(s);
  renderConfig(s);
  renderSignal(s);
  renderHistory(sessionHistory);
}

async function loadSettings() {
  const { settings = {} } = await chrome.storage.local.get('settings');
  prefs = settings.scanPreferences || {};
  if (document.activeElement !== amountInput && amountInput) amountInput.value = num(prefs.tradeAmount ?? prefs.stake) > 0 ? String(prefs.tradeAmount ?? prefs.stake).replace('.', ',') : '';
  if (tfSelect) { ensureOption(tfSelect, prefs.timeframe); tfSelect.value = prefs.timeframe || 'AUTO'; }
  if (expSelect) { ensureOption(expSelect, prefs.expiration); expSelect.value = prefs.expiration || 'AUTO'; }
}

async function savePrefs() {
  const amount = Number(String(amountInput?.value || '').replace(',', '.'));
  const { settings = {} } = await chrome.storage.local.get('settings');
  prefs = {
    ...(settings.scanPreferences || {}),
    tradeAmount: Number.isFinite(amount) && amount > 0 ? amount : null,
    stake: Number.isFinite(amount) && amount > 0 ? amount : null,
    timeframe: tfSelect?.value || 'AUTO',
    expiration: expSelect?.value || 'AUTO'
  };
  await chrome.storage.local.set({ settings: { ...settings, scanPreferences: prefs } });
}

async function getState() {
  const [state, stored, history] = await Promise.all([
    chrome.runtime.sendMessage({ type: 'ATS_GET_STATE' }).catch(() => ({})),
    chrome.storage.local.get(LAST_VALID_LICENSE_KEY).catch(() => ({})),
    chrome.runtime.sendMessage({ type: 'ATS_GET_SESSION_HISTORY' }).catch(() => ({ rows: [] }))
  ]);
  sessionHistory = Array.isArray(history?.rows) ? history.rows : [];
  const license = effectiveLicense(state?.license || {}, stored[LAST_VALID_LICENSE_KEY] || null);
  render({ ...state, license });
}

async function syncNow() {
  if (syncBusy) return;
  syncBusy = true;
  try {
    await savePrefs();
    await chrome.runtime.sendMessage({ type: 'ATS_SYNC_PLATFORM_PREFERENCES' }).catch(() => ({ ok: false }));
    await getState();
  } finally {
    syncBusy = false;
  }
}
function scheduleSync() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(syncNow, 300);
}

$('connectBtn')?.addEventListener('click', async () => {
  const result = await chrome.runtime.sendMessage({ type: 'ATS_CONNECT_ACTIVE_TAB' }).catch(() => ({ ok: false }));
  if (result?.ok && configuredPrefs(prefs)) await syncNow();
  else await getState();
});
$('syncPlatformBtn')?.addEventListener('click', syncNow);
amountInput?.addEventListener('change', scheduleSync);
amountInput?.addEventListener('blur', scheduleSync);
tfSelect?.addEventListener('change', scheduleSync);
expSelect?.addEventListener('change', scheduleSync);

$('activateLicense')?.addEventListener('click', async () => {
  const key = $('licenseKey')?.value?.trim();
  if (!key) return;
  const result = await chrome.runtime.sendMessage({ type: 'ATS_ACTIVATE_LICENSE', key }).catch(() => ({ ok: false }));
  if (result?.ok && $('licenseKey')) $('licenseKey').value = '';
  await getState();
});

buyBtn?.addEventListener('click', async () => {
  if (lastState.signal?.state !== 'CONFIRM' || lastState.signal?.direction !== 'BUY') return;
  await chrome.runtime.sendMessage({ type: 'ATS_PREPARE_TRADE', direction: 'BUY' }).catch(() => ({}));
  await getState();
});
sellBtn?.addEventListener('click', async () => {
  if (lastState.signal?.state !== 'CONFIRM' || lastState.signal?.direction !== 'SELL') return;
  await chrome.runtime.sendMessage({ type: 'ATS_PREPARE_TRADE', direction: 'SELL' }).catch(() => ({}));
  await getState();
});

chrome.storage.onChanged.addListener(changes => {
  if (changes.settings) loadSettings().then(getState);
  else if (changes.scannerState || changes[LAST_VALID_LICENSE_KEY]) getState();
});

(async () => {
  await loadSettings();
  await getState();
  chrome.runtime.sendMessage({ type: 'ATS_VALIDATE_LICENSE' }).catch(() => {});
  setInterval(getState, 1000);
  setInterval(() => {
    if (fresh(lastState) && lastState.platformId === 'casatrade') chrome.runtime.sendMessage({ type: 'ATS_READ_PLATFORM_CONTROLS' }).catch(() => {});
  }, 2500);
})();
