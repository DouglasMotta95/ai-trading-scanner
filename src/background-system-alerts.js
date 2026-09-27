import { readScannerState } from './services/scanner-state-atomic.js';
import { storageLocalGet, storageSessionGet, storageSessionSet, tabsUpdate } from './services/chrome-compat.js';

const PREF_KEY = 'atsScannerUiPreferences';
const LEDGER_KEY = 'atsSystemAlertLedgerV1';
const NOTIFICATION_PREFIX = 'ats-signal-';
const ICON_PATH = 'src/assets/icon128.png';
const OFFSCREEN_PATH = 'src/offscreen/alert-audio.html';
const DEFAULT_PREFS = Object.freeze({ notificationsEnabled: true, alertLevel: 'discrete' });

let prefs = { ...DEFAULT_PREFS };
let alertQueue = Promise.resolve();

const clean = value => String(value ?? '').trim();
const num = value => value == null || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null;

function normalizePrefs(raw = {}) {
  const level = ['off', 'discrete', 'strong'].includes(raw.alertLevel) ? raw.alertLevel : DEFAULT_PREFS.alertLevel;
  return {
    notificationsEnabled: raw.notificationsEnabled !== false,
    alertLevel: level
  };
}

async function refreshPrefs() {
  const stored = await storageLocalGet(PREF_KEY).catch(() => ({}));
  prefs = normalizePrefs(stored?.[PREF_KEY] || {});
}

function qualifiedDecision(state = {}) {
  const decision = state.professionalDecision || {};
  const seconds = num(decision.secondsRemaining);
  const cycleKey = clean(decision.cycleKey);

  if (state.scanner !== 'scanning' || state.connection !== 'online') return null;
  if (decision.timeReady !== true || decision.expirationReady !== true) return null;
  if (clean(decision.timeframe).toUpperCase() !== 'M1') return null;
  if (clean(decision.actualExpiration).toLowerCase() !== '60s') return null;
  if (!cycleKey || seconds == null || seconds <= 0 || seconds > 30) return null;

  const ui = clean(decision.uiState).toUpperCase();
  const direction = clean(decision.direction).toUpperCase();

  if (seconds > 10) {
    if (!['POSSIBLE_BUY', 'POSSIBLE_SELL'].includes(ui) || !['BUY', 'SELL'].includes(direction)) return null;
    return {
      stage: 'pre',
      cycleKey,
      seconds,
      label: direction === 'BUY' ? 'COMPRA' : 'VENDA',
      title: 'Pré-sinal',
      message: 'Possível ' + (direction === 'BUY' ? 'COMPRA' : 'VENDA') + ' — ' + clean(state.asset || 'ATIVO') + ' M1'
    };
  }

  const finalLabel = ui === 'ENTER_BUY' && direction === 'BUY'
    ? 'COMPRA'
    : ui === 'ENTER_SELL' && direction === 'SELL'
      ? 'VENDA'
      : 'AGUARDAR';

  return {
    stage: 'final',
    cycleKey,
    seconds,
    label: finalLabel,
    title: 'Decisão',
    message: finalLabel + ' — ' + clean(state.asset || 'ATIVO')
  };
}

