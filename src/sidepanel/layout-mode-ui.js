// UI-only layout controller. It never changes scanner, market, timing or signal state.
const VIEW_KEY = 'atsPanelViewV1';
const STATE_KEY = 'scannerState';
const $ = id => document.getElementById(id);
const clean = value => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
const num = value => value == null || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null;

let mode = 'signal';
let lastState = {};

function marketId(value) {
  const raw = clean(value).toUpperCase();
  if (!raw) return '';
  const otc = /(?:\(|\b|[_-])OTC(?:\)|\b)?/i.test(raw);
  const pair = raw.match(/\b([A-Z0-9]{2,20})\s*[\/_-]\s*([A-Z0-9]{2,12})/i);
  return pair ? `${pair[1]}/${pair[2]}${otc ? ' (OTC)' : ''}` : raw;
}

function labelExp(value) {
  const raw = clean(value).toLowerCase().replace(/\s+/g, '');
  if (/^(?:60s|1m|1min|1minuto)$/.test(raw)) return '1 min';
  if (/^(?:300s|5m|5min|5minutos)$/.test(raw)) return '5 min';
  if (/^(?:5s|5seg)$/.test(raw)) return '5 s';
  if (/^(?:15s|15seg)$/.test(raw)) return '15 s';
  if (/^(?:30s|30seg)$/.test(raw)) return '30 s';
  return clean(value) || '—';
}

function operationMode(state = {}) {
  return clean(state.analystPreferences?.operationMode || state.analysisTimeframe || state.timeframe || 'M1').toUpperCase() === 'M5' ? 'M5' : 'M1';
}

function ensureToggle() {
  let root = $('panelViewToggle');
  if (root) return root;
  const topbar = document.querySelector('.topbar');
  const status = topbar?.querySelector('.top-status');
  if (!topbar || !status) return null;

  root = document.createElement('div');
  root.id = 'panelViewToggle';
  root.className = 'panel-view-toggle';
  root.setAttribute('role','group');
  root.setAttribute('aria-label','Visualização do painel');
  root.innerHTML = `
    <button id="viewSignal" type="button">SINAL</button>
    <button id="viewFull" type="button">COMPLETO</button>
  `;
  status.insertAdjacentElement('beforebegin', root);
  $('viewSignal')?.addEventListener('click', () => setMode('signal', true));
  $('viewFull')?.addEventListener('click', () => setMode('full', true));
  return root;
}

function ensureQuickMeta() {
  let root = $('signalQuickMeta');
  if (root) return root;
  const banner = $('decisionBanner');
  if (!banner) return null;
  root = document.createElement('div');
  root.id = 'signalQuickMeta';
  root.className = 'signal-quick-meta';
  root.innerHTML = `
    <span><small>ATIVO</small><b id="quickAsset">—</b></span>
    <span><small>MODO</small><b id="quickMode">—</b></span>
    <span><small>TEMPO</small><b id="quickTime">—</b></span>
    <span><small>SCORE</small><b id="quickScore">—</b></span>
  `;
  banner.insertAdjacentElement('afterend', root);
  return root;
}

function ensureChartDisclosure() {
  let details = $('marketChartPanel');
  const card = document.querySelector('.live-card');
  if (details || !card || !card.parentElement) return details;

  details = document.createElement('details');
  details.id = 'marketChartPanel';
  details.className = 'market-chart-panel';
  const summary = document.createElement('summary');
  summary.innerHTML = '<span>GRÁFICO E VELAS</span><small>OHLC • últimas 10 velas</small>';
  card.parentElement.insertBefore(details, card);
  details.append(summary, card);
  return details;
}

function moveOperationalPulse() {
  const pulse = $('operationalPulse');
  const advanced = document.querySelector('#advancedPanel .advanced-stack');
  if (!pulse || !advanced || pulse.parentElement === advanced) return;
  advanced.insertBefore(pulse, advanced.firstChild);
  pulse.classList.add('moved-to-advanced');
}

function syncDynamicUi() {
  ensureToggle();
  ensureQuickMeta();
  ensureChartDisclosure();
  moveOperationalPulse();
  document.querySelector('#marketRadar')?.classList.add('layout-aware-radar');
}

function setMode(next, persist = false) {
  mode = next === 'full' ? 'full' : 'signal';
  document.body.dataset.panelMode = mode;
  ensureToggle();
  $('viewSignal')?.classList.toggle('active', mode === 'signal');
  $('viewFull')?.classList.toggle('active', mode === 'full');

  const chart = ensureChartDisclosure();
  if (chart && mode === 'signal') chart.open = false;
  if (persist) chrome.storage.local.set({ [VIEW_KEY]: mode }).catch(() => {});
  renderQuickMeta(lastState);
}

function renderQuickMeta(state = {}) {
  ensureQuickMeta();
  const professional = state.professionalDecision || {};
  const signal = state.signal || {};
  const modeTf = operationMode(state);
  const asset = marketId(state.asset) || '—';
  const seconds = num(professional.secondsRemaining ?? signal.secondsRemaining ?? state.diagnostics?.marketClock?.secondsRemaining);
  const score = num(professional.score ?? signal.analysisScore ?? signal.score);
  const expiration = state.analystPreferences?.operationExpiration
    || state.diagnostics?.expirationGuard?.required
    || (modeTf === 'M5' ? '300s' : '60s');

  if ($('quickAsset')) $('quickAsset').textContent = asset;
  if ($('quickMode')) $('quickMode').textContent = `${modeTf} • ${labelExp(expiration)}`;
  if ($('quickTime')) $('quickTime').textContent = seconds == null ? '—' : `${Math.max(0, Math.ceil(seconds))}s`;
  if ($('quickScore')) $('quickScore').textContent = score == null ? '—' : `${Math.round(score)}/100`;
}

function renderConnectionAnimation(state = {}) {
  const button = $('connectScanner');
  if (!button) return;
  const connecting = state.connection === 'connecting'
    || clean(state.diagnostics?.acquisition?.stage).includes('connect')
    || button.classList.contains('loading');
  button.classList.toggle('ats-connecting', connecting && !button.classList.contains('live'));

  const card = $('decisionCard');
  if (card) {
    const professional = state.professionalDecision || {};
    const signal = state.signal || {};
    const ui = clean(professional.uiState || signal.uiState).toUpperCase();
    card.classList.toggle('ats-analyzing', !['POSSIBLE_BUY','POSSIBLE_SELL','ENTER_BUY','ENTER_SELL'].includes(ui));
    card.classList.toggle('ats-possible', ui === 'POSSIBLE_BUY' || ui === 'POSSIBLE_SELL');
    card.classList.toggle('ats-enter', ui === 'ENTER_BUY' || ui === 'ENTER_SELL' || professional.actionable === true);
  }
}

function render(state = {}) {
  lastState = state || {};
  syncDynamicUi();
  renderQuickMeta(lastState);
  renderConnectionAnimation(lastState);
}

const observer = new MutationObserver(() => syncDynamicUi());
observer.observe(document.body, { childList:true, subtree:true });

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes[STATE_KEY]) render(changes[STATE_KEY].newValue || {});
  if (changes[VIEW_KEY]) setMode(changes[VIEW_KEY].newValue, false);
});

(async () => {
  const stored = await chrome.storage.local.get([VIEW_KEY, STATE_KEY]).catch(() => ({}));
  lastState = stored?.[STATE_KEY] || {};
  syncDynamicUi();
  setMode(stored?.[VIEW_KEY] || 'signal', false);
  render(lastState);
})();
