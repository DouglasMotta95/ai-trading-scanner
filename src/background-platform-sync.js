const clean = v => String(v ?? '').trim();
const num = v => v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null;
const normTf = v => {
  const s = clean(v).toUpperCase().replace(/\s+/g, '');
  let m = s.match(/^(?:M)?(1|2|5|15|30)$/); if (m) return `M${m[1]}`;
  m = s.match(/^(?:S)?(5|15|30)$/); if (m && /^S/.test(s)) return `S${m[1]}`;
  if (/^(H1|1H)$/.test(s)) return 'H1';
  return s || null;
};
const normExp = v => {
  const s = clean(v).toLowerCase().replace(/\s+/g, '');
  let m = s.match(/^(\d+)s$/); if (m) return `${Number(m[1])}s`;
  m = s.match(/^(\d+)m(?:in)?$/); if (m) return Number(m[1]) === 1 ? '60s' : `${Number(m[1])}m`;
  return s || null;
};
const configured = p => num(p.tradeAmount ?? p.stake) > 0 && !!normTf(p.timeframe) && !['AUTO', ''].includes(String(p.timeframe || '').toUpperCase()) && !!normExp(p.expiration) && !['auto', ''].includes(String(p.expiration || '').toLowerCase());
const alignment = (prefs = {}, observed = {}) => {
  const amount = num(prefs.tradeAmount ?? prefs.stake), observedAmount = num(observed.amount);
  const wantedTf = normTf(prefs.timeframe), wantedExp = normExp(prefs.expiration);
  const amountOk = amount != null && observedAmount != null && Math.abs(amount - observedAmount) < 0.000001;
  const timeframeOk = !!wantedTf && observed.timeframe === wantedTf;
  const expirationOk = !!wantedExp && observed.expiration === wantedExp;
  return { amountOk, timeframeOk, expirationOk, aligned: amountOk && timeframeOk && expirationOk };
};

async function target() {
  const { scannerState = {}, settings = {} } = await chrome.storage.local.get(['scannerState', 'settings']);
  return { scannerState, settings, tabId: scannerState.targetTabId || null, prefs: settings.scanPreferences || {} };
}
async function ensureScript(tabId) {
  if (!tabId) return false;
  try {
    const ping = await chrome.tabs.sendMessage(tabId, { type: 'ATS_PLATFORM_READ' }).catch(() => null);
    if (ping?.ok) return true;
    await chrome.scripting.executeScript({ target: { tabId }, files: ['src/content/platform-sync.js'], world: 'ISOLATED' });
    return true;
  } catch { return false; }
}
async function mergePlatformState(observed = {}, extra = {}) {
  const { scannerState = {} } = await chrome.storage.local.get('scannerState');
  const { settings = {} } = await chrome.storage.local.get('settings');
  const prefs = settings.scanPreferences || {};
  const aligned = alignment(prefs, observed);
  const patch = {
    ...scannerState,
    platformControls: {
      ...(scannerState.platformControls || {}),
      observed,
      ...aligned,
      configured: configured(prefs),
      updatedAt: Date.now(),
      ...extra
    }
  };
  if (observed.asset) patch.asset = observed.asset;
  if (observed.timeframe) { patch.timeframe = observed.timeframe; patch.analysisTimeframe = observed.timeframe; }
  if (observed.expiration) { patch.expiration = observed.expiration; patch.targetExpiration = observed.expiration; }
  if (observed.amount != null) patch.tradeAmount = observed.amount;
  if (patch.scanner === 'scanning' && configured(prefs) && !aligned.aligned) {
    patch.scanner = 'idle';
    patch.signal = {
      ...(patch.signal || {}), state: 'WAIT', direction: null, score: 0, grade: '—', confirmations: '0 / 6',
      hint: 'Leitura pausada: valor, vela e expiração da CasaTrade precisam ser iguais à configuração do ATS.', provisional: true
    };
  }
  await chrome.storage.local.set({ scannerState: patch });
  return patch.platformControls;
}
async function readPlatform() {
  const { tabId } = await target();
  if (!tabId) return { ok: false, error: 'platform_tab_not_connected' };
  if (!(await ensureScript(tabId))) return { ok: false, error: 'platform_controls_unavailable' };
  try {
    const r = await chrome.tabs.sendMessage(tabId, { type: 'ATS_PLATFORM_READ' });
    if (!r?.ok) return r || { ok: false, error: 'platform_read_failed' };
    const platformControls = await mergePlatformState(r.observed || {}, { lastAction: 'read' });
    return { ok: true, observed: r.observed || {}, platformControls };
  } catch { return { ok: false, error: 'platform_controls_unavailable' }; }
}
async function syncPlatform() {
  const { tabId, prefs } = await target();
  if (!tabId) return { ok: false, error: 'platform_tab_not_connected' };
  if (!(await ensureScript(tabId))) return { ok: false, error: 'platform_controls_unavailable' };
  if (!configured(prefs)) {
    const r = await readPlatform();
    return { ...r, ok: false, error: 'scan_preferences_incomplete' };
  }
  try {
    const r = await chrome.tabs.sendMessage(tabId, { type: 'ATS_PLATFORM_APPLY', preferences: { ...prefs, tradeAmount: num(prefs.tradeAmount ?? prefs.stake) } });
    const observed = r?.after || r?.observed || {};
    const platformControls = await mergePlatformState(observed, {
      lastAction: 'apply', lastApplyAt: Date.now(), lastApplyOk: !!r?.ok,
      applied: r?.applied || {}, attempted: r?.attempted || {}, hints: observed.hints || r?.after?.hints || {}
    });
    return { ...(r || {}), platformControls };
  } catch { return { ok: false, error: 'platform_controls_unavailable' }; }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'ATS_READ_PLATFORM_CONTROLS') {
    readPlatform().then(sendResponse).catch(e => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }
  if (message?.type === 'ATS_SYNC_PLATFORM_PREFERENCES') {
    syncPlatform().then(sendResponse).catch(e => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }
  if (message?.type === 'ATS_CONNECT_ACTIVE_TAB') setTimeout(() => syncPlatform().catch(() => {}), 600);
});

let syncTimer = null;
chrome.storage.onChanged.addListener(changes => {
  if (!changes.settings) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => syncPlatform().catch(() => {}), 180);
});