function hashKey(value = '') {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function notificationId(event, state = {}) {
  const tabId = Number(state.targetTabId || 0);
  return NOTIFICATION_PREFIX + event.stage + '-' + tabId + '-' + hashKey(event.cycleKey);
}

async function claimCycleStage(cycleKey, stage) {
  const stored = await storageSessionGet(LEDGER_KEY).catch(() => ({}));
  const rows = Array.isArray(stored?.[LEDGER_KEY]) ? stored[LEDGER_KEY] : [];
  const existing = rows.find(row => row?.cycleKey === cycleKey);
  if (existing?.[stage + 'At']) return false;

  const at = Date.now();
  const updated = existing
    ? rows.map(row => row?.cycleKey === cycleKey ? { ...row, [stage + 'At']: at } : row)
    : [...rows, { cycleKey, [stage + 'At']: at }];

  const compact = updated
    .sort((a, b) => Math.max(Number(a.preAt || 0), Number(a.finalAt || 0)) - Math.max(Number(b.preAt || 0), Number(b.finalAt || 0)))
    .slice(-40);

  await storageSessionSet({ [LEDGER_KEY]: compact }).catch(() => {});
  return true;
}

function createNotification(id, options) {
  return new Promise(resolve => {
    if (!chrome.notifications?.create) return resolve(false);
    let settled = false;
    const done = value => {
      if (settled) return;
      settled = true;
      try {
        if (chrome.runtime?.lastError) return resolve(false);
      } catch {}
      resolve(value !== false);
    };
    try {
      const returned = chrome.notifications.create(id, options, createdId => done(createdId || true));
      if (returned && typeof returned.then === 'function') returned.then(value => done(value || true), () => done(false));
    } catch {
      done(false);
    }
  });
}

async function ensureOffscreenAudio() {
  if (!chrome.offscreen?.createDocument) return false;
  const documentUrl = chrome.runtime.getURL(OFFSCREEN_PATH);

  try {
    if (chrome.runtime?.getContexts) {
      const contexts = await chrome.runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT'],
        documentUrls: [documentUrl]
      });
      if (Array.isArray(contexts) && contexts.length) return true;
    }
  } catch {}

  try {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_PATH,
      reasons: ['AUDIO_PLAYBACK'],
      justification: 'Tocar os alertas locais de pré-sinal e decisão final do scanner.'
    });
    return true;
  } catch (error) {
    return /single offscreen|already exists/i.test(String(error?.message || error));
  }
}

async function playAlertSound(stage) {
  if (!(await ensureOffscreenAudio())) return false;
  try {
    await chrome.runtime.sendMessage({
      type: 'ATS_PLAY_ALERT_SOUND',
      kind: stage === 'pre' ? 'pre' : 'final'
    });
    return true;
  } catch {
    return false;
  }
}

async function dispatchForState(state = {}) {
  const event = qualifiedDecision(state);
  if (!event) return;

  const notificationsEnabled = prefs.notificationsEnabled !== false;
  const soundEnabled = prefs.alertLevel !== 'off';
  if (!notificationsEnabled && !soundEnabled) return;
  if (!(await claimCycleStage(event.cycleKey, event.stage))) return;

  if (notificationsEnabled) {
    await createNotification(notificationId(event, state), {
      type: 'basic',
      iconUrl: chrome.runtime.getURL(ICON_PATH),
      title: event.title,
      message: event.message,
      priority: event.stage === 'final' ? 2 : 1
    });
  }

  if (soundEnabled) await playAlertSound(event.stage);
}

function queueState(state = {}) {
  alertQueue = alertQueue
    .then(() => dispatchForState(state))
    .catch(() => {});
  return alertQueue;
}

function tabIdFromNotification(id = '') {
  const match = String(id).match(/^ats-signal-(?:pre|final)-(\d+)-/);
  return match ? Number(match[1]) : 0;
}

async function focusScannerFromNotification(id) {
  const tabId = tabIdFromNotification(id);
  if (tabId > 0) {
    const openPromise = chrome.sidePanel?.open
      ? chrome.sidePanel.open({ tabId }).catch(() => undefined)
      : Promise.resolve();

    await tabsUpdate(tabId, { active: true }).catch(() => {});
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab?.windowId != null && chrome.windows?.update) {
        await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
      }
    } catch {}
    await openPromise;
  }

  try { await chrome.notifications?.clear?.(id); } catch {}
}

chrome.storage?.onChanged?.addListener?.((changes, area) => {
  if (area !== 'local') return;

  if (changes[PREF_KEY]) {
    prefs = normalizePrefs(changes[PREF_KEY].newValue || {});
    readScannerState().then(queueState).catch(() => {});
  }

  if (changes.scannerState?.newValue) queueState(changes.scannerState.newValue || {});
});

chrome.notifications?.onClicked?.addListener?.(id => {
  if (!String(id).startsWith(NOTIFICATION_PREFIX)) return;
  focusScannerFromNotification(id).catch(() => {});
});

refreshPrefs()
  .then(() => readScannerState())
  .then(queueState)
  .catch(() => {});
