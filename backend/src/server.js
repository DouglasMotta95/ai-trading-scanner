import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const API_KEY = process.env.ATS_API_KEY || '';
const ADMIN_KEY = process.env.ATS_ADMIN_KEY || API_KEY;
const ADMIN_SESSION_DAYS = Math.max(1, Number(process.env.ADMIN_SESSION_DAYS || 30));
const ALLOWED_ORIGINS = (process.env.CORS_ORIGINS || '').split(',').map(x => x.trim()).filter(Boolean);
const DATA_DIR = path.resolve(__dirname, '../data');
const LICENSE_FILE = path.join(DATA_DIR, 'licenses.json');
const ADMIN_DIR = path.resolve(__dirname, '../../apps/admin-dashboard');
const SESSION_COOKIE = 'ats_admin_session';
const sessions = new Map();
const events = [];
const adminAudit = [];
const licenses = new Map();

const PLANS = {
  trial: { id: 'trial', label: 'Trial', dailySignals: Number(process.env.PLAN_TRIAL_SIGNALS || 3), deviceLimit: 1 },
  starter: { id: 'starter', label: 'Starter', dailySignals: Number(process.env.PLAN_STARTER_SIGNALS || 6), deviceLimit: 1 },
  pro: { id: 'pro', label: 'Pro', dailySignals: Number(process.env.PLAN_PRO_SIGNALS || 20), deviceLimit: Number(process.env.PLAN_PRO_DEVICES || 2) },
  unlimited: { id: 'unlimited', label: 'Unlimited', dailySignals: null, deviceLimit: Number(process.env.PLAN_UNLIMITED_DEVICES || 5) }
};

