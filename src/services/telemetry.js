const INSTALL_KEY = 'atsInstallationId';
const CLIENT_TOKEN_KEY = 'atsClientToken';
const CLIENT_TOKEN_EXP_KEY = 'atsClientTokenExpiresAt';
const TELEMETRY_STATUS_KEY = 'atsTelemetryStatus';
const PUBLIC_API = 'https://ats-control-center-v07-production.up.railway.app';

// Telemetry follows the same fixed commercial backend used by licensing.
const apiBase = () => PUBLIC_API;

const randomInstallationId = () => `ats-install-${crypto.randomUUID()}`;
const legacyRuntimeInstallationId = () => {
  const runtimeId = String(chrome.runtime?.id || '').trim();
  return runtimeId ? `ats-${runtimeId}` : '';
};
let installationIdPromise = null;

export async function installationId() {
  if (installationIdPromise) return installationIdPromise;
  installationIdPromise = (async () => {
    const x = await chrome.storage.local.get(INSTALL_KEY);
    const existing = String(x[INSTALL_KEY] || '').trim();
    const legacyId = legacyRuntimeInstallationId();
    if (existing && existing !== legacyId) return existing;

    const id = randomInstallationId();
    await chrome.storage.local.set({ [INSTALL_KEY]: id });
    const persisted = await chrome.storage.local.get(INSTALL_KEY);
    return String(persisted[INSTALL_KEY] || id).trim() || id;
  })();
  try {
    return await installationIdPromise;
  } finally {
    installationIdPromise = null;
  }
}

export async function clientToken() {
  const x = await chrome.storage.local.get([CLIENT_TOKEN_KEY, CLIENT_TOKEN_EXP_KEY]);
  if (!x[CLIENT_TOKEN_KEY]) return '';
  if (x[CLIENT_TOKEN_EXP_KEY] && Number(x[CLIENT_TOKEN_EXP_KEY]) <= Date.now()) return '';
  return String(x[CLIENT_TOKEN_KEY]);
}

export async function saveClientToken(token = '', expiresAt = null) {
  const value = String(token || '').trim();
  if (!value) {
    await chrome.storage.local.remove([CLIENT_TOKEN_KEY, CLIENT_TOKEN_EXP_KEY]);
    return '';
  }
  await chrome.storage.local.set({
    [CLIENT_TOKEN_KEY]: value,
    [CLIENT_TOKEN_EXP_KEY]: Number(expiresAt) || 0
  });
  return value;
}

export async function clearClientToken() {
  await chrome.storage.local.remove([CLIENT_TOKEN_KEY, CLIENT_TOKEN_EXP_KEY]);
}

async function updateTelemetryStatus(patch = {}) {
  try {
    const x = await chrome.storage.local.get(TELEMETRY_STATUS_KEY);
    const previous = x[TELEMETRY_STATUS_KEY] || {};
    await chrome.storage.local.set({
      [TELEMETRY_STATUS_KEY]: { ...previous, ...patch }
    });
  } catch {}
}

async function post(path, payload, _settings = {}) {
  const heartbeatRequest = path === '/v1/client/heartbeat';
  const attemptAt = Date.now();
  if (heartbeatRequest) await updateTelemetryStatus({ lastSyncAttempt: attemptAt });

  const token = await clientToken();
  if (!token) {
    if (heartbeatRequest) await updateTelemetryStatus({ lastSyncError: 'client_token_missing' });
    return { ok: false, error: 'client_token_missing' };
  }

  try {
    const r = await fetch(`${apiBase()}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`
      },
      body: JSON.stringify(payload || {})
    });
    const data = await r.json().catch(() => ({}));
    const result = { ok: r.ok, status: r.status, ...data };
    if (heartbeatRequest) {
      if (r.ok && data?.ok !== false) {
        await updateTelemetryStatus({
          lastSyncSuccess: Number(data.acceptedAt) || Date.now(),
          lastSyncError: null
        });
      } else {
        await updateTelemetryStatus({ lastSyncError: data?.error || `http_${r.status}` });
      }
    }
    return result;
  } catch {
    if (heartbeatRequest) await updateTelemetryStatus({ lastSyncError: 'telemetry_unreachable' });
    return { ok: false, error: 'telemetry_unreachable' };
  }
}

export async function heartbeat(state = {}, settings = {}) {
  const payload = {
    platformId: state.platformId || null,
    platformName: state.platformName || null,
    connection: state.connection || null,
    scanning: state.scanner === 'scanning',
    asset: state.asset || null,
    marketType: state.instrumentType && state.instrumentType !== 'unknown' ? state.instrumentType : state.marketType || null,
    timeframe: state.analysisTimeframe || state.signal?.timeframe || state.timeframe || null,
    expiration: state.targetExpiration || state.signal?.targetExpiration || state.expiration || null,
    price: state.price ?? null,
    serverTime: state.serverTime ?? null,
    signalState: state.signal?.state || null,
    direction: state.signal?.direction || null,
    score: state.signal?.score ?? null,
    grade: state.signal?.grade || null,
    confirmations: state.signal?.confirmations || null,
    regime: state.signal?.regime || null,
    provisional: !!state.signal?.provisional,
    feedQuality: state.telemetry?.feedQuality ?? null,
    structured: !!state.capabilities?.structuredQuotes,
    latency: state.telemetry?.latency ?? null,
    version: chrome.runtime.getManifest().version
  };
  return post('/v1/client/heartbeat', payload, settings);
}

export async function track(type, data = {}, settings = {}) {
  return post('/v1/client/events', { type, data }, settings);
}
