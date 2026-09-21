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

function candleTime(row = {}) {
  let value = num(row?.time ?? row?.timestamp);
  if (value != null && value > 0 && value < 1e12) value *= 1000;
  return value != null && value > 0 ? value : null;
}

function median(values = []) {
  const rows = values.filter(Number.isFinite).sort((a,b) => a-b);
  if (!rows.length) return null;
  const mid = Math.floor(rows.length / 2);
  return rows.length % 2 ? rows[mid] : (rows[mid - 1] + rows[mid]) / 2;
}

function currentM1Closed(state = {}, now = Date.now()) {
  const history = state.marketHistory && typeof state.marketHistory === 'object' ? state.marketHistory : {};
  const key = Object.keys(history).find(value => marketId(value) === marketId(state.asset));
  const source = key && Array.isArray(history[key]) ? history[key] : Array.isArray(state.candles) ? state.candles : [];
  const rows = source
    .map(row => ({ ...row, __time: candleTime(row), close: num(row?.close) }))
    .filter(row => row.__time != null && row.close != null)
    .sort((a,b) => a.__time - b.__time);
  const unique = [...new Map(rows.map(row => [row.__time, row])).values()];
  const diffs = [];
  for (let i = 1; i < unique.length; i += 1) {
    const diff = unique[i].__time - unique[i - 1].__time;
    if (diff >= 30_000 && diff <= 120_000) diffs.push(diff);
  }
  const cadence = median(diffs);
  if (cadence == null || cadence < 45_000 || cadence > 90_000) return [];
  return unique.filter(row => row.__time + 60_000 <= now);
}

function aggregateM5Closed(m1Rows = [], now = Date.now()) {
  const groups = new Map();
  for (const row of m1Rows) {
    const bucket = Math.floor(row.__time / 300_000) * 300_000;
    if (bucket + 300_000 > now) continue;
    const group = groups.get(bucket) || new Map();
    group.set(Math.floor(row.__time / 60_000) * 60_000, row);
    groups.set(bucket, group);
  }
  return [...groups.entries()]
    .sort((a,b) => a[0] - b[0])
    .filter(([, group]) => group.size >= 5)
    .map(([time, group]) => {
      const rows = [...group.values()].sort((a,b) => a.__time - b.__time).slice(0,5);
      return { time, close: num(rows.at(-1)?.close) };
    })
    .filter(row => row.close != null);
}

function kaufmanEfficiency(values = []) {
  const rows = values.map(num).filter(value => value != null).slice(-20);
  if (rows.length < 20) return null;
  const change = Math.abs(rows.at(-1) - rows[0]);
  let volatility = 0;
  for (let i = 1; i < rows.length; i += 1) volatility += Math.abs(rows[i] - rows[i - 1]);
  return volatility > 0 ? change / volatility : 0;
}

function timeframeSuggestion(state = {}) {
  const m1 = currentM1Closed(state);
  const m5 = aggregateM5Closed(m1);
  const erM1 = kaufmanEfficiency(m1.map(row => row.close));
  const erM5 = kaufmanEfficiency(m5.map(row => row.close));
  if (erM1 == null || erM5 == null || Math.abs(erM5 - erM1) < 0.10) {
    return { value: 'SEM_DIFERENCA_CLARA', erM1, erM5 };
  }
  return { value: erM5 > erM1 ? 'M5' : 'M1', erM1, erM5 };
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

function ensureSignalNotes() {
  let root = $('signalFixedNotes');
  if (root) return root;
  const quick = ensureQuickMeta();
  if (!quick) return null;
  root = document.createElement('div');
  root.id = 'signalFixedNotes';
  root.className = 'signal-fixed-notes';
  root.innerHTML = `
    <p id="signalExpirationReminder" hidden>Confira na CasaTrade: expiração —</p>
    <p id="signalTimeframeSuggestion">Sugestão: sem diferença clara (não validada)</p>
  `;
  quick.insertAdjacentElement('afterend', root);
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
  ensureSignalNotes();
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

function renderSignalNotes(state = {}) {
  ensureSignalNotes();
  const professional = state.professionalDecision || {};
  const signal = state.signal || {};
  const ui = clean(professional.uiState || signal.uiState).toUpperCase();
  const showExpiration = ['POSSIBLE_BUY','POSSIBLE_SELL','ENTER_BUY','ENTER_SELL'].includes(ui);
  const modeTf = operationMode(state);
  const requiredExpiration = state.analystPreferences?.operationExpiration
    || state.diagnostics?.expirationGuard?.required
    || (modeTf === 'M5' ? '300s' : '60s');

  const expiration = $('signalExpirationReminder');
  if (expiration) {
    expiration.hidden = !showExpiration;
    expiration.textContent = `Confira na CasaTrade: expiração ${labelExp(requiredExpiration)}`;
  }

  const suggestion = timeframeSuggestion(state);
  const suggestionText = suggestion.value === 'M1' || suggestion.value === 'M5'
    ? suggestion.value
    : 'sem diferença clara';
  if ($('signalTimeframeSuggestion')) {
    $('signalTimeframeSuggestion').textContent = `Sugestão: ${suggestionText} (não validada)`;
  }
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
  renderSignalNotes(lastState);
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