const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const str = (v, n = 128) => typeof v === 'string' && v.length > 0 && v.length <= n;
const today = () => new Date().toISOString().slice(0, 10);
const now = () => Date.now();
const origin = req => {
  const value = req.headers.origin;
  if (!value) return '';
  if (ALLOWED_ORIGINS.includes('*')) return value;
  return ALLOWED_ORIGINS.includes(value) ? value : null;
};
const baseHeaders = req => {
  const allowed = origin(req);
  const h = {
    'content-type': 'application/json',
    'access-control-allow-headers': 'content-type,x-api-key,x-admin-key',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'vary': 'Origin'
  };
  if (allowed) {
    h['access-control-allow-origin'] = allowed;
    h['access-control-allow-credentials'] = 'true';
  }
  return h;
};
const json = (req, res, status, data, extraHeaders = {}) => {
  res.writeHead(status, { ...baseHeaders(req), ...extraHeaders });
  res.end(status === 204 ? '' : JSON.stringify(data));
};
const body = req => new Promise((resolve, reject) => {
  let data = '';
  req.on('data', chunk => {
    data += chunk;
    if (data.length > 65536) {
      reject(new Error('too_large'));
      req.destroy();
    }
  });
  req.on('end', () => {
    try { resolve(data ? JSON.parse(data) : {}); }
    catch { reject(new Error('invalid_json')); }
  });
});
const safeEq = (raw, key) => {
  if (!key || typeof raw !== 'string') return false;
  const a = Buffer.from(raw), b = Buffer.from(key);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
const auth = req => safeEq(req.headers['x-api-key'], API_KEY);
const only = (o, keys) => Object.keys(o).every(k => keys.includes(k));
const b64 = value => Buffer.from(value).toString('base64url');
const unb64 = value => Buffer.from(value, 'base64url').toString('utf8');
const adminSessionSecret = () => crypto.createHash('sha256').update(`ats-admin-session:${ADMIN_KEY}`).digest();
const sign = value => crypto.createHmac('sha256', adminSessionSecret()).update(value).digest('base64url');
const parseCookies = req => Object.fromEntries(String(req.headers.cookie || '').split(';').map(v => v.trim()).filter(Boolean).map(v => {
  const i = v.indexOf('=');
  return i < 0 ? [v, ''] : [v.slice(0, i), decodeURIComponent(v.slice(i + 1))];
}));
function createAdminSessionToken() {
  const payload = b64(JSON.stringify({ iat: now(), exp: now() + ADMIN_SESSION_DAYS * 86400000, nonce: crypto.randomBytes(8).toString('hex') }));
  return `${payload}.${sign(payload)}`;
}
function validAdminSession(req) {
  if (!ADMIN_KEY) return false;
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return false;
  const [payload, signature] = token.split('.');
  if (!payload || !signature || !safeEq(signature, sign(payload))) return false;
  try {
    const data = JSON.parse(unb64(payload));
    return Number(data.exp) > now();
  } catch { return false; }
}
const adminAuth = req => safeEq(req.headers['x-admin-key'], ADMIN_KEY) || validAdminSession(req);
const secureCookie = req => String(req.headers['x-forwarded-proto'] || '').toLowerCase() === 'https' || !!req.socket.encrypted;
const sessionCookie = req => `${SESSION_COOKIE}=${encodeURIComponent(createAdminSessionToken())}; Path=/; Max-Age=${ADMIN_SESSION_DAYS * 86400}; HttpOnly; SameSite=Lax${secureCookie(req) ? '; Secure' : ''}`;
const clearSessionCookie = req => `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secureCookie(req) ? '; Secure' : ''}`;

function audit(action, data = {}) {
  adminAudit.unshift({ id: crypto.randomUUID(), action, at: now(), ...data });
  if (adminAudit.length > 200) adminAudit.length = 200;
}

function publicLicense(l) {
  const plan = PLANS[l.plan] || PLANS.starter;
  const used = Number(l.usage?.[today()] || 0);
  const limit = plan.dailySignals;
  return {
    key: l.key,
    status: l.status,
    plan: l.plan,
    planLabel: plan.label,
    dailyLimit: limit,
    usedToday: used,
    remainingToday: limit == null ? null : Math.max(0, limit - used),
    expiresAt: l.expiresAt || null,
    customerName: l.customerName || '',
    email: l.email || '',
    deviceLimit: plan.deviceLimit,
    devices: (l.devices || []).length,
    createdAt: l.createdAt,
    updatedAt: l.updatedAt || l.createdAt,
    isTrial: l.plan === 'trial'
  };
}
function loadLicenses() {
  try {
    const rows = JSON.parse(fs.readFileSync(LICENSE_FILE, 'utf8'));
    for (const l of Array.isArray(rows) ? rows : []) if (l?.key) licenses.set(l.key, l);
  } catch {}
}
function saveLicenses() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(LICENSE_FILE, JSON.stringify([...licenses.values()], null, 2));
  } catch {}
}
function sessionPayload(b) {
  if (!isObj(b) || !only(b, ['installationId', 'platform', 'scanning', 'version'])) return null;
  if (!str(b.installationId, 128) || ('platform' in b && b.platform !== null && !str(b.platform, 64)) || ('scanning' in b && typeof b.scanning !== 'boolean') || ('version' in b && b.version !== null && !str(b.version, 32))) return null;
  return { installationId: b.installationId, platform: b.platform ?? null, scanning: b.scanning ?? false, version: b.version ?? null };
}
function eventPayload(b) {
  if (!isObj(b) || !only(b, ['installationId', 'type', 'data'])) return null;
  if (!str(b.installationId, 128) || !str(b.type, 64) || ('data' in b && !isObj(b.data))) return null;
  const data = b.data || {};
  if (JSON.stringify(data).length > 8192) return null;
  return { installationId: b.installationId, type: b.type, data };
}
function licenseInput(b) {
  if (!isObj(b) || !str(b.licenseKey, 96) || !str(b.installationId, 128)) return null;
  return {
    licenseKey: b.licenseKey.trim().toUpperCase(),
    installationId: b.installationId,
    version: typeof b.version === 'string' ? b.version.slice(0, 32) : null,
    type: typeof b.type === 'string' ? b.type.slice(0, 32) : null
  };
}
function licenseCheck(p, { consume = false } = {}) {
  const l = licenses.get(p.licenseKey);
  if (!l) return { status: 404, error: 'license_not_found' };
  if (l.status !== 'active') return { status: 403, error: 'license_inactive' };
  if (l.expiresAt && Date.parse(l.expiresAt) <= now()) return { status: 403, error: 'license_expired' };
  const plan = PLANS[l.plan] || PLANS.starter;
  l.devices ??= [];
  let device = l.devices.find(x => x.installationId === p.installationId);
  if (!device) {
    if (l.devices.length >= plan.deviceLimit) return { status: 403, error: 'device_limit_reached' };
    device = { installationId: p.installationId, createdAt: now(), lastSeen: now(), version: p.version || null };
    l.devices.push(device);
  } else {
    device.lastSeen = now();
    if (p.version) device.version = p.version;
  }
  l.usage ??= {};
  const day = today(), used = Number(l.usage[day] || 0), limit = plan.dailySignals;
  if (consume && p.type === 'signal') {
    if (limit != null && used >= limit) return { status: 429, error: 'daily_limit_reached', license: publicLicense(l) };
    l.usage[day] = used + 1;
  }
  l.updatedAt = now();
  saveLicenses();
  return { status: 200, license: publicLicense(l) };
}
function newLicenseKey() {
  return `ATS-${crypto.randomBytes(3).toString('hex').toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
}
function createLicense({ customerName = '', email = '', plan = 'starter', days = 30 }) {
  if (!PLANS[plan]) return null;
  const createdAt = now();
  const validDays = Number(days);
  const l = {
    key: newLicenseKey(), plan, status: 'active',
    customerName: String(customerName).slice(0, 120), email: String(email).slice(0, 160),
    createdAt, updatedAt: createdAt,
    expiresAt: Number.isFinite(validDays) && validDays > 0 ? new Date(createdAt + validDays * 86400000).toISOString() : null,
    devices: [], usage: {}
  };
  licenses.set(l.key, l);
  saveLicenses();
  audit(plan === 'trial' ? 'trial_created' : 'license_created', { licenseKey: l.key, customerName: l.customerName, plan });
  return publicLicense(l);
}
function resetLicense(l, mode = 'full') {
  l.devices ??= [];
  l.usage ??= {};
  if (mode === 'full' || mode === 'devices') l.devices = [];
  if (mode === 'full' || mode === 'usage') l.usage[today()] = 0;
  if (mode === 'full') l.status = 'active';
  l.updatedAt = now();
  saveLicenses();
  audit(`license_reset_${mode}`, { licenseKey: l.key, customerName: l.customerName });
  return publicLicense(l);
}
function renewLicense(l, days = 30) {
  const amount = Math.max(1, Number(days) || 30);
  const current = l.expiresAt ? Date.parse(l.expiresAt) : NaN;
  const base = Number.isFinite(current) && current > now() ? current : now();
  l.expiresAt = new Date(base + amount * 86400000).toISOString();
  l.status = 'active';
  l.updatedAt = now();
  saveLicenses();
  audit('license_renewed', { licenseKey: l.key, customerName: l.customerName, days: amount });
  return publicLicense(l);
}
function serveAdmin(res, file, type) {
  try {
    const data = fs.readFileSync(path.join(ADMIN_DIR, file));
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store, max-age=0' });
    res.end(data);
    return true;
  } catch { return false; }
}

loadLicenses();

const server = http.createServer(async (req, res) => {
  if (req.headers.origin && origin(req) === null) return json(req, res, 403, { error: 'origin_not_allowed' });
  if (req.method === 'OPTIONS') return json(req, res, 204, {});
  try {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;

    if (pathname === '/') { res.writeHead(302, { location: '/admin/' }); return res.end(); }
    if (pathname === '/admin') { res.writeHead(302, { location: '/admin/' }); return res.end(); }
    if (pathname === '/admin/') return serveAdmin(res, 'index.html', 'text/html; charset=utf-8') || json(req, res, 404, { error: 'admin_not_found' });
    if (pathname === '/admin/app.js') return serveAdmin(res, 'app.js', 'text/javascript; charset=utf-8') || json(req, res, 404, { error: 'admin_asset_not_found' });
    if (pathname === '/admin/styles.css') return serveAdmin(res, 'styles.css', 'text/css; charset=utf-8') || json(req, res, 404, { error: 'admin_asset_not_found' });
    if (pathname === '/health') return json(req, res, 200, { ok: true, service: 'ats-api', time: now(), authConfigured: !!API_KEY, adminAuthConfigured: !!ADMIN_KEY, licenses: licenses.size, version: '0.5.0' });

    if (pathname === '/v1/admin/auth/login' && req.method === 'POST') {
      if (!ADMIN_KEY) return json(req, res, 503, { error: 'admin_key_not_configured' });
      const b = await body(req);
      if (!safeEq(b.adminKey, ADMIN_KEY)) return json(req, res, 401, { error: 'unauthorized' });
      audit('admin_login');
      return json(req, res, 200, { ok: true, expiresInDays: ADMIN_SESSION_DAYS }, { 'set-cookie': sessionCookie(req) });
    }
    if (pathname === '/v1/admin/auth/logout' && req.method === 'POST') {
      return json(req, res, 200, { ok: true }, { 'set-cookie': clearSessionCookie(req) });
    }
    if (pathname === '/v1/admin/auth/status' && req.method === 'GET') {
      if (!adminAuth(req)) return json(req, res, ADMIN_KEY ? 401 : 503, { authenticated: false, error: ADMIN_KEY ? 'unauthorized' : 'admin_key_not_configured' });
      return json(req, res, 200, { authenticated: true, sessionDays: ADMIN_SESSION_DAYS });
    }

    const protectedRoute = (pathname === '/v1/session' && req.method === 'POST') || (pathname === '/v1/events' && req.method === 'POST');
    if (protectedRoute && !auth(req)) return json(req, res, API_KEY ? 401 : 503, { error: API_KEY ? 'unauthorized' : 'api_key_not_configured' });
    if (pathname.startsWith('/v1/admin/') && !adminAuth(req)) return json(req, res, ADMIN_KEY ? 401 : 503, { error: ADMIN_KEY ? 'unauthorized' : 'admin_key_not_configured' });

    if (pathname === '/v1/license/activate' && req.method === 'POST') {
      const p = licenseInput(await body(req));
      if (!p) return json(req, res, 422, { error: 'invalid_license_request' });
      const r = licenseCheck(p);
      return json(req, res, r.status, r.error ? { ok: false, error: r.error, license: r.license } : { ok: true, license: r.license });
    }
    if (pathname === '/v1/license/validate' && req.method === 'POST') {
      const p = licenseInput(await body(req));
      if (!p) return json(req, res, 422, { error: 'invalid_license_request' });
      const r = licenseCheck(p);
      return json(req, res, r.status, r.error ? { ok: false, error: r.error, license: r.license } : { ok: true, license: r.license });
    }
    if (pathname === '/v1/license/consume' && req.method === 'POST') {
      const p = licenseInput(await body(req));
      if (!p || p.type !== 'signal') return json(req, res, 422, { error: 'invalid_usage_request' });
      const r = licenseCheck(p, { consume: true });
      return json(req, res, r.status, r.error ? { ok: false, error: r.error, license: r.license } : { ok: true, license: r.license, usage: { dailyLimit: r.license.dailyLimit, usedToday: r.license.usedToday, remainingToday: r.license.remainingToday } });
    }
    if (pathname === '/v1/session' && req.method === 'POST') {
      const p = sessionPayload(await body(req));
      if (!p) return json(req, res, 422, { error: 'invalid_session' });
      sessions.set(p.installationId, { ...sessions.get(p.installationId), ...p, lastSeen: now() });
      return json(req, res, 200, { ok: true, installationId: p.installationId });
    }
    if (pathname === '/v1/events' && req.method === 'POST') {
      const p = eventPayload(await body(req));
      if (!p) return json(req, res, 422, { error: 'invalid_event' });
      events.push({ ...p, id: crypto.randomUUID(), createdAt: now() });
      if (events.length > 10000) events.shift();
      return json(req, res, 201, { ok: true });
    }

    if (pathname === '/v1/admin/plans' && req.method === 'GET') return json(req, res, 200, { plans: Object.values(PLANS) });
    if (pathname === '/v1/admin/licenses' && req.method === 'GET') return json(req, res, 200, { licenses: [...licenses.values()].map(publicLicense).sort((a, b) => b.createdAt - a.createdAt) });
    if (pathname === '/v1/admin/licenses' && req.method === 'POST') {
      const b = await body(req);
      const license = createLicense({ customerName: b.customerName, email: b.email, plan: String(b.plan || 'starter'), days: Number(b.days || 30) });
      if (!license) return json(req, res, 422, { error: 'invalid_plan' });
      return json(req, res, 201, { ok: true, license });
    }
    if (pathname === '/v1/admin/trials' && req.method === 'POST') {
      const b = await body(req);
      const license = createLicense({ customerName: b.customerName, email: b.email, plan: 'trial', days: Number(b.days || 3) });
      return json(req, res, 201, { ok: true, license });
    }

    const renew = pathname.match(/^\/v1\/admin\/licenses\/([^/]+)\/renew$/);
    if (renew && req.method === 'POST') {
      const key = decodeURIComponent(renew[1]).toUpperCase();
      const l = licenses.get(key);
      if (!l) return json(req, res, 404, { error: 'license_not_found' });
      const b = await body(req);
      return json(req, res, 200, { ok: true, license: renewLicense(l, b.days) });
    }

    const action = pathname.match(/^\/v1\/admin\/licenses\/([^/]+)\/(revoke|activate|reset|reset-devices|reset-usage)$/);
    if (action && req.method === 'POST') {
      const key = decodeURIComponent(action[1]).toUpperCase();
      const l = licenses.get(key);
      if (!l) return json(req, res, 404, { error: 'license_not_found' });
      const op = action[2];
      let license;
      if (op === 'revoke' || op === 'activate') {
        l.status = op === 'activate' ? 'active' : 'revoked';
        l.updatedAt = now();
        saveLicenses();
        audit(op === 'activate' ? 'license_activated' : 'license_revoked', { licenseKey: l.key, customerName: l.customerName });
        license = publicLicense(l);
      } else {
        license = resetLicense(l, op === 'reset-devices' ? 'devices' : op === 'reset-usage' ? 'usage' : 'full');
      }
      return json(req, res, 200, { ok: true, license });
    }

    if (pathname === '/v1/admin/clients' && req.method === 'GET') {
      const clients = [];
      for (const l of licenses.values()) for (const d of l.devices || []) clients.push({
        licenseKey: l.key, plan: l.plan, planLabel: PLANS[l.plan]?.label || l.plan,
        customerName: l.customerName || '', email: l.email || '', installationId: d.installationId,
        lastSeen: d.lastSeen || 0, online: now() - (d.lastSeen || 0) < 60000, version: d.version || null
      });
      return json(req, res, 200, { clients: clients.sort((a, b) => b.lastSeen - a.lastSeen) });
    }
    if (pathname === '/v1/admin/audit' && req.method === 'GET') return json(req, res, 200, { events: adminAudit.slice(0, 50) });

    if (pathname === '/v1/admin/metrics' && req.method === 'GET') {
      const ts = now();
      const active = [...sessions.values()].filter(s => ts - s.lastSeen < 60000);
      const groups = {};
      for (const s of active) { const key = s.platform || 'unknown'; groups[key] = (groups[key] || 0) + 1; }
      const lic = [...licenses.values()].map(publicLicense);
      const devices = [];
      for (const l of licenses.values()) for (const d of l.devices || []) devices.push(d);
      return json(req, res, 200, {
        installations: sessions.size,
        online: active.length,
        licensedOnline: devices.filter(d => ts - (d.lastSeen || 0) < 60000).length,
        scanners: active.filter(s => s.scanning).length,
        events: events.length,
        licenses: lic.length,
        activeLicenses: lic.filter(x => x.status === 'active' && (!x.expiresAt || Date.parse(x.expiresAt) > ts)).length,
        activeTrials: lic.filter(x => x.plan === 'trial' && x.status === 'active' && (!x.expiresAt || Date.parse(x.expiresAt) > ts)).length,
        revokedLicenses: lic.filter(x => x.status === 'revoked').length,
        expiredLicenses: lic.filter(x => x.expiresAt && Date.parse(x.expiresAt) <= ts).length,
        expiringSoon: lic.filter(x => x.status === 'active' && x.expiresAt && Date.parse(x.expiresAt) > ts && Date.parse(x.expiresAt) <= ts + 3 * 86400000).length,
        signalsToday: lic.reduce((n, x) => n + x.usedToday, 0),
        platforms: Object.entries(groups).map(([name, online]) => ({ name, online })),
        version: '0.5.0'
      });
    }

    return json(req, res, 404, { error: 'not_found' });
  } catch (e) {
    return json(req, res, e.message === 'too_large' ? 413 : 400, { error: e.message || 'bad_request' });
  }
});

server.listen(PORT, () => console.log(`ATS API :${PORT} • admin http://localhost:${PORT}/admin/`));
