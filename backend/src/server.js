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
const DATA_DIR = path.resolve(process.env.ATS_DATA_DIR || path.resolve(__dirname, '../data'));
const LICENSE_FILE = path.join(DATA_DIR, 'licenses.json');
const STATE_FILE = path.join(DATA_DIR, 'admin-state.json');
const ADMIN_DIR = path.resolve(__dirname, '../../apps/admin-dashboard');
const SESSION_COOKIE = 'ats_admin_session';
const sessions = new Map();
const events = [];
const licenses = new Map();

const DEFAULT_PLANS = {
  trial: { id: 'trial', label: 'Trial', dailySignals: 2, totalSignals: 2, deviceLimit: 1, price: 0, defaultDays: 3 },
  starter: { id: 'starter', label: 'Starter', dailySignals: 10, totalSignals: null, deviceLimit: 1, price: 0, defaultDays: 30 },
  pro: { id: 'pro', label: 'Pro', dailySignals: 30, totalSignals: null, deviceLimit: 1, price: 0, defaultDays: 30 },
  unlimited: { id: 'unlimited', label: 'Unlimited', dailySignals: null, totalSignals: null, deviceLimit: 1, price: 0, defaultDays: 30 }
};
const envPlans = {
  trial: { dailySignals: Number(process.env.PLAN_TRIAL_SIGNALS || 2), totalSignals: Number(process.env.PLAN_TRIAL_TOTAL_SIGNALS || 2) },
  starter: { dailySignals: Number(process.env.PLAN_STARTER_SIGNALS || 10) },
  pro: { dailySignals: Number(process.env.PLAN_PRO_SIGNALS || 30) },
  unlimited: { dailySignals: null }
};
let PLANS = Object.fromEntries(Object.entries(DEFAULT_PLANS).map(([id, p]) => [id, { ...p, ...envPlans[id], deviceLimit: 1 }]));
let adminAudit = [];
let securityEvents = [];
let adminSettings = {
  productName: 'AI Trading Scanner',
  brandShort: 'ATS',
  whatsapp: '',
  supportText: 'Seu acesso foi preparado. Qualquer dúvida, fale comigo.',
  trialEnabled: true,
  currency: 'BRL'
};

const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const str = (v, n = 128) => typeof v === 'string' && v.length > 0 && v.length <= n;
const today = () => new Date().toISOString().slice(0, 10);
const now = () => Date.now();
const totalUsage = l => Object.values(l?.usage || {}).reduce((sum, value) => sum + Math.max(0, Number(value) || 0), 0);
const planOf = id => PLANS[id] || PLANS.starter;
const cleanNumber = (v, fallback = 0) => Number.isFinite(Number(v)) ? Number(v) : fallback;
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
    if (data.length > 131072) { reject(new Error('too_large')); req.destroy(); }
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
  try { return Number(JSON.parse(unb64(payload)).exp) > now(); }
  catch { return false; }
}
const adminAuth = req => safeEq(req.headers['x-admin-key'], ADMIN_KEY) || validAdminSession(req);
const secureCookie = req => String(req.headers['x-forwarded-proto'] || '').toLowerCase() === 'https' || !!req.socket.encrypted;
const sessionCookie = req => `${SESSION_COOKIE}=${encodeURIComponent(createAdminSessionToken())}; Path=/; Max-Age=${ADMIN_SESSION_DAYS * 86400}; HttpOnly; SameSite=Lax${secureCookie(req) ? '; Secure' : ''}`;
const clearSessionCookie = req => `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secureCookie(req) ? '; Secure' : ''}`;

function persistState() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({ plans: PLANS, settings: adminSettings, audit: adminAudit.slice(0, 500), security: securityEvents.slice(0, 500) }, null, 2));
  } catch {}
}
function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (isObj(s.plans)) {
      for (const id of Object.keys(DEFAULT_PLANS)) if (isObj(s.plans[id])) PLANS[id] = { ...PLANS[id], ...s.plans[id], id, deviceLimit: 1 };
    }
    if (isObj(s.settings)) adminSettings = { ...adminSettings, ...s.settings };
    if (Array.isArray(s.audit)) adminAudit = s.audit.slice(0, 500);
    if (Array.isArray(s.security)) securityEvents = s.security.slice(0, 500);
  } catch {}
}
function audit(action, data = {}) {
  adminAudit.unshift({ id: crypto.randomUUID(), action, at: now(), ...data });
  if (adminAudit.length > 500) adminAudit.length = 500;
  persistState();
}
function security(action, l, data = {}) {
  const duplicate = securityEvents.find(x => x.action === action && x.licenseKey === l.key && x.installationId === data.installationId && now() - x.at < 60000);
  if (duplicate) return;
  securityEvents.unshift({ id: crypto.randomUUID(), action, at: now(), licenseKey: l.key, customerName: l.customerName || '', plan: l.plan, ...data });
  if (securityEvents.length > 500) securityEvents.length = 500;
  persistState();
}

