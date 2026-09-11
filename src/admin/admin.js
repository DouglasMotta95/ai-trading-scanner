import { PLATFORM_ADAPTERS } from '../platforms/registry.js';

const PUBLIC_API = 'https://ats-control-center-v07-production.up.railway.app';
const DEFAULTS = {
  profile: 'balanced',
  minScore: 78,
  sound: true,
  onlyA: false,
  timeframe: 'M1',
  staleBlock: true,
  volatility: true,
  mtf: true,
  quant: true,
  ai: false,
  apiBase: PUBLIC_API,
  backendApiKey: '',
  supportUrl: '',
  licenseRequired: true,
  forceLicense: true
};
const ids = Object.keys(DEFAULTS);
const $ = id => document.getElementById(id);
let loadedSettings = {};

const normalizeApi = () => PUBLIC_API;

function escapeHtml(v) {
  return String(v).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function renderPlatforms(settings = {}) {
  const root = $('platformSelectors');
  if (!root) return;
  const byPlatform = { ...(settings.selectorsByPlatform || {}) };
  if (settings.casatradeSelectors && !byPlatform.casatrade) {
    byPlatform.casatrade = { ...settings.casatradeSelectors };
  }
  root.innerHTML = PLATFORM_ADAPTERS.map(p => {
    const s = { ...p.defaultSelectors, ...(byPlatform[p.id] || {}) };
    const hosts = p.hosts.length ? p.hosts.join(', ') : 'sem host configurado';
    return `<section class="platform-config">
      <div class="platform-head"><div><b>${escapeHtml(p.name)}</b><span>${escapeHtml(p.id)} • ${escapeHtml(hosts)}</span></div><em>${escapeHtml(p.status)}</em></div>
      <label class="stack">Seletor de preço<input data-platform="${escapeHtml(p.id)}" data-field="price" value="${escapeHtml(s.price || '')}" placeholder="${escapeHtml(p.defaultSelectors?.price || '.price-value')}"></label>
      <label class="stack">Seletor de ativo<input data-platform="${escapeHtml(p.id)}" data-field="asset" value="${escapeHtml(s.asset || '')}" placeholder="${escapeHtml(p.defaultSelectors?.asset || '.asset-name')}"></label>
      <label class="stack">Seletor de timeframe<input data-platform="${escapeHtml(p.id)}" data-field="timeframe" value="${escapeHtml(s.timeframe || '')}" placeholder="${escapeHtml(p.defaultSelectors?.timeframe || '.timeframe')}"></label>
    </section>`;
  }).join('');
}

function renderAdminUrl() {
  const el = $('adminUrl');
  if (el) el.textContent = `${PUBLIC_API}/admin/`;
}

async function lockCommercialSettings(settings = {}) {
  const locked = {
    ...settings,
    apiBase: PUBLIC_API,
    backendApiKey: '',
    licenseRequired: true,
    forceLicense: true
  };
  await chrome.storage.local.set({ settings: locked });
  return locked;
}

async function load() {
  const { settings = {} } = await chrome.storage.local.get('settings');
  const migrated = await lockCommercialSettings(settings);
  loadedSettings = migrated;
  const s = { ...DEFAULTS, ...migrated, apiBase: PUBLIC_API, backendApiKey: '', licenseRequired: true, forceLicense: true };
  ids.forEach(id => {
    const el = $(id);
    if (!el) return;
    if (el.type === 'checkbox') el.checked = !!s[id];
    else el.value = s[id] ?? '';
  });
  if ($('scoreValue')) $('scoreValue').textContent = s.minScore;
  renderPlatforms(migrated);
  renderAdminUrl();
  renderDiag();
}

async function renderDiag() {
  const { scannerState = {} } = await chrome.storage.local.get('scannerState');
  const d = scannerState.diagnostics || {};
  const platform = scannerState.platformName || scannerState.platformId || 'Plataforma não conectada';
  const l = scannerState.license || {};
  const t = scannerState.telemetry || {};
  const diag = $('diag');
  if (!diag) return;
  diag.innerHTML = `<b>${escapeHtml(platform)}</b>
    <span>Ativo: ${escapeHtml(scannerState.asset || '—')}</span>
    <span>Timeframe: ${escapeHtml(scannerState.analysisTimeframe || scannerState.timeframe || '—')}</span>
    <span>Captura: ${escapeHtml(d.capture || '—')}</span>
    <span>Ativos DOM: ${Number(d.domCatalog?.assetCount) || 0} • Feed: ${Number(d.network?.candidateCount) || 0}</span>
    <span>Licença: ${escapeHtml(l.status || '—')} ${escapeHtml(l.planLabel || l.plan || '')}</span>
    <span>Qualidade: ${escapeHtml(t.feedQuality ?? '—')} • Última leitura: ${scannerState.lastSeen ? new Date(scannerState.lastSeen).toLocaleTimeString() : '—'}</span>`;
}

function collect() {
  const s = { ...loadedSettings };
  ids.forEach(id => {
    const el = $(id);
    if (!el) return;
    s[id] = el.type === 'checkbox' ? el.checked : el.type === 'range' ? Number(el.value) : el.value.trim();
  });
  s.apiBase = normalizeApi();
  s.backendApiKey = '';
  s.licenseRequired = true;
  s.forceLicense = true;
  s.selectorsByPlatform = {};
  document.querySelectorAll('[data-platform][data-field]').forEach(el => {
    const id = el.dataset.platform;
    const field = el.dataset.field;
    s.selectorsByPlatform[id] ??= {};
    s.selectorsByPlatform[id][field] = el.value.trim();
  });
  delete s.casatradeSelectors;
  return s;
}

$('minScore')?.addEventListener('input', e => {
  if ($('scoreValue')) $('scoreValue').textContent = e.target.value;
});

$('save')?.addEventListener('click', async () => {
  const settings = collect();
  loadedSettings = settings;
  await chrome.storage.local.set({ settings });
  renderAdminUrl();
  if ($('saved')) {
    $('saved').textContent = '✓ Alterações salvas';
    setTimeout(() => $('saved').textContent = 'Configurações locais', 1800);
  }
});

$('copyDiag')?.addEventListener('click', async () => {
  const { scannerState = {} } = await chrome.storage.local.get('scannerState');
  const safe = {
    platformId: scannerState.platformId,
    platformName: scannerState.platformName,
    asset: scannerState.asset,
    timeframe: scannerState.timeframe,
    analysisTimeframe: scannerState.analysisTimeframe,
    expiration: scannerState.expiration,
    targetExpiration: scannerState.targetExpiration,
    price: scannerState.price,
    license: scannerState.license ? {
      status: scannerState.license.status,
      plan: scannerState.license.plan,
      dailyLimit: scannerState.license.dailyLimit,
      usedToday: scannerState.license.usedToday,
      totalLimit: scannerState.license.totalLimit,
      usedTotal: scannerState.license.usedTotal
    } : null,
    capabilities: scannerState.capabilities,
    diagnostics: scannerState.diagnostics,
    telemetry: scannerState.telemetry,
    lastSeen: scannerState.lastSeen
  };
  try {
    await navigator.clipboard.writeText(JSON.stringify(safe, null, 2));
    $('copyDiag').textContent = '✓ COPIADO';
  } catch {
    $('copyDiag').textContent = 'ERRO AO COPIAR';
  }
  setTimeout(() => $('copyDiag').textContent = 'COPIAR DIAGNÓSTICO', 1500);
});

$('openAdminCentral')?.addEventListener('click', () => chrome.tabs.create({ url: `${PUBLIC_API}/admin/` }));
$('openCustomerPortalFromSettings')?.addEventListener('click', () => chrome.tabs.create({ url: `${PUBLIC_API}/` }));

chrome.storage.onChanged.addListener(c => {
  if (c.scannerState) renderDiag();
  if (c.settings?.newValue?.apiBase && c.settings.newValue.apiBase !== PUBLIC_API) {
    lockCommercialSettings(c.settings.newValue).catch(() => {});
  }
});

load();
