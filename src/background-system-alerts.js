import { readScannerState, updateScannerState } from './services/scanner-state-atomic.js';
import { storageLocalGet, storageSessionGet, storageSessionSet, tabsUpdate } from './services/chrome-compat.js';
import { qualifiedDecision, explainDecisionAlertEligibility } from './core/signal-alert-qualification.js';
import { updateDecisionAuditDelivery } from './core/decision-audit.js';

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

async function releaseCycleStage(cycleKey, stage) {
  const stored = await storageSessionGet(LEDGER_KEY).catch(() => ({}));
  const rows = Array.isArray(stored?.[LEDGER_KEY]) ? stored[LEDGER_KEY] : [];
  const field = stage + 'At';
  let changed = false;
  const updated = rows.map(row => {
    if (row?.cycleKey !== cycleKey || !row[field]) return row;
    changed = true;
    const next = { ...row };
    delete next[field];
    return next;
  }).filter(row => row && (row.preAt || row.finalAt));
  if (changed) await storageSessionSet({ [LEDGER_KEY]: updated }).catch(() => {});
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

async function recordDeliveryAudit(state = {}, stage = null, delivery = {}) {
  const stateAudit = state.decisionAudit || {};
  const stateLatest = stateAudit.latest || null;
  const cycleKey = clean(state.professionalDecision?.cycleKey || stateLatest?.cycleKey || '');
  if (!stateLatest || !stateLatest.id || (cycleKey && stateLatest.cycleKey !== cycleKey)) return;
  const proposed = {
    ...delivery,
    stage: stage || delivery.stage || null,
    auditId: stateLatest.id,
    attempted: delivery.attempted === true,
    at: Number(delivery.at || Date.now())
  };
  const prior = stateLatest.delivery || {};
  if (prior.auditId === proposed.auditId
    && prior.stage === proposed.stage
    && prior.status === proposed.status
    && prior.reason === proposed.reason
    && prior.notification === proposed.notification
    && prior.sound === proposed.sound) return;

  await updateScannerState(current => {
    const audit = current.decisionAudit || {};
    const latest = audit.latest || null;
    if (!latest || latest.id !== stateLatest.id) return current;
    const currentDelivery = latest.delivery || {};
    if (currentDelivery.auditId === proposed.auditId
      && currentDelivery.stage === proposed.stage
      && currentDelivery.status === proposed.status
      && currentDelivery.reason === proposed.reason
      && currentDelivery.notification === proposed.notification
      && currentDelivery.sound === proposed.sound) return current;
    return {
      ...current,
      decisionAudit: updateDecisionAuditDelivery(audit, { id: latest.id, cycleKey: latest.cycleKey }, proposed)
    };
  }).catch(() => {});
}

function terminalDeliveryForSameAudit(state = {}, stage = null) {
  const latest = state.decisionAudit?.latest || {};
  const delivery = latest.delivery || {};
  if (!latest.id || delivery.auditId !== latest.id || (stage && delivery.stage !== stage)) return false;
  return ['delivered','failed','disabled','deduplicated','not_eligible'].includes(delivery.status);
}

async function dispatchForState(state = {}) {
  const eligibility = explainDecisionAlertEligibility(state);
  const event = qualifiedDecision(state);
  const latest = state.decisionAudit?.latest || {};
  const existingDelivery = latest.delivery || {};

  if (!event) {
    if (latest.id && !terminalDeliveryForSameAudit(state, existingDelivery.stage || null)) {
      await recordDeliveryAudit(state, null, {
        status: 'not_eligible',
        reason: eligibility.reason,
        attempted: false,
        notification: 'not_attempted',
        sound: 'not_attempted'
      });
    }
    return;
  }

  if (terminalDeliveryForSameAudit(state, event.stage)) return;

  const notificationsEnabled = prefs.notificationsEnabled !== false;
  const soundEnabled = prefs.alertLevel !== 'off';
  if (!notificationsEnabled && !soundEnabled) {
    await recordDeliveryAudit(state, event.stage, {
      status: 'disabled',
      reason: 'Notificações e som estão desativados nas preferências.',
      attempted: false,
      notification: 'disabled',
      sound: 'disabled'
    });
    return;
  }

  if (!(await claimCycleStage(event.cycleKey, event.stage))) {
    await recordDeliveryAudit(state, event.stage, {
      status: 'deduplicated',
      reason: 'Este estágio da vela já foi registrado; alerta duplicado evitado.',
      attempted: false,
      notification: 'deduplicated',
      sound: 'deduplicated'
    });
    return;
  }

  await recordDeliveryAudit(state, event.stage, {
    status: 'attempting',
    reason: 'Sinal elegível; tentando entregar notificação e/ou som.',
    attempted: true,
    notification: notificationsEnabled ? 'attempting' : 'disabled',
    sound: soundEnabled ? 'attempting' : 'disabled'
  });

  let notificationDelivered = false;
  let soundDelivered = false;
  if (notificationsEnabled) {
    notificationDelivered = await createNotification(notificationId(event, state), {
      type: 'basic',
      iconUrl: chrome.runtime.getURL(ICON_PATH),
      title: event.title,
      message: event.message,
      priority: event.stage === 'final' ? 2 : 1
    });
  }
  if (soundEnabled) soundDelivered = await playAlertSound(event.stage);
  const delivered = notificationDelivered || soundDelivered;

  if (!delivered) await releaseCycleStage(event.cycleKey, event.stage);
  await recordDeliveryAudit(state, event.stage, {
    status: delivered ? 'delivered' : 'failed',
    reason: delivered
      ? 'Alerta entregue por pelo menos um canal.'
      : 'Falha nos dois canais de saída; estágio liberado para nova tentativa em um ciclo atualizado.',
    attempted: true,
    notification: !notificationsEnabled ? 'disabled' : notificationDelivered ? 'delivered' : 'failed',
    sound: !soundEnabled ? 'disabled' : soundDelivered ? 'delivered' : 'failed'
  });
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