function publicLicense(l) {
  const plan = planOf(l.plan);
  const used = Number(l.usage?.[today()] || 0);
  const usedTotal = totalUsage(l);
  const totalLimit = plan.totalSignals;
  return {
    key: l.key, status: l.status, plan: l.plan, planLabel: plan.label,
    dailyLimit: plan.dailySignals, usedToday: used,
    remainingToday: plan.dailySignals == null ? null : Math.max(0, plan.dailySignals - used),
    totalLimit, usedTotal, remainingTotal: totalLimit == null ? null : Math.max(0, totalLimit - usedTotal),
    price: cleanNumber(l.priceSnapshot ?? plan.price, 0),
    expiresAt: l.expiresAt || null, customerName: l.customerName || '', email: l.email || '',
    deviceLimit: 1, devices: (l.devices || []).length, deviceLocked: (l.devices || []).length > 0,
    deviceChanges: (l.deviceHistory || []).length,
    createdAt: l.createdAt, updatedAt: l.updatedAt || l.createdAt, isTrial: l.plan === 'trial'
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
    licenseKey: b.licenseKey.trim().toUpperCase(), installationId: b.installationId,
    version: typeof b.version === 'string' ? b.version.slice(0, 32) : null,
    type: typeof b.type === 'string' ? b.type.slice(0, 32) : null
  };
}
function licenseCheck(p, { consume = false } = {}) {
  const l = licenses.get(p.licenseKey);
  if (!l) return { status: 404, error: 'license_not_found' };
  if (l.status !== 'active') return { status: 403, error: 'license_inactive' };
  if (l.expiresAt && Date.parse(l.expiresAt) <= now()) return { status: 403, error: 'license_expired' };
  const plan = planOf(l.plan);
  l.devices ??= []; l.deviceHistory ??= [];
  let device = l.devices.find(x => x.installationId === p.installationId);
  if (!device) {
    if (l.devices.length >= 1) {
      security('device_blocked', l, { installationId: p.installationId, boundInstallationId: l.devices[0]?.installationId || '', version: p.version || null });
      return { status: 403, error: 'device_locked', license: publicLicense(l) };
    }
    device = { installationId: p.installationId, createdAt: now(), lastSeen: now(), version: p.version || null };
    l.devices.push(device);
    audit('device_bound', { licenseKey: l.key, customerName: l.customerName, plan: l.plan, installationId: p.installationId });
  } else {
    device.lastSeen = now();
    if (p.version) device.version = p.version;
  }
  l.usage ??= {};
  const day = today(), used = Number(l.usage[day] || 0), usedTotal = totalUsage(l);
  if (consume && p.type === 'signal') {
    if (plan.totalSignals != null && usedTotal >= plan.totalSignals) return { status: 429, error: 'trial_limit_reached', license: publicLicense(l) };
    if (plan.dailySignals != null && used >= plan.dailySignals) return { status: 429, error: 'daily_limit_reached', license: publicLicense(l) };
    l.usage[day] = used + 1;
  }
  l.updatedAt = now();
  saveLicenses();
  return { status: 200, license: publicLicense(l) };
}
function newLicenseKey() {
  return `ATS-${crypto.randomBytes(3).toString('hex').toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
}
function createLicense({ customerName = '', email = '', plan = 'starter', days }) {
  if (!PLANS[plan]) return null;
  const p = planOf(plan), createdAt = now();
  const validDays = Math.max(1, Number(days || p.defaultDays || 30));
  const l = {
    key: newLicenseKey(), plan, status: 'active', customerName: String(customerName).slice(0, 120), email: String(email).slice(0, 160),
    createdAt, updatedAt: createdAt, expiresAt: new Date(createdAt + validDays * 86400000).toISOString(),
    devices: [], deviceHistory: [], usage: {}, priceSnapshot: cleanNumber(p.price, 0)
  };
  licenses.set(l.key, l); saveLicenses();
  audit(plan === 'trial' ? 'trial_created' : 'license_created', { licenseKey: l.key, customerName: l.customerName, plan, price: l.priceSnapshot });
  return publicLicense(l);
}
function resetLicense(l, mode = 'devices') {
  l.devices ??= []; l.deviceHistory ??= []; l.usage ??= {};
  if (mode === 'full' || mode === 'devices') {
    for (const d of l.devices) l.deviceHistory.unshift({ ...d, removedAt: now() });
    l.devices = [];
  }
  if (mode === 'usage' && l.plan !== 'trial') l.usage[today()] = 0;
  if (mode === 'full') l.status = 'active';
  l.updatedAt = now(); saveLicenses();
  audit(`license_reset_${mode}`, { licenseKey: l.key, customerName: l.customerName, plan: l.plan });
  return publicLicense(l);
}
function renewLicense(l, days = 30) {
  const amount = Math.max(1, Number(days) || 30);
  const current = l.expiresAt ? Date.parse(l.expiresAt) : NaN;
  const base = Number.isFinite(current) && current > now() ? current : now();
  l.expiresAt = new Date(base + amount * 86400000).toISOString(); l.status = 'active'; l.updatedAt = now();
  saveLicenses(); audit('license_renewed', { licenseKey: l.key, customerName: l.customerName, days: amount, price: cleanNumber(l.priceSnapshot ?? planOf(l.plan).price, 0) });
  return publicLicense(l);
}
function updatePlan(id, b) {
  if (!PLANS[id] || !isObj(b)) return null;
  const old = PLANS[id], trial = id === 'trial', unlimited = id === 'unlimited';
  const dailySignals = unlimited ? null : Math.max(1, Math.min(500, Math.floor(cleanNumber(b.dailySignals, old.dailySignals ?? 1))));
  const totalSignals = trial ? Math.max(1, Math.min(2, Math.floor(cleanNumber(b.totalSignals, old.totalSignals ?? 2)))) : null;
  PLANS[id] = {
    ...old,
    label: typeof b.label === 'string' ? b.label.trim().slice(0, 40) || old.label : old.label,
    dailySignals, totalSignals, deviceLimit: 1,
    price: Math.max(0, cleanNumber(b.price, old.price)),
    defaultDays: Math.max(1, Math.min(3650, Math.floor(cleanNumber(b.defaultDays, old.defaultDays))))
  };
  persistState(); audit('plan_updated', { plan: id });
  return PLANS[id];
}
function serveAdmin(res, file, type) {
  try {
    const data = fs.readFileSync(path.join(ADMIN_DIR, file));
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store, max-age=0' }); res.end(data); return true;
  } catch { return false; }
}
function clientRows() {
  const out = [];
  for (const l of licenses.values()) for (const d of l.devices || []) out.push({
    licenseKey: l.key, plan: l.plan, planLabel: planOf(l.plan).label, customerName: l.customerName || '', email: l.email || '',
    installationId: d.installationId, lastSeen: d.lastSeen || 0, online: now() - (d.lastSeen || 0) < 60000, version: d.version || null,
    createdAt: d.createdAt || 0, deviceChanges: (l.deviceHistory || []).length
  });
  return out.sort((a, b) => b.lastSeen - a.lastSeen);
}
function customerProfile(l) {
  const pub = publicLicense(l);
  return {
    license: pub,
    devices: (l.devices || []).map(x => ({ ...x })),
    deviceHistory: (l.deviceHistory || []).slice(0, 30),
    history: adminAudit.filter(x => x.licenseKey === l.key).slice(0, 50),
    security: securityEvents.filter(x => x.licenseKey === l.key).slice(0, 50)
  };
}

loadState();
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
    for (const [asset, type] of [['app.js','text/javascript; charset=utf-8'],['ops.js','text/javascript; charset=utf-8'],['crm.js','text/javascript; charset=utf-8'],['styles.css','text/css; charset=utf-8'],['ops.css','text/css; charset=utf-8'],['crm.css','text/css; charset=utf-8']]) {
      if (pathname === `/admin/${asset}`) return serveAdmin(res, asset, type) || json(req, res, 404, { error: 'admin_asset_not_found' });
    }
    if (pathname === '/health') return json(req, res, 200, {
      ok: true, service: 'ats-api', time: now(), authConfigured: !!API_KEY, adminAuthConfigured: !!ADMIN_KEY,
      licenses: licenses.size, version: '0.7.0', storage: process.env.DATABASE_URL ? 'database-ready' : 'json', dataDir: DATA_DIR
    });

    if (pathname === '/v1/admin/auth/login' && req.method === 'POST') {
      if (!ADMIN_KEY) return json(req, res, 503, { error: 'admin_key_not_configured' });
      const b = await body(req);
      if (!safeEq(b.adminKey, ADMIN_KEY)) return json(req, res, 401, { error: 'unauthorized' });
      audit('admin_login');
      return json(req, res, 200, { ok: true, expiresInDays: ADMIN_SESSION_DAYS }, { 'set-cookie': sessionCookie(req) });
    }
    if (pathname === '/v1/admin/auth/logout' && req.method === 'POST') return json(req, res, 200, { ok: true }, { 'set-cookie': clearSessionCookie(req) });
    if (pathname === '/v1/admin/auth/status' && req.method === 'GET') {
      if (!adminAuth(req)) return json(req, res, ADMIN_KEY ? 401 : 503, { authenticated: false, error: ADMIN_KEY ? 'unauthorized' : 'admin_key_not_configured' });
      return json(req, res, 200, { authenticated: true, sessionDays: ADMIN_SESSION_DAYS });
    }

    const protectedRoute = (pathname === '/v1/session' && req.method === 'POST') || (pathname === '/v1/events' && req.method === 'POST');
    if (protectedRoute && !auth(req)) return json(req, res, API_KEY ? 401 : 503, { error: API_KEY ? 'unauthorized' : 'api_key_not_configured' });
    if (pathname.startsWith('/v1/admin/') && !adminAuth(req)) return json(req, res, ADMIN_KEY ? 401 : 503, { error: ADMIN_KEY ? 'unauthorized' : 'admin_key_not_configured' });

    if (pathname === '/v1/license/activate' && req.method === 'POST') {
      const p = licenseInput(await body(req)); if (!p) return json(req, res, 422, { error: 'invalid_license_request' });
      const r = licenseCheck(p); return json(req, res, r.status, r.error ? { ok: false, error: r.error, license: r.license } : { ok: true, license: r.license });
    }
    if (pathname === '/v1/license/validate' && req.method === 'POST') {
      const p = licenseInput(await body(req)); if (!p) return json(req, res, 422, { error: 'invalid_license_request' });
      const r = licenseCheck(p); return json(req, res, r.status, r.error ? { ok: false, error: r.error, license: r.license } : { ok: true, license: r.license });
    }
    if (pathname === '/v1/license/consume' && req.method === 'POST') {
      const p = licenseInput(await body(req)); if (!p || p.type !== 'signal') return json(req, res, 422, { error: 'invalid_usage_request' });
      const r = licenseCheck(p, { consume: true });
      return json(req, res, r.status, r.error ? { ok: false, error: r.error, license: r.license } : { ok: true, license: r.license, usage: {
        dailyLimit: r.license.dailyLimit, usedToday: r.license.usedToday, remainingToday: r.license.remainingToday,
        totalLimit: r.license.totalLimit, usedTotal: r.license.usedTotal, remainingTotal: r.license.remainingTotal
      }});
    }
    if (pathname === '/v1/session' && req.method === 'POST') {
      const p = sessionPayload(await body(req)); if (!p) return json(req, res, 422, { error: 'invalid_session' });
      sessions.set(p.installationId, { ...sessions.get(p.installationId), ...p, lastSeen: now() });
      return json(req, res, 200, { ok: true, installationId: p.installationId });
    }
    if (pathname === '/v1/events' && req.method === 'POST') {
      const p = eventPayload(await body(req)); if (!p) return json(req, res, 422, { error: 'invalid_event' });
      events.push({ ...p, id: crypto.randomUUID(), createdAt: now() }); if (events.length > 10000) events.shift();
      return json(req, res, 201, { ok: true });
    }

    if (pathname === '/v1/admin/plans' && req.method === 'GET') return json(req, res, 200, { plans: Object.values(PLANS) });
    const planRoute = pathname.match(/^\/v1\/admin\/plans\/([^/]+)$/);
    if (planRoute && req.method === 'POST') {
      const updated = updatePlan(decodeURIComponent(planRoute[1]), await body(req));
      return updated ? json(req, res, 200, { ok: true, plan: updated }) : json(req, res, 404, { error: 'plan_not_found' });
    }
    if (pathname === '/v1/admin/settings' && req.method === 'GET') return json(req, res, 200, { settings: adminSettings });
    if (pathname === '/v1/admin/settings' && req.method === 'POST') {
      const b = await body(req);
      adminSettings = {
        ...adminSettings,
        productName: typeof b.productName === 'string' ? b.productName.trim().slice(0, 80) || adminSettings.productName : adminSettings.productName,
        brandShort: typeof b.brandShort === 'string' ? b.brandShort.trim().slice(0, 12) || adminSettings.brandShort : adminSettings.brandShort,
        whatsapp: typeof b.whatsapp === 'string' ? b.whatsapp.replace(/\D/g, '').slice(0, 20) : adminSettings.whatsapp,
        supportText: typeof b.supportText === 'string' ? b.supportText.trim().slice(0, 300) : adminSettings.supportText,
        trialEnabled: typeof b.trialEnabled === 'boolean' ? b.trialEnabled : adminSettings.trialEnabled
      };
      persistState(); audit('settings_updated');
      return json(req, res, 200, { ok: true, settings: adminSettings });
    }

    if (pathname === '/v1/admin/licenses' && req.method === 'GET') return json(req, res, 200, { licenses: [...licenses.values()].map(publicLicense).sort((a, b) => b.createdAt - a.createdAt) });
    if (pathname === '/v1/admin/licenses' && req.method === 'POST') {
      const b = await body(req), license = createLicense({ customerName: b.customerName, email: b.email, plan: String(b.plan || 'starter'), days: b.days });
      return license ? json(req, res, 201, { ok: true, license }) : json(req, res, 422, { error: 'invalid_plan' });
    }
    if (pathname === '/v1/admin/trials' && req.method === 'POST') {
      if (!adminSettings.trialEnabled) return json(req, res, 403, { error: 'trial_disabled' });
      const b = await body(req), license = createLicense({ customerName: b.customerName, email: b.email, plan: 'trial', days: b.days });
      return json(req, res, 201, { ok: true, license });
    }

    const customerRoute = pathname.match(/^\/v1\/admin\/customers\/([^/]+)$/);
    if (customerRoute && req.method === 'GET') {
      const l = licenses.get(decodeURIComponent(customerRoute[1]).toUpperCase());
      return l ? json(req, res, 200, customerProfile(l)) : json(req, res, 404, { error: 'license_not_found' });
    }
    if (pathname === '/v1/admin/security' && req.method === 'GET') return json(req, res, 200, { events: securityEvents.slice(0, 200) });
    if (pathname === '/v1/admin/backup' && req.method === 'GET') return json(req, res, 200, {
      generatedAt: new Date().toISOString(), version: '0.7.0', settings: adminSettings, plans: PLANS,
      licenses: [...licenses.values()].map(publicLicense), clients: clientRows(), audit: adminAudit.slice(0, 500), security: securityEvents.slice(0, 500)
    });

    if (pathname === '/v1/admin/licenses/bulk' && req.method === 'POST') {
      const b = await body(req), keys = Array.isArray(b.keys) ? [...new Set(b.keys.map(x => String(x).toUpperCase()))].slice(0, 100) : [];
      if (!keys.length || !['activate','revoke','renew','reset-devices'].includes(b.action)) return json(req, res, 422, { error: 'invalid_bulk_action' });
      const updated = [];
      for (const key of keys) {
        const l = licenses.get(key); if (!l) continue;
        if (b.action === 'activate' || b.action === 'revoke') { l.status = b.action === 'activate' ? 'active' : 'revoked'; l.updatedAt = now(); saveLicenses(); audit(b.action === 'activate' ? 'license_activated' : 'license_revoked', { licenseKey: l.key, customerName: l.customerName, bulk: true }); updated.push(publicLicense(l)); }
        else if (b.action === 'renew') updated.push(renewLicense(l, b.days));
        else updated.push(resetLicense(l, 'devices'));
      }
      audit('bulk_action', { action: b.action, count: updated.length });
      return json(req, res, 200, { ok: true, count: updated.length, licenses: updated });
    }

    const renew = pathname.match(/^\/v1\/admin\/licenses\/([^/]+)\/renew$/);
    if (renew && req.method === 'POST') {
      const l = licenses.get(decodeURIComponent(renew[1]).toUpperCase()); if (!l) return json(req, res, 404, { error: 'license_not_found' });
      return json(req, res, 200, { ok: true, license: renewLicense(l, (await body(req)).days) });
    }
    const action = pathname.match(/^\/v1\/admin\/licenses\/([^/]+)\/(revoke|activate|reset|reset-devices|reset-usage)$/);
    if (action && req.method === 'POST') {
      const l = licenses.get(decodeURIComponent(action[1]).toUpperCase()); if (!l) return json(req, res, 404, { error: 'license_not_found' });
      const op = action[2]; let license;
      if (op === 'revoke' || op === 'activate') {
        l.status = op === 'activate' ? 'active' : 'revoked'; l.updatedAt = now(); saveLicenses();
        audit(op === 'activate' ? 'license_activated' : 'license_revoked', { licenseKey: l.key, customerName: l.customerName }); license = publicLicense(l);
      } else license = resetLicense(l, op === 'reset-usage' ? 'usage' : 'devices');
      return json(req, res, 200, { ok: true, license });
    }

    if (pathname === '/v1/admin/clients' && req.method === 'GET') return json(req, res, 200, { clients: clientRows() });
    if (pathname === '/v1/admin/audit' && req.method === 'GET') return json(req, res, 200, { events: adminAudit.slice(0, 100) });

    if (pathname === '/v1/admin/metrics' && req.method === 'GET') {
      const ts = now(), active = [...sessions.values()].filter(s => ts - s.lastSeen < 60000), groups = {};
      for (const s of active) { const key = s.platform || 'unknown'; groups[key] = (groups[key] || 0) + 1; }
      const lic = [...licenses.values()].map(publicLicense), devices = [];
      for (const l of licenses.values()) for (const d of l.devices || []) devices.push(d);
      const paidActive = lic.filter(x => x.plan !== 'trial' && x.status === 'active' && (!x.expiresAt || Date.parse(x.expiresAt) > ts));
      const trialCreated = adminAudit.filter(x => x.action === 'trial_created').length;
      const paidCreated = adminAudit.filter(x => x.action === 'license_created').length;
      return json(req, res, 200, {
        installations: sessions.size, online: active.length, licensedOnline: devices.filter(d => ts - (d.lastSeen || 0) < 60000).length,
        scanners: active.filter(s => s.scanning).length, events: events.length, licenses: lic.length,
        activeLicenses: lic.filter(x => x.status === 'active' && (!x.expiresAt || Date.parse(x.expiresAt) > ts)).length,
        paidLicenses: paidActive.length,
        estimatedMonthlyRevenue: paidActive.reduce((n, x) => n + cleanNumber(x.price, 0), 0),
        activeTrials: lic.filter(x => x.plan === 'trial' && x.status === 'active' && (!x.expiresAt || Date.parse(x.expiresAt) > ts)).length,
        trialSignalsUsed: lic.filter(x => x.plan === 'trial').reduce((n, x) => n + x.usedTotal, 0),
        revokedLicenses: lic.filter(x => x.status === 'revoked').length,
        expiredLicenses: lic.filter(x => x.expiresAt && Date.parse(x.expiresAt) <= ts).length,
        expiringSoon: lic.filter(x => x.status === 'active' && x.expiresAt && Date.parse(x.expiresAt) > ts && Date.parse(x.expiresAt) <= ts + 3 * 86400000).length,
        signalsToday: lic.reduce((n, x) => n + x.usedToday, 0), renewals: adminAudit.filter(x => x.action === 'license_renewed').length,
        blockedDeviceAttempts: securityEvents.filter(x => x.action === 'device_blocked').length,
        deviceChanges: [...licenses.values()].reduce((n, l) => n + (l.deviceHistory || []).length, 0),
        funnel: { trialsCreated: trialCreated, paidCreated, activePaid: paidActive.length, expired: lic.filter(x => x.expiresAt && Date.parse(x.expiresAt) <= ts).length },
        platforms: Object.entries(groups).map(([name, online]) => ({ name, online })), version: '0.7.0'
      });
    }

    return json(req, res, 404, { error: 'not_found' });
  } catch (e) {
    return json(req, res, e.message === 'too_large' ? 413 : 400, { error: e.message || 'bad_request' });
  }
});

server.listen(PORT, () => console.log(`ATS API :${PORT} • admin http://localhost:${PORT}/admin/`));
