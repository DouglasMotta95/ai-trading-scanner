import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VERSION = '0.10.2';
const PORT = Number(process.env.PORT || 8787);
const API_KEY = process.env.ATS_API_KEY || '';
const ADMIN_KEY = process.env.ATS_ADMIN_KEY || API_KEY;
const SESSION_SECRET = String(process.env.SESSION_SECRET || '').trim();
const NODE_ENV = String(process.env.NODE_ENV || 'development').toLowerCase();
const SESSION_SECRET_PLACEHOLDERS = new Set([
  'COLOQUE_AQUI_UM_SEGREDO_UNICO_GERADO',
  'replace-with-a-long-random-secret'
]);
if (NODE_ENV === 'production' && (SESSION_SECRET.length < 32 || SESSION_SECRET_PLACEHOLDERS.has(SESSION_SECRET))) {
  throw new Error('SESSION_SECRET must be a unique non-example secret with at least 32 characters in production');
}
const ADMIN_SESSION_DAYS = Math.max(1, Number(process.env.ADMIN_SESSION_DAYS || 30));
const CUSTOMER_SESSION_DAYS = Math.max(1, Number(process.env.CUSTOMER_SESSION_DAYS || 30));
const ACCOUNT_TOKEN_DAYS = Math.max(1, Number(process.env.ACCOUNT_TOKEN_DAYS || 30));
const ALLOWED_ORIGINS = String(process.env.CORS_ORIGINS || '').split(',').map(x => x.trim()).filter(Boolean);

const DATA_DIR = path.resolve(process.env.ATS_DATA_DIR || path.resolve(__dirname, '../data'));
const LICENSE_FILE = path.join(DATA_DIR, 'licenses.json');
const ADMIN_STATE_FILE = path.join(DATA_DIR, 'admin-state.json');
const CUSTOMER_FILE = path.join(DATA_DIR, 'customer-state.json');
const TELEMETRY_FILE = path.join(DATA_DIR, 'telemetry-state.json');
const ADMIN_DIR = path.resolve(__dirname, '../../apps/admin-dashboard');
const CUSTOMER_DIR = path.resolve(__dirname, '../../apps/customer-portal');

const ADMIN_SESSION_COOKIE = 'ats_admin_session';
const CUSTOMER_SESSION_COOKIE = 'ats_customer_session';
const GOOGLE_CLIENT_ID = String(process.env.GOOGLE_CLIENT_ID || '').trim();
const RESEND_API_KEY = String(process.env.RESEND_API_KEY || '').trim();
const EMAIL_FROM = String(process.env.EMAIL_FROM || '').trim();
const MP_ACCESS_TOKEN = String(process.env.MERCADOPAGO_ACCESS_TOKEN || '').trim();
const MP_WEBHOOK_SECRET = String(process.env.MERCADOPAGO_WEBHOOK_SECRET || '').trim();
const PAYMENTS_CONFIGURED = !!(MP_ACCESS_TOKEN && MP_WEBHOOK_SECRET);
const PUBLIC_BASE_URL = String(process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
const CASA_TRADE_URL = String(process.env.CASA_TRADE_URL || '').trim();
const SUPPORT_WHATSAPP = String(process.env.SUPPORT_WHATSAPP || '5535991429262').replace(/\D/g, '');
const EXTENSION_DOWNLOAD_URL = String(process.env.EXTENSION_DOWNLOAD_URL || '').trim();
const SALES_PRICES = {
  starter: Number(process.env.SALES_STARTER_PRICE || 79.90),
  pro: Number(process.env.SALES_PRO_PRICE || 149.90),
  unlimited: Number(process.env.SALES_UNLIMITED_PRICE || 299.90),
  lifetime: Number(process.env.SALES_LIFETIME_PRICE || 2997.00)
};
const LIFETIME_DAYS = 36500;
const CLIENT_TOKEN_TTL_MS = 7 * 86400000;

const now = () => Date.now();
const today = () => new Date().toISOString().slice(0, 10);
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
const text = (v, n = 160) => typeof v === 'string' ? v.trim().slice(0, n) : '';
const num = v => Number.isFinite(Number(v)) ? Number(v) : null;
const cleanNumber = (v, fallback = 0) => Number.isFinite(Number(v)) ? Number(v) : fallback;
const cleanPlain = (v, n) => String(v ?? '').normalize('NFKC').replace(/[\u0000-\u001f\u007f-\u009f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, n);
const cleanEmail = v => cleanPlain(v, 180).replace(/\s+/g, '').toLowerCase();
const cleanName = v => cleanPlain(v, 120);
const validEmail = v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || ''));
const htmlEscape = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const str = (v, n = 128) => typeof v === 'string' && v.length > 0 && v.length <= n;
const only = (o, keys) => Object.keys(o).every(k => keys.includes(k));
const b64 = value => Buffer.from(value).toString('base64url');
const unb64 = value => Buffer.from(value, 'base64url').toString('utf8');
const safeEq = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
  'x-frame-options': 'DENY',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  'content-security-policy': "default-src 'self'; script-src 'self' https://accounts.google.com; style-src 'self' 'unsafe-inline'; connect-src 'self' https://accounts.google.com https://oauth2.googleapis.com; frame-src https://accounts.google.com; img-src 'self' data: https:; font-src 'self' data:; base-uri 'self'; frame-ancestors 'none'; form-action 'self'"
};

function allowedOrigin(req) {
  const value = String(req.headers.origin || '');
  if (!value) return '';
  const proto = String(req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http')).split(',')[0].trim();
  const own = req.headers.host ? `${proto}://${req.headers.host}` : '';
  if (own && value === own) return value;
  if (value.startsWith('chrome-extension://') || value.startsWith('edge-extension://')) return value;
  if (ALLOWED_ORIGINS.includes('*') || ALLOWED_ORIGINS.includes(value)) return value;
  for (const rule of ALLOWED_ORIGINS) {
    if (!rule.includes('*')) continue;
    const rx = new RegExp(`^${rule.split('*').map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
    if (rx.test(value)) return value;
  }
  return null;
}
function baseHeaders(req) {
  const origin = allowedOrigin(req);
  const h = {
    ...SECURITY_HEADERS,
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-headers': 'content-type,x-api-key,x-admin-key,authorization,x-request-id,x-signature',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-max-age': '600',
    'vary': 'Origin'
  };
  if (origin) {
    h['access-control-allow-origin'] = origin;
    h['access-control-allow-credentials'] = 'true';
  }
  return h;
}
function json(req, res, status, data, extraHeaders = {}) {
  res.writeHead(status, { ...baseHeaders(req), ...extraHeaders });
  res.end(status === 204 ? '' : JSON.stringify(data));
}
function readBody(req, max = 131072) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > max) {
        reject(new Error('too_large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch { reject(new Error('invalid_json')); }
    });
  });
}
function parseCookies(req) {
  return Object.fromEntries(String(req.headers.cookie || '').split(';').map(v => v.trim()).filter(Boolean).map(v => {
    const i = v.indexOf('=');
    return i < 0 ? [v, ''] : [v.slice(0, i), decodeURIComponent(v.slice(i + 1))];
  }));
}
function secureCookie(req) {
  return String(req.headers['x-forwarded-proto'] || '').toLowerCase() === 'https' || !!req.socket.encrypted;
}
function tokenSecret(label) {
  const secret = SESSION_SECRET || ADMIN_KEY || API_KEY;
  if (!secret) throw new Error('session_secret_not_configured');
  return crypto.createHash('sha256').update(`${label}:${secret}`).digest();
}
function tokenSign(label, payload) {
  return crypto.createHmac('sha256', tokenSecret(label)).update(payload).digest('base64url');
}
function issueToken(label, data, ttlMs) {
  const payload = b64(JSON.stringify({ ...data, iat: now(), exp: now() + ttlMs, nonce: crypto.randomBytes(8).toString('hex') }));
  return `${payload}.${tokenSign(label, payload)}`;
}
function readToken(label, raw) {
  const [payload, signature] = String(raw || '').split('.');
  if (!payload || !signature || !safeEq(signature, tokenSign(label, payload))) return null;
  try {
    const data = JSON.parse(unb64(payload));
    return Number(data.exp) > now() ? data : null;
  } catch {
    return null;
  }
}
function ipOf(req) {
  return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
}
function baseUrl(req) {
  if (PUBLIC_BASE_URL) return PUBLIC_BASE_URL;
  const proto = String(req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http')).split(',')[0].trim();
  return `${proto}://${req.headers.host}`;
}
function serveFile(res, root, file, type) {
  try {
    const data = fs.readFileSync(path.join(root, file));
    res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': type, 'cache-control': 'no-store, max-age=0' });
    res.end(data);
    return true;
  } catch {
    return false;
  }
}

const sessions = new Map();
const legacyEvents = [];
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
let adminSettings = { productName: 'AI Trading Scanner', brandShort: 'ATS', whatsapp: '', supportText: 'Seu acesso foi preparado. Qualquer dúvida, fale comigo.', trialEnabled: true, currency: 'BRL' };
const totalUsage = l => Object.values(l?.usage || {}).reduce((sum, value) => sum + Math.max(0, Number(value) || 0), 0);
const planOf = id => PLANS[id] || PLANS.starter;
function persistAdminState() { try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(ADMIN_STATE_FILE, JSON.stringify({ plans: PLANS, settings: adminSettings, audit: adminAudit.slice(0, 500), security: securityEvents.slice(0, 500) }, null, 2)); } catch {} }
function loadAdminState() { try { const s = JSON.parse(fs.readFileSync(ADMIN_STATE_FILE, 'utf8')); if (isObj(s.plans)) for (const id of Object.keys(DEFAULT_PLANS)) if (isObj(s.plans[id])) PLANS[id] = { ...PLANS[id], ...s.plans[id], id, deviceLimit: 1 }; if (isObj(s.settings)) adminSettings = { ...adminSettings, ...s.settings }; if (Array.isArray(s.audit)) adminAudit = s.audit.slice(0, 500); if (Array.isArray(s.security)) securityEvents = s.security.slice(0, 500); } catch {} }
function audit(action, data = {}) { adminAudit.unshift({ id: crypto.randomUUID(), action, at: now(), ...data }); if (adminAudit.length > 500) adminAudit.length = 500; persistAdminState(); }
function security(action, license, data = {}) { const duplicate = securityEvents.find(x => x.action === action && x.licenseKey === license.key && x.installationId === data.installationId && now() - x.at < 60000); if (duplicate) return; securityEvents.unshift({ id: crypto.randomUUID(), action, at: now(), licenseKey: license.key, customerName: license.customerName || '', plan: license.plan, ...data }); if (securityEvents.length > 500) securityEvents.length = 500; persistAdminState(); }
function publicLicense(license) { const plan = planOf(license.plan), used = Number(license.usage?.[today()] || 0), usedTotal = totalUsage(license), totalLimit = plan.totalSignals; return { key: license.key, status: license.status, plan: license.plan, planLabel: plan.label, dailyLimit: plan.dailySignals, usedToday: used, remainingToday: plan.dailySignals == null ? null : Math.max(0, plan.dailySignals - used), totalLimit, usedTotal, remainingTotal: totalLimit == null ? null : Math.max(0, totalLimit - usedTotal), price: cleanNumber(license.priceSnapshot ?? plan.price, 0), expiresAt: license.expiresAt || null, customerName: license.customerName || '', email: license.email || '', deviceLimit: 1, devices: (license.devices || []).length, deviceLocked: (license.devices || []).length > 0, deviceChanges: (license.deviceHistory || []).length, createdAt: license.createdAt, updatedAt: license.updatedAt || license.createdAt, isTrial: license.plan === 'trial' }; }
function loadLicenses() { try { const rows = JSON.parse(fs.readFileSync(LICENSE_FILE, 'utf8')); for (const license of Array.isArray(rows) ? rows : []) if (license?.key) licenses.set(license.key, license); } catch {} }
function saveLicenses() { try { fs.mkdirSync(DATA_DIR, { recursive: true }); const tmp = `${LICENSE_FILE}.tmp`; fs.writeFileSync(tmp, JSON.stringify([...licenses.values()], null, 2)); fs.renameSync(tmp, LICENSE_FILE); } catch {} }
function licenseInput(b) { if (!isObj(b) || !str(b.licenseKey, 96) || !str(b.installationId, 128)) return null; return { licenseKey: b.licenseKey.trim().toUpperCase(), installationId: b.installationId, version: typeof b.version === 'string' ? b.version.slice(0, 32) : null, type: typeof b.type === 'string' ? b.type.slice(0, 32) : null }; }
function licenseCheck(p, { consume = false } = {}) { const license = licenses.get(p.licenseKey); if (!license) return { status: 404, error: 'license_not_found' }; if (license.status !== 'active') return { status: 403, error: 'license_inactive' }; if (license.expiresAt && Date.parse(license.expiresAt) <= now()) return { status: 403, error: 'license_expired' }; const plan = planOf(license.plan); license.devices ??= []; license.deviceHistory ??= []; let device = license.devices.find(x => x.installationId === p.installationId); if (!device) { if (license.devices.length >= 1) { security('device_blocked', license, { installationId: p.installationId, boundInstallationId: license.devices[0]?.installationId || '', version: p.version || null }); return { status: 403, error: 'device_locked', license: publicLicense(license) }; } device = { installationId: p.installationId, createdAt: now(), lastSeen: now(), version: p.version || null }; license.devices.push(device); audit('device_bound', { licenseKey: license.key, customerName: license.customerName, plan: license.plan, installationId: p.installationId }); } else { device.lastSeen = now(); if (p.version) device.version = p.version; } license.usage ??= {}; const day = today(), used = Number(license.usage[day] || 0), usedTotal = totalUsage(license); if (consume && p.type === 'signal') { if (plan.totalSignals != null && usedTotal >= plan.totalSignals) return { status: 429, error: 'trial_limit_reached', license: publicLicense(license) }; if (plan.dailySignals != null && used >= plan.dailySignals) return { status: 429, error: 'daily_limit_reached', license: publicLicense(license) }; license.usage[day] = used + 1; } license.updatedAt = now(); saveLicenses(); return { status: 200, license: publicLicense(license) }; }
function newLicenseKey() { return `ATS-${crypto.randomBytes(3).toString('hex').toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`; }
function createLicense({ customerName = '', email = '', plan = 'starter', days }) { if (!PLANS[plan]) return null; const p = planOf(plan), createdAt = now(), validDays = Math.max(1, Number(days || p.defaultDays || 30)); const license = { key: newLicenseKey(), plan, status: 'active', customerName: cleanName(customerName), email: cleanEmail(email), createdAt, updatedAt: createdAt, expiresAt: new Date(createdAt + validDays * 86400000).toISOString(), devices: [], deviceHistory: [], usage: {}, priceSnapshot: cleanNumber(p.price, 0) }; licenses.set(license.key, license); saveLicenses(); audit(plan === 'trial' ? 'trial_created' : 'license_created', { licenseKey: license.key, customerName: license.customerName, plan, price: license.priceSnapshot }); return publicLicense(license); }
function resetLicense(license, mode = 'devices') { license.devices ??= []; license.deviceHistory ??= []; license.usage ??= {}; if (mode === 'full' || mode === 'devices') { for (const d of license.devices) license.deviceHistory.unshift({ ...d, removedAt: now() }); license.devices = []; } if (mode === 'usage' && license.plan !== 'trial') license.usage[today()] = 0; if (mode === 'full') license.status = 'active'; license.updatedAt = now(); saveLicenses(); audit(`license_reset_${mode}`, { licenseKey: license.key, customerName: license.customerName, plan: license.plan }); return publicLicense(license); }
function renewLicense(license, days = 30) { const amount = Math.max(1, Number(days) || 30), current = license.expiresAt ? Date.parse(license.expiresAt) : NaN, base = Number.isFinite(current) && current > now() ? current : now(); license.expiresAt = new Date(base + amount * 86400000).toISOString(); license.status = 'active'; license.updatedAt = now(); saveLicenses(); audit('license_renewed', { licenseKey: license.key, customerName: license.customerName, days: amount, price: cleanNumber(license.priceSnapshot ?? planOf(license.plan).price, 0) }); return publicLicense(license); }
function updatePlan(id, b) { if (!PLANS[id] || !isObj(b)) return null; const old = PLANS[id], trial = id === 'trial', unlimited = id === 'unlimited'; const dailySignals = unlimited ? null : Math.max(1, Math.min(500, Math.floor(cleanNumber(b.dailySignals, old.dailySignals ?? 1)))); const totalSignals = trial ? Math.max(1, Math.min(2, Math.floor(cleanNumber(b.totalSignals, old.totalSignals ?? 2)))) : null; PLANS[id] = { ...old, label: typeof b.label === 'string' ? b.label.trim().slice(0, 40) || old.label : old.label, dailySignals, totalSignals, deviceLimit: 1, price: Math.max(0, cleanNumber(b.price, old.price)), defaultDays: Math.max(1, Math.min(3650, Math.floor(cleanNumber(b.defaultDays, old.defaultDays)))) }; persistAdminState(); audit('plan_updated', { plan: id }); return PLANS[id]; }
function clientRows() { const out = []; for (const license of licenses.values()) for (const d of license.devices || []) out.push({ licenseKey: license.key, plan: license.plan, planLabel: planOf(license.plan).label, customerName: license.customerName || '', email: license.email || '', installationId: d.installationId, lastSeen: d.lastSeen || 0, online: now() - (d.lastSeen || 0) < 60000, version: d.version || null, createdAt: d.createdAt || 0, deviceChanges: (license.deviceHistory || []).length }); return out.sort((a, b) => b.lastSeen - a.lastSeen); }
function customerProfile(license) { return { license: publicLicense(license), devices: (license.devices || []).map(x => ({ ...x })), deviceHistory: (license.deviceHistory || []).slice(0, 30), history: adminAudit.filter(x => x.licenseKey === license.key).slice(0, 50), security: securityEvents.filter(x => x.licenseKey === license.key).slice(0, 50) }; }
function createAdminSessionToken() { return issueToken('admin-session', {}, ADMIN_SESSION_DAYS * 86400000); }
function validAdminSession(req) { if (!ADMIN_KEY) return false; return !!readToken('admin-session', parseCookies(req)[ADMIN_SESSION_COOKIE]); }
function adminAuth(req) { return safeEq(req.headers['x-admin-key'], ADMIN_KEY) || validAdminSession(req); }
function adminSessionCookie(req) { return `${ADMIN_SESSION_COOKIE}=${encodeURIComponent(createAdminSessionToken())}; Path=/; Max-Age=${ADMIN_SESSION_DAYS * 86400}; HttpOnly; SameSite=Lax${secureCookie(req) ? '; Secure' : ''}`; }
function clearAdminSessionCookie(req) { return `${ADMIN_SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secureCookie(req) ? '; Secure' : ''}`; }
function apiAuth(req) { return safeEq(req.headers['x-api-key'], API_KEY); }

const liveSessions = new Map();
const validationCache = new Map();
let liveEvents = [];
let signalHistory = [];
const clientTokenSecret = crypto.createHash('sha256').update(`ats-client:${SESSION_SECRET || API_KEY || ADMIN_KEY || 'development-only'}`).digest();
const clientTokenSign = payload => crypto.createHmac('sha256', clientTokenSecret).update(payload).digest('base64url');
function loadTelemetry() { try { const saved = JSON.parse(fs.readFileSync(TELEMETRY_FILE, 'utf8')); if (Array.isArray(saved.events)) liveEvents = saved.events.slice(0, 1500); if (Array.isArray(saved.signals)) signalHistory = saved.signals.slice(0, 3000); } catch {} }
function persistTelemetry() { try { fs.mkdirSync(DATA_DIR, { recursive: true }); const tmp = `${TELEMETRY_FILE}.tmp`; fs.writeFileSync(tmp, JSON.stringify({ events: liveEvents.slice(0, 1500), signals: signalHistory.slice(0, 3000) }, null, 2)); fs.renameSync(tmp, TELEMETRY_FILE); } catch {} }
function issueClientToken(licenseKey, installationId) { const data = { licenseKey, installationId, iat: now(), exp: now() + CLIENT_TOKEN_TTL_MS, nonce: crypto.randomBytes(8).toString('hex') }, payload = b64(JSON.stringify(data)); return { token: `${payload}.${clientTokenSign(payload)}`, expiresAt: data.exp }; }
function decodeClientToken(raw = '') { const [payload, signature] = String(raw).split('.'); if (!payload || !signature || !safeEq(signature, clientTokenSign(payload))) return null; try { const data = JSON.parse(unb64(payload)); if (!data.licenseKey || !data.installationId || Number(data.exp) <= now()) return null; return data; } catch { return null; } }
function bearer(req) { const h = String(req.headers.authorization || ''); return h.toLowerCase().startsWith('bearer ') ? h.slice(7).trim() : ''; }
function clientIdentity(req) { const raw = bearer(req), decoded = decodeClientToken(raw); if (!decoded) return null; const cached = validationCache.get(raw); if (cached && cached.until > now()) return cached.identity; const check = licenseCheck({ licenseKey: decoded.licenseKey, installationId: decoded.installationId, version: null, type: null }); if (check.status !== 200) return null; const identity = { ...decoded, license: check.license }; validationCache.set(raw, { until: now() + 10000, identity }); return identity; }
function parseDuration(data = {}) { const explicit = num(data.durationMs); if (explicit != null) return clamp(explicit, 5000, 3600000); const source = text(data.expiration || data.timeframe || '', 24).toLowerCase().replace(/\s+/g, ''); let m = source.match(/^(\d+)s$/); if (m) return clamp(Number(m[1]) * 1000, 5000, 3600000); m = source.match(/^(\d+)m(?:in)?$/); if (m) return clamp(Number(m[1]) * 60000, 5000, 3600000); m = source.match(/^s(\d+)$/); if (m) return clamp(Number(m[1]) * 1000, 5000, 3600000); m = source.match(/^m(\d+)$/); if (m) return clamp(Number(m[1]) * 60000, 5000, 3600000); m = source.match(/^h(\d+)$/); if (m) return clamp(Number(m[1]) * 3600000, 5000, 3600000); return 60000; }
function resolveSignals(session) { const currentPrice = num(session.price); if (currentPrice == null || !session.asset) return false; let changed = false; for (const signal of signalHistory) { if (signal.outcome !== 'pending' || signal.installationId !== session.installationId || signal.asset !== session.asset || now() < signal.expiresAt) continue; if (num(signal.entryPrice) == null) continue; const delta = currentPrice - signal.entryPrice; signal.exitPrice = currentPrice; signal.resolvedAt = now(); signal.resultSource = 'scanner_feed_after_expiry'; if (delta === 0) signal.outcome = 'draw'; else if (signal.direction === 'BUY') signal.outcome = delta > 0 ? 'win' : 'loss'; else if (signal.direction === 'SELL') signal.outcome = delta < 0 ? 'win' : 'loss'; else signal.outcome = 'unknown'; changed = true; } if (changed) persistTelemetry(); return changed; }
function heartbeatPayload(b = {}, identity) { const score = num(b.score); return { installationId: identity.installationId, licenseKey: identity.licenseKey, customerName: text(identity.license?.customerName || '', 120), plan: text(identity.license?.plan || '', 40), platformId: text(b.platformId || '', 64), platformName: text(b.platformName || '', 80), connection: text(b.connection || '', 24), scanning: !!b.scanning, asset: text(b.asset || '', 64), marketType: text(b.marketType || '', 40), timeframe: text(b.timeframe || '', 24), expiration: text(b.expiration || '', 24), price: num(b.price), serverTime: num(b.serverTime), signalState: text(b.signalState || '', 24), direction: ['BUY', 'SELL'].includes(b.direction) ? b.direction : null, score: score == null ? null : clamp(score, 0, 100), grade: text(b.grade || '', 24), confirmations: text(b.confirmations || '', 32), regime: text(b.regime || '', 40), provisional: !!b.provisional, feedQuality: num(b.feedQuality) == null ? null : clamp(num(b.feedQuality), 0, 100), structured: !!b.structured, latency: num(b.latency), version: text(b.version || '', 32), lastSeen: now() }; }
function telemetryEventPayload(b = {}, identity) { const type = text(b.type || '', 64), data = b.data && typeof b.data === 'object' && !Array.isArray(b.data) ? b.data : {}; if (!type || JSON.stringify(data).length > 16384) return null; return { id: crypto.randomUUID(), at: now(), type, installationId: identity.installationId, licenseKey: identity.licenseKey, customerName: text(identity.license?.customerName || '', 120), plan: text(identity.license?.plan || '', 40), data }; }
function recordSignal(evt) { const d = evt.data || {}, direction = text(d.direction || '', 8).toUpperCase(), entryPrice = num(d.entryPrice); if (!['BUY', 'SELL'].includes(direction) || !text(d.asset || '', 64) || entryPrice == null) return; const signalId = text(d.signalId || '', 96) || crypto.randomUUID(); if (signalHistory.some(x => x.signalId === signalId)) return; const durationMs = parseDuration(d), entryAt = evt.at; signalHistory.unshift({ signalId, installationId: evt.installationId, licenseKey: evt.licenseKey, customerName: evt.customerName, plan: evt.plan, platformId: text(d.platformId || '', 64), platformName: text(d.platformName || '', 80), asset: text(d.asset || '', 64), direction, entryPrice, score: clamp(num(d.score) || 0, 0, 100), grade: text(d.grade || '', 24), timeframe: text(d.timeframe || '', 24), expiration: text(d.expiration || '', 24), durationMs, regime: text(d.regime || '', 40), confirmations: text(d.confirmations || '', 32), feedQuality: clamp(num(d.feedQuality) || 0, 0, 100), entryAt, expiresAt: entryAt + durationMs, outcome: 'pending', exitPrice: null, resolvedAt: null, resultSource: null }); signalHistory = signalHistory.slice(0, 3000); persistTelemetry(); }
function operations() { const ts = now(), currentSessions = [...liveSessions.values()].map(s => ({ ...s, online: ts - s.lastSeen < 20000 })).sort((a, b) => b.lastSeen - a.lastSeen), resolved = signalHistory.filter(s => ['win', 'loss', 'draw'].includes(s.outcome)), wins = resolved.filter(s => s.outcome === 'win').length, losses = resolved.filter(s => s.outcome === 'loss').length, draws = resolved.filter(s => s.outcome === 'draw').length, decisive = wins + losses; return { version: VERSION, generatedAt: ts, summary: { onlineClients: currentSessions.filter(s => s.online).length, scanningClients: currentSessions.filter(s => s.online && s.scanning).length, confirmedSignals: signalHistory.length, pendingSignals: signalHistory.filter(s => s.outcome === 'pending').length, wins, losses, draws, observedAccuracy: decisive ? Math.round((wins / decisive) * 1000) / 10 : null }, sessions: currentSessions.slice(0, 250), signals: signalHistory.slice(0, 250), events: liveEvents.slice(0, 250) }; }

let customerState = { accounts: [], orders: [], trialDevices: {}, paymentEvents: [] };
const connectCodes = new Map();
const rateBuckets = new Map();
const paymentLocks = new Map();
const orderLocks = new Map();
async function withLock(map, key, work) { if (!key) return work(); if (map.has(key)) return map.get(key); const task = Promise.resolve().then(work).finally(() => map.delete(key)); map.set(key, task); return task; }
function normalizePaymentEvents(rows = []) { return (Array.isArray(rows) ? rows : []).map(x => typeof x === 'string' ? { key: x, state: 'completed', at: 0, legacy: true } : x).filter(x => x && typeof x.key === 'string').slice(0, 1000); }
function paymentEvent(key) { return customerState.paymentEvents.find(x => x.key === key) || null; }
function setPaymentEvent(key, state, data = {}) { if (!key) return null; let evt = paymentEvent(key); if (!evt) { evt = { key, state, receivedAt: now(), updatedAt: now() }; customerState.paymentEvents.unshift(evt); } else { evt.state = state; evt.updatedAt = now(); } Object.assign(evt, data); customerState.paymentEvents = customerState.paymentEvents.slice(0, 1000); saveCustomerState(); return evt; }
function loadCustomerState() { try { const parsed = JSON.parse(fs.readFileSync(CUSTOMER_FILE, 'utf8')); if (parsed && typeof parsed === 'object') customerState = { accounts: Array.isArray(parsed.accounts) ? parsed.accounts : [], orders: Array.isArray(parsed.orders) ? parsed.orders : [], trialDevices: parsed.trialDevices && typeof parsed.trialDevices === 'object' ? parsed.trialDevices : {}, paymentEvents: normalizePaymentEvents(parsed.paymentEvents) }; } catch {} }
function saveCustomerState() { fs.mkdirSync(DATA_DIR, { recursive: true }); const tmp = `${CUSTOMER_FILE}.tmp`; fs.writeFileSync(tmp, JSON.stringify(customerState, null, 2)); fs.renameSync(tmp, CUSTOMER_FILE); }
function rate(req, key, limit = 10, windowMs = 60000) { const id = `${key}:${ipOf(req)}`, t = now(), bucket = rateBuckets.get(id); if (!bucket || t > bucket.reset) { rateBuckets.set(id, { count: 1, reset: t + windowMs }); return true; } if (bucket.count >= limit) return false; bucket.count++; return true; }
function customerCookie(req, account) { const token = issueToken('customer-session', { uid: account.id }, CUSTOMER_SESSION_DAYS * 86400000); return `${CUSTOMER_SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=${CUSTOMER_SESSION_DAYS * 86400}; HttpOnly; SameSite=Lax${secureCookie(req) ? '; Secure' : ''}`; }
function clearCustomerCookie(req) { return `${CUSTOMER_SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secureCookie(req) ? '; Secure' : ''}`; }
function accountFromReq(req) { const t = readToken('customer-session', parseCookies(req)[CUSTOMER_SESSION_COOKIE]); return t ? customerState.accounts.find(a => a.id === t.uid) || null : null; }
function accountFromBearer(req) { const h = String(req.headers.authorization || ''); if (!h.toLowerCase().startsWith('bearer ')) return null; const t = readToken('extension-account', h.slice(7).trim()); return t ? customerState.accounts.find(a => a.id === t.uid) || null : null; }
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) { const hash = crypto.scryptSync(String(password), salt, 64).toString('hex'); return { salt, hash }; }
function verifyPassword(password, account) { if (!account.passwordHash || !account.passwordSalt) return false; const got = crypto.scryptSync(String(password), account.passwordSalt, 64).toString('hex'); return safeEq(got, account.passwordHash); }
function presentLicense(account, license = null) { if (!license) return null; if (account?.commercialPlan === 'lifetime' && license.plan === 'unlimited') return { ...license, plan: 'lifetime', planLabel: 'Vitalício', expiresAt: null, lifetime: true, billing: 'one_time' }; return license; }
function publicAccount(account, license = null) { return { id: account.id, name: account.name, email: account.email, emailVerified: !!account.emailVerified, provider: account.googleSub ? 'google' : 'email', createdAt: account.createdAt, currentLicenseKey: account.currentLicenseKey || null, trialClaimedAt: account.trialClaimedAt || null, commercialPlan: account.commercialPlan || null, license: presentLicense(account, license) }; }
function licenseProfile(account) { if (!account?.currentLicenseKey) return null; const license = licenses.get(String(account.currentLicenseKey).toUpperCase()); return license ? publicLicense(license) : null; }
function createEntitlement(account, plan = 'trial', days = null) { if (plan === 'trial' && adminSettings.trialEnabled === false) throw new Error('trial_disabled'); const created = createLicense({ customerName: account.name, email: account.email, plan, days }); if (!created?.key) throw new Error('entitlement_create_failed'); account.currentLicenseKey = created.key; if (plan === 'trial') account.trialClaimedAt = now(); account.updatedAt = now(); saveCustomerState(); return created; }
function ensureTrial(account) { if (account.currentLicenseKey) return licenseProfile(account); if (account.trialClaimedAt) throw new Error('trial_already_claimed'); return createEntitlement(account, 'trial', 3); }
function revokeLicenseByKey(key) { const license = licenses.get(String(key || '').toUpperCase()); if (!license) return null; license.status = 'revoked'; license.updatedAt = now(); saveLicenses(); audit('license_revoked', { licenseKey: license.key, customerName: license.customerName }); return publicLicense(license); }
function grantPaidEntitlement(account, plan, days = 30) { const current = licenseProfile(account); if (plan === 'lifetime') { if (current?.key && current.plan === 'unlimited' && account.commercialPlan === 'lifetime') return presentLicense(account, current); const previousKey = account.currentLicenseKey || null, created = createEntitlement(account, 'unlimited', LIFETIME_DAYS); account.commercialPlan = 'lifetime'; account.updatedAt = now(); saveCustomerState(); if (previousKey && previousKey !== created.key) revokeLicenseByKey(previousKey); return presentLicense(account, created); } if (current?.key && current.plan === plan && current.plan !== 'trial' && account.commercialPlan !== 'lifetime') { const raw = licenses.get(current.key); if (raw) { const renewed = renewLicense(raw, days); account.currentLicenseKey = current.key; account.commercialPlan = plan; account.updatedAt = now(); saveCustomerState(); return renewed; } } const previousKey = account.currentLicenseKey || null, created = createEntitlement(account, plan, days); account.commercialPlan = plan; account.updatedAt = now(); saveCustomerState(); if (previousKey && previousKey !== created.key) revokeLicenseByKey(previousKey); return created; }
async function sendVerification(req, account) {
  const configured = !!(RESEND_API_KEY && EMAIL_FROM);
  if (!configured) return { configured: false, sent: false, error: 'email_not_configured' };
  const token = issueToken('email-verify', { uid: account.id, email: account.email }, 24 * 3600000);
  const url = `${baseUrl(req)}/?verify=${encodeURIComponent(token)}`;
  const safeName = htmlEscape(account.name || 'trader'), safeUrl = htmlEscape(url);
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 8000);
  const subject = 'Confirme seu e-mail e ative seu acesso • AI Trading Scanner';
  const plain = `Olá ${account.name || 'trader'},\n\nConfirme seu e-mail para liberar seu acesso ao AI Trading Scanner.\n\n${url}\n\nEste link expira em 24 horas. Se você não criou esta conta, ignore esta mensagem.`;
  const html = `<!doctype html><html><body style="margin:0;background:#050914;color:#eaf3fb;font-family:Arial,sans-serif"><div style="max-width:620px;margin:0 auto;padding:38px 22px"><div style="padding:28px;border:1px solid #173047;border-radius:18px;background:#081521"><div style="font-size:12px;font-weight:800;letter-spacing:1.5px;color:#61d9b6">AI TRADING SCANNER</div><h1 style="margin:12px 0 10px;font-size:26px;color:#fff">Confirme seu e-mail</h1><p style="margin:0 0 18px;color:#a8bdcd;line-height:1.6">Olá ${safeName}, confirme seu cadastro para liberar seu acesso e o Trial do AI Trading Scanner.</p><p style="margin:26px 0"><a href="${safeUrl}" style="display:inline-block;background:#45e0b5;color:#03130e;padding:15px 22px;border-radius:11px;text-decoration:none;font-weight:800">CONFIRMAR MEU E-MAIL</a></p><p style="margin:0 0 10px;color:#8299ac;font-size:13px;line-height:1.55">O link expira em 24 horas. Se o botão não abrir, copie e cole este endereço no navegador:</p><p style="margin:0;word-break:break-all;font-size:12px;line-height:1.55"><a href="${safeUrl}" style="color:#7edec4">${safeUrl}</a></p></div><p style="color:#60798d;font-size:11px;line-height:1.5;text-align:center;margin:16px 0 0">Se você não criou esta conta, ignore esta mensagem.</p></div></body></html>`;
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${RESEND_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: EMAIL_FROM, to: [account.email], subject, html, text: plain }),
      signal: controller.signal
    });
    const provider = await r.json().catch(() => ({}));
    if (!r.ok) {
      console.error(`verification email rejected status=${r.status}`);
      return { configured: true, sent: false, error: 'email_provider_rejected', providerStatus: r.status };
    }
    return { configured: true, sent: true, id: typeof provider.id === 'string' ? provider.id : null };
  } catch (e) {
    const error = e?.name === 'AbortError' ? 'email_timeout' : 'email_provider_unreachable';
    console.error(`verification email failed: ${error}`);
    return { configured: true, sent: false, error };
  } finally {
    clearTimeout(timer);
  }
}
async function sendPasswordReset(req, account) {
  const configured = !!(RESEND_API_KEY && EMAIL_FROM);
  if (!configured) return { configured: false, sent: false, error: 'email_not_configured' };
  const token = issueToken('password-reset', { uid: account.id, email: account.email }, 30 * 60000);
  const url = `${baseUrl(req)}/?reset=${encodeURIComponent(token)}`;
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 8000);
  try {
    const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { authorization: `Bearer ${RESEND_API_KEY}`, 'content-type': 'application/json' }, body: JSON.stringify({ from: EMAIL_FROM, to: [account.email], subject: 'Redefina sua senha • AI Trading Scanner', text: `Use este link para criar uma nova senha. Ele expira em 30 minutos:

${url}`, html: `<p>Use o link abaixo para criar uma nova senha. Ele expira em 30 minutos.</p><p><a href="${htmlEscape(url)}">REDEFINIR SENHA</a></p>` }), signal: controller.signal });
    return { configured: true, sent: r.ok };
  } catch { return { configured: true, sent: false, error: 'email_provider_unreachable' }; }
  finally { clearTimeout(timer); }
}
async function verifyGoogleCredential(credential) { const r = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`); if (!r.ok) throw new Error('google_invalid'); const d = await r.json(); if (!GOOGLE_CLIENT_ID || d.aud !== GOOGLE_CLIENT_ID || d.email_verified !== 'true') throw new Error('google_invalid'); return { sub: d.sub, email: cleanEmail(d.email), name: cleanName(d.name || d.given_name || '') }; }
function pruneConnectCodes() { const t = now(); for (const [code, c] of connectCodes) if (c.used || c.expiresAt < t) connectCodes.delete(code); }
function connectCode() { pruneConnectCodes(); let code; do { code = String(crypto.randomInt(100000, 1000000)); } while (connectCodes.has(code)); return code; }
function issueAccountToken(account) { return issueToken('extension-account', { uid: account.id }, ACCOUNT_TOKEN_DAYS * 86400000); }
function activateForAccount(account, installationId, version) { if (!account.currentLicenseKey) ensureTrial(account); const key = String(account.currentLicenseKey || '').toUpperCase(), check = licenseCheck({ licenseKey: key, installationId, version, type: null }); if (check.status !== 200) throw Object.assign(new Error(check.error || 'license_activation_failed'), { status: check.status, data: check }); const client = issueClientToken(key, installationId); return { ok: true, license: presentLicense(account, check.license), licenseKey: key, clientToken: client.token, clientTokenExpiresAt: client.expiresAt, accountToken: issueAccountToken(account), accountTokenExpiresAt: now() + ACCOUNT_TOKEN_DAYS * 86400000 }; }
function publicPlans() { const core = ['trial', 'starter', 'pro', 'unlimited'].map(id => { const p = PLANS[id] || { id, label: id }; return { ...p, price: id === 'trial' ? 0 : (Number(p.price) > 0 ? Number(p.price) : SALES_PRICES[id] || 0), recommended: id === 'pro', lifetime: false, billing: 'monthly' }; }); core.push({ id: 'lifetime', label: 'Vitalício', dailySignals: null, totalSignals: null, deviceLimit: 1, price: SALES_PRICES.lifetime, defaultDays: null, recommended: false, lifetime: true, billing: 'one_time' }); return core; }
async function checkoutPreference(req, account, planId) { if (!PAYMENTS_CONFIGURED) throw Object.assign(new Error('payment_not_configured'), { status: 503 }); const plan = publicPlans().find(p => p.id === planId && p.id !== 'trial'); if (!plan) throw Object.assign(new Error('invalid_plan'), { status: 422 }); const order = { id: crypto.randomUUID(), accountId: account.id, plan: plan.id, amount: Number(plan.price), currency: 'BRL', status: 'created', createdAt: now(), updatedAt: now(), paymentId: null, preferenceId: null }; customerState.orders.unshift(order); customerState.orders = customerState.orders.slice(0, 3000); saveCustomerState(); const root = baseUrl(req), description = plan.lifetime ? `Plano ${plan.label} • pagamento único • 1 aparelho` : `Plano ${plan.label} por 30 dias`; const pref = await fetch('https://api.mercadopago.com/checkout/preferences', { method: 'POST', headers: { authorization: `Bearer ${MP_ACCESS_TOKEN}`, 'content-type': 'application/json', 'x-idempotency-key': order.id }, body: JSON.stringify({ items: [{ id: plan.id, title: `AI Trading Scanner • ${plan.label}`, description, quantity: 1, currency_id: 'BRL', unit_price: Number(plan.price) }], payer: { email: account.email }, external_reference: order.id, notification_url: `${root}/v1/payments/mercadopago/webhook`, back_urls: { success: `${root}/?payment=success`, pending: `${root}/?payment=pending`, failure: `${root}/?payment=failure` }, auto_return: 'approved', metadata: { account_id: account.id, plan_id: plan.id } }) }); const data = await pref.json().catch(() => ({})); if (!pref.ok || !data.init_point) { order.status = 'preference_failed'; order.updatedAt = now(); saveCustomerState(); throw Object.assign(new Error(data.message || 'checkout_failed'), { status: 502 }); } order.preferenceId = data.id; order.checkoutUrl = data.init_point; order.status = 'pending'; order.updatedAt = now(); saveCustomerState(); return { checkoutUrl: data.init_point, order: { id: order.id, plan: order.plan, amount: order.amount, status: order.status } }; }
function mpSignatureValid(req, url) { if (!MP_WEBHOOK_SECRET) return false; const header = String(req.headers['x-signature'] || ''), requestId = String(req.headers['x-request-id'] || ''), dataId = url.searchParams.get('data.id') || '', pairs = Object.fromEntries(header.split(',').map(x => x.trim().split('='))), ts = pairs.ts, v1 = pairs.v1; if (!ts || !v1) return false; const manifest = [dataId ? `id:${String(dataId).toLowerCase()};` : '', requestId ? `request-id:${requestId};` : '', `ts:${ts};`].join(''), expected = crypto.createHmac('sha256', MP_WEBHOOK_SECRET).update(manifest).digest('hex'); return safeEq(expected, v1); }
async function processPayment(paymentId) { if (!PAYMENTS_CONFIGURED) throw new Error('payment_not_configured'); const id = String(paymentId || ''); if (!id) throw new Error('payment_id_required'); return withLock(paymentLocks, id, async () => { const r = await fetch(`https://api.mercadopago.com/v1/payments/${encodeURIComponent(id)}`, { headers: { authorization: `Bearer ${MP_ACCESS_TOKEN}` } }); if (!r.ok) throw new Error(`payment_lookup_failed_${r.status}`); const payment = await r.json(), order = customerState.orders.find(o => o.id === payment.external_reference); if (!order) throw new Error('payment_order_not_found'); return withLock(orderLocks, order.id, async () => { if (order.status === 'approved') return { status: 'approved', duplicate: String(order.paymentId || '') === String(payment.id), duplicateOrder: String(order.paymentId || '') !== String(payment.id), orderId: order.id }; order.paymentId = String(payment.id); order.paymentStatus = payment.status; order.updatedAt = now(); const amountOk = Math.round(Number(payment.transaction_amount) * 100) === Math.round(Number(order.amount) * 100), currencyOk = String(payment.currency_id || '') === String(order.currency || ''), preferenceOk = !order.preferenceId || !payment.preference_id || String(payment.preference_id) === String(order.preferenceId), metadataAccountOk = !payment.metadata?.account_id || String(payment.metadata.account_id) === String(order.accountId), metadataPlanOk = !payment.metadata?.plan_id || String(payment.metadata.plan_id) === String(order.plan); if (payment.status === 'approved' && (!amountOk || !currencyOk || !preferenceOk || !metadataAccountOk || !metadataPlanOk)) { order.status = 'rejected_mismatch'; order.paymentValidation = { amountOk, currencyOk, preferenceOk, metadataAccountOk, metadataPlanOk }; saveCustomerState(); return { status: order.status, orderId: order.id }; } if (payment.status === 'approved' && order.status !== 'approved') { const account = customerState.accounts.find(x => x.id === order.accountId); if (!account) throw new Error('payment_account_not_found'); const license = grantPaidEntitlement(account, order.plan, order.plan === 'lifetime' ? LIFETIME_DAYS : 30); order.status = 'approved'; order.licenseKey = license.key; order.approvedAt = now(); } else if (payment.status !== 'approved') order.status = payment.status || 'pending'; saveCustomerState(); return { status: order.status, orderId: order.id }; }); }); }
function syncDefaultPrices() { for (const id of ['starter', 'pro', 'unlimited']) { const p = PLANS[id]; if (p && Number(p.price || 0) <= 0) p.price = SALES_PRICES[id]; } persistAdminState(); }
function serveAdminIndex(res) { try { let html = fs.readFileSync(path.join(ADMIN_DIR, 'index.html'), 'utf8'); html = html.replace(/v=0\.\d+\.\d+/g, `v=${VERSION}`); res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store, max-age=0' }); res.end(html); return true; } catch { return false; } }
function sessionPayload(b) { if (!isObj(b) || !only(b, ['installationId', 'platform', 'scanning', 'version'])) return null; if (!str(b.installationId, 128) || ('platform' in b && b.platform !== null && !str(b.platform, 64)) || ('scanning' in b && typeof b.scanning !== 'boolean') || ('version' in b && b.version !== null && !str(b.version, 32))) return null; return { installationId: b.installationId, platform: b.platform ?? null, scanning: b.scanning ?? false, version: b.version ?? null }; }
function legacyEventPayload(b) { if (!isObj(b) || !only(b, ['installationId', 'type', 'data'])) return null; if (!str(b.installationId, 128) || !str(b.type, 64) || ('data' in b && !isObj(b.data))) return null; const data = b.data || {}; if (JSON.stringify(data).length > 8192) return null; return { installationId: b.installationId, type: b.type, data }; }

loadAdminState(); loadLicenses(); loadTelemetry(); loadCustomerState(); syncDefaultPrices();

const server = http.createServer(async (req, res) => {
  const origin = allowedOrigin(req);
  if (req.headers.origin && origin === null) return json(req, res, 403, { error: 'origin_not_allowed' });
  if (req.method === 'OPTIONS') return json(req, res, 204, {});
  const url = new URL(req.url, 'http://localhost'), pathname = url.pathname;
  try {
    if (pathname === '/' || pathname === '/app/' || pathname === '/app') return serveFile(res, CUSTOMER_DIR, 'index.html', 'text/html; charset=utf-8') || json(req, res, 404, { error: 'customer_ui_missing' });
    if (pathname === '/customer.css') return serveFile(res, CUSTOMER_DIR, 'styles.css', 'text/css; charset=utf-8') || json(req, res, 404, { error: 'not_found' });
    if (pathname === '/customer.js') return serveFile(res, CUSTOMER_DIR, 'app.js', 'text/javascript; charset=utf-8') || json(req, res, 404, { error: 'not_found' });
    if (pathname === '/terms') return serveFile(res, CUSTOMER_DIR, 'terms.html', 'text/html; charset=utf-8') || json(req, res, 404, { error: 'not_found' });
    if (pathname === '/privacy') return serveFile(res, CUSTOMER_DIR, 'privacy.html', 'text/html; charset=utf-8') || json(req, res, 404, { error: 'not_found' });
    if (pathname === '/refund') return serveFile(res, CUSTOMER_DIR, 'refund.html', 'text/html; charset=utf-8') || json(req, res, 404, { error: 'not_found' });
    if (pathname === '/robots.txt') return serveFile(res, CUSTOMER_DIR, 'robots.txt', 'text/plain; charset=utf-8') || json(req, res, 404, { error: 'not_found' });
    if (pathname === '/sitemap.xml') return serveFile(res, CUSTOMER_DIR, 'sitemap.xml', 'application/xml; charset=utf-8') || json(req, res, 404, { error: 'not_found' });
    if (pathname === '/admin') { res.writeHead(302, { location: '/admin/' }); return res.end(); }
    if (pathname === '/admin/') return serveAdminIndex(res) || json(req, res, 404, { error: 'admin_not_found' });
    const adminAssets = { 'app.js': 'text/javascript; charset=utf-8', 'ops.js': 'text/javascript; charset=utf-8', 'styles.css': 'text/css; charset=utf-8', 'ops.css': 'text/css; charset=utf-8', 'crm.css': 'text/css; charset=utf-8', 'live.css': 'text/css; charset=utf-8' }, adminAsset = pathname.match(/^\/admin\/([^/]+)$/);
    if (adminAsset && adminAssets[adminAsset[1]]) return serveFile(res, ADMIN_DIR, adminAsset[1], adminAssets[adminAsset[1]]) || json(req, res, 404, { error: 'admin_asset_not_found' });
    if (pathname === '/health' && req.method === 'GET') return json(req, res, 200, { ok: true, service: 'ats-api', version: VERSION, time: now(), authConfigured: !!API_KEY, adminAuthConfigured: !!ADMIN_KEY, licenses: licenses.size, storage: 'json', dataDir: DATA_DIR, gateway: 'secure-client-telemetry', operations: true, sales: true, customerAccounts: true, paymentsConfigured: PAYMENTS_CONFIGURED, emailDeliveryConfigured: !!(RESEND_API_KEY && EMAIL_FROM), googleConfigured: !!GOOGLE_CLIENT_ID, lifetimePlan: true });
    if (pathname === '/v1/public/config' && req.method === 'GET') return json(req, res, 200, { product: 'AI Trading Scanner', version: VERSION, plans: publicPlans(), googleClientId: GOOGLE_CLIENT_ID || null, emailDeliveryConfigured: !!(RESEND_API_KEY && EMAIL_FROM), paymentsConfigured: PAYMENTS_CONFIGURED, supportWhatsapp: SUPPORT_WHATSAPP, casaTradeUrl: CASA_TRADE_URL || null, extensionDownloadUrl: EXTENSION_DOWNLOAD_URL || null });

    if (pathname.startsWith('/v1/customer/') && !rate(req, `customer:${pathname}`)) return json(req, res, 429, { error: 'too_many_attempts' });
    if (pathname === '/v1/customer/signup' && req.method === 'POST') { if (!rate(req, 'signup', 5, 3600000)) return json(req, res, 429, { error: 'too_many_attempts' }); const b = await readBody(req), email = cleanEmail(b.email), name = cleanName(b.name), password = String(b.password || ''); if (!isObj(b) || !only(b, ['name', 'email', 'password']) || !validEmail(email) || name.length < 2 || password.length < 8) return json(req, res, 422, { error: 'invalid_signup' }); if (customerState.accounts.some(a => a.email === email)) return json(req, res, 409, { error: 'email_in_use' }); const h = hashPassword(password), account = { id: crypto.randomUUID(), name, email, emailVerified: false, passwordHash: h.hash, passwordSalt: h.salt, createdAt: now(), updatedAt: now(), currentLicenseKey: null, trialClaimedAt: null, commercialPlan: null }; customerState.accounts.push(account); saveCustomerState(); const delivery = await sendVerification(req, account); return json(req, res, 201, { ok: true, verificationRequired: true, emailDeliveryConfigured: delivery.configured, emailSent: delivery.sent, emailError: delivery.error || null }); }
    if (pathname === '/v1/customer/resend-verification' && req.method === 'POST') { if (!rate(req, 'resend', 5, 3600000)) return json(req, res, 429, { error: 'too_many_attempts' }); const b = await readBody(req), email = cleanEmail(b.email); if (!isObj(b) || !only(b, ['email']) || !validEmail(email)) return json(req, res, 422, { error: 'invalid_email' }); const account = customerState.accounts.find(x => x.email === email); if (!account || account.emailVerified) return json(req, res, 200, { ok: true, noop: true, emailDeliveryConfigured: !!(RESEND_API_KEY && EMAIL_FROM), emailSent: false, emailError: null }); const delivery = await sendVerification(req, account); return json(req, res, 200, { ok: true, emailDeliveryConfigured: delivery.configured, emailSent: delivery.sent, emailError: delivery.error || null }); }
    if (pathname === '/v1/customer/verify-email' && req.method === 'POST') { const b = await readBody(req); if (!isObj(b) || !only(b, ['token'])) return json(req, res, 422, { error: 'verification_invalid' }); const t = readToken('email-verify', String(b.token || '')); if (!t) return json(req, res, 400, { error: 'verification_invalid' }); const account = customerState.accounts.find(x => x.id === t.uid && x.email === t.email); if (!account) return json(req, res, 404, { error: 'account_not_found' }); account.emailVerified = true; account.verifiedAt = now(); account.updatedAt = now(); if (!account.currentLicenseKey && !account.trialClaimedAt) ensureTrial(account); saveCustomerState(); return json(req, res, 200, { ok: true, account: publicAccount(account, licenseProfile(account)) }, { 'set-cookie': customerCookie(req, account) }); }
    if (pathname === '/v1/customer/login' && req.method === 'POST') { if (!rate(req, 'login', 10, 60000)) return json(req, res, 429, { error: 'too_many_attempts' }); const b = await readBody(req), email = cleanEmail(b.email); if (!isObj(b) || !only(b, ['email', 'password']) || !validEmail(email)) return json(req, res, 401, { error: 'invalid_credentials' }); const account = customerState.accounts.find(x => x.email === email); if (!account || !verifyPassword(String(b.password || ''), account)) return json(req, res, 401, { error: 'invalid_credentials' }); if (!account.emailVerified) return json(req, res, 403, { error: 'email_not_verified' }); return json(req, res, 200, { ok: true, account: publicAccount(account, licenseProfile(account)) }, { 'set-cookie': customerCookie(req, account) }); }
    if (pathname === '/v1/customer/forgot-password' && req.method === 'POST') { if (!rate(req, 'forgot-password', 5, 3600000)) return json(req, res, 429, { error: 'too_many_attempts' }); const b = await readBody(req), email = cleanEmail(b.email); if (!isObj(b) || !only(b, ['email']) || !validEmail(email)) return json(req, res, 200, { ok: true }); const account = customerState.accounts.find(x => x.email === email); if (account?.emailVerified) await sendPasswordReset(req, account); return json(req, res, 200, { ok: true }); }
    if (pathname === '/v1/customer/reset-password' && req.method === 'POST') { if (!rate(req, 'reset-password', 10, 3600000)) return json(req, res, 429, { error: 'too_many_attempts' }); const b = await readBody(req), password = String(b.password || ''); if (!isObj(b) || !only(b, ['token','password']) || password.length < 8) return json(req, res, 422, { error: 'reset_invalid' }); const t = readToken('password-reset', String(b.token || '')); const account = t ? customerState.accounts.find(x => x.id === t.uid && x.email === t.email) : null; if (!account) return json(req, res, 400, { error: 'reset_invalid' }); const h = hashPassword(password); account.passwordHash = h.hash; account.passwordSalt = h.salt; account.updatedAt = now(); saveCustomerState(); return json(req, res, 200, { ok: true }); }
    if (pathname === '/v1/customer/google' && req.method === 'POST') { if (!GOOGLE_CLIENT_ID) return json(req, res, 503, { error: 'google_not_configured' }); const b = await readBody(req); if (!isObj(b) || !only(b, ['credential'])) return json(req, res, 422, { error: 'google_invalid' }); const g = await verifyGoogleCredential(String(b.credential || '')); let account = customerState.accounts.find(x => x.googleSub === g.sub || x.email === g.email); if (!account) { account = { id: crypto.randomUUID(), name: g.name || g.email.split('@')[0], email: g.email, emailVerified: true, googleSub: g.sub, createdAt: now(), updatedAt: now(), currentLicenseKey: null, trialClaimedAt: null, commercialPlan: null }; customerState.accounts.push(account); } else { account.googleSub = g.sub; account.emailVerified = true; account.name = account.name || g.name; account.updatedAt = now(); } if (!account.currentLicenseKey && !account.trialClaimedAt) ensureTrial(account); saveCustomerState(); return json(req, res, 200, { ok: true, account: publicAccount(account, licenseProfile(account)) }, { 'set-cookie': customerCookie(req, account) }); }
    if (pathname === '/v1/customer/logout' && req.method === 'POST') return json(req, res, 200, { ok: true }, { 'set-cookie': clearCustomerCookie(req) });
    if (pathname === '/v1/customer/me' && req.method === 'GET') { const account = accountFromReq(req); if (!account) return json(req, res, 401, { error: 'unauthorized' }); return json(req, res, 200, { account: publicAccount(account, licenseProfile(account)), orders: customerState.orders.filter(o => o.accountId === account.id).slice(0, 20) }); }
    if (pathname === '/v1/customer/connect-code' && req.method === 'POST') { const account = accountFromReq(req); if (!account) return json(req, res, 401, { error: 'unauthorized' }); if (!account.emailVerified) return json(req, res, 403, { error: 'email_not_verified' }); const lic = licenseProfile(account); if (!lic || lic.status !== 'active' || (lic.expiresAt && Date.parse(lic.expiresAt) <= now())) return json(req, res, 409, { error: 'access_inactive' }); const code = connectCode(), expiresAt = now() + 10 * 60000; connectCodes.set(code, { accountId: account.id, expiresAt, used: false }); return json(req, res, 201, { ok: true, code, expiresAt }); }
    if (pathname === '/v1/customer/extension/exchange' && req.method === 'POST') { if (!rate(req, 'exchange', 20, 60000)) return json(req, res, 429, { error: 'too_many_attempts' }); pruneConnectCodes(); const b = await readBody(req), code = String(b.code || '').replace(/\D/g, ''), installationId = String(b.installationId || '').trim().slice(0, 128), version = String(b.version || '').slice(0, 32), c = connectCodes.get(code); if (!c || c.used || c.expiresAt < now() || !installationId) return json(req, res, 400, { error: 'connect_code_invalid' }); const account = customerState.accounts.find(x => x.id === c.accountId); if (!account || !account.emailVerified) return json(req, res, 403, { error: 'account_not_verified' }); const lic = licenseProfile(account); if ((lic?.plan === 'trial' || (!lic && account.trialClaimedAt)) && customerState.trialDevices[installationId] && customerState.trialDevices[installationId] !== account.id) return json(req, res, 403, { error: 'trial_device_already_used' }); const result = activateForAccount(account, installationId, version); c.used = true; connectCodes.delete(code); if (result.license?.plan === 'trial') { customerState.trialDevices[installationId] = account.id; saveCustomerState(); } return json(req, res, 200, { ok: true, ...result, account: { name: account.name, email: account.email } }); }
    if (pathname === '/v1/customer/extension/refresh' && req.method === 'POST') { const account = accountFromBearer(req); if (!account) return json(req, res, 401, { error: 'account_token_invalid' }); const b = await readBody(req), installationId = String(b.installationId || '').trim().slice(0, 128), version = String(b.version || '').slice(0, 32); if (!installationId) return json(req, res, 422, { error: 'installation_required' }); const result = activateForAccount(account, installationId, version); return json(req, res, 200, { ok: true, ...result }); }
    if (pathname === '/v1/customer/checkout' && req.method === 'POST') { const account = accountFromReq(req); if (!account) return json(req, res, 401, { error: 'unauthorized' }); const b = await readBody(req); if (!isObj(b) || !only(b, ['plan'])) return json(req, res, 422, { error: 'invalid_checkout_request' }); const out = await checkoutPreference(req, account, String(b.plan || '')); return json(req, res, 201, { ok: true, ...out }); }
    if (pathname === '/v1/payments/mercadopago/webhook' && req.method === 'POST') { if (!PAYMENTS_CONFIGURED) return json(req, res, 503, { error: 'payment_not_configured' }); const b = await readBody(req).catch(() => ({})), paymentId = String(url.searchParams.get('data.id') || b?.data?.id || ''); if (!mpSignatureValid(req, url)) return json(req, res, 401, { error: 'invalid_signature' }); const eventKey = String(b?.id || `${paymentId}:${b?.action || ''}`); const previous = paymentEvent(eventKey); if (previous?.state === 'completed') return json(req, res, 200, { ok: true, duplicate: true }); if (!paymentId) { setPaymentEvent(eventKey, 'failed', { error: 'payment_id_required' }); return json(req, res, 422, { error: 'payment_id_required' }); } setPaymentEvent(eventKey, previous?.state === 'processing' ? 'processing' : 'received', { paymentId }); try { setPaymentEvent(eventKey, 'processing', { paymentId }); const result = await processPayment(paymentId); setPaymentEvent(eventKey, 'completed', { paymentId, result }); return json(req, res, 200, { ok: true, status: result?.status || null }); } catch (e) { setPaymentEvent(eventKey, 'failed', { paymentId, error: String(e?.message || e) }); console.error('payment webhook', e?.message || e); return json(req, res, 503, { ok: false, error: 'payment_processing_failed' }); } }

    if (['/v1/license/activate', '/v1/license/validate', '/v1/license/consume'].includes(pathname) && req.method === 'POST') { const p = licenseInput(await readBody(req)); if (!p) return json(req, res, 422, { error: pathname === '/v1/license/consume' ? 'invalid_usage_request' : 'invalid_license_request' }); if (pathname === '/v1/license/consume' && p.type !== 'signal') return json(req, res, 422, { error: 'invalid_usage_request' }); const result = licenseCheck(p, { consume: pathname === '/v1/license/consume' }); if (result.error) return json(req, res, result.status, { ok: false, error: result.error, license: result.license }); if (pathname === '/v1/license/consume') return json(req, res, 200, { ok: true, license: result.license, usage: { dailyLimit: result.license.dailyLimit, usedToday: result.license.usedToday, remainingToday: result.license.remainingToday, totalLimit: result.license.totalLimit, usedTotal: result.license.usedTotal, remainingTotal: result.license.remainingTotal } }); const client = issueClientToken(p.licenseKey, p.installationId); return json(req, res, 200, { ok: true, license: result.license, clientToken: client.token, clientTokenExpiresAt: client.expiresAt }); }
    if (pathname === '/v1/client/heartbeat' && req.method === 'POST') { const identity = clientIdentity(req); if (!identity) return json(req, res, 401, { ok: false, error: 'client_token_invalid' }); const payload = heartbeatPayload(await readBody(req, 32768), identity); liveSessions.set(identity.installationId, payload); resolveSignals(payload); return json(req, res, 200, { ok: true, acceptedAt: now() }); }
    if (pathname === '/v1/client/events' && req.method === 'POST') { const identity = clientIdentity(req); if (!identity) return json(req, res, 401, { ok: false, error: 'client_token_invalid' }); const evt = telemetryEventPayload(await readBody(req, 32768), identity); if (!evt) return json(req, res, 422, { ok: false, error: 'invalid_event' }); liveEvents.unshift(evt); liveEvents = liveEvents.slice(0, 1500); if (evt.type === 'signal_confirmed') recordSignal(evt); else persistTelemetry(); return json(req, res, 201, { ok: true, eventId: evt.id }); }

    if (pathname === '/v1/admin/auth/login' && req.method === 'POST') { if (!ADMIN_KEY) return json(req, res, 503, { error: 'admin_key_not_configured' }); if (!rate(req, 'admin-login', 5, 60000)) return json(req, res, 429, { error: 'too_many_attempts' }); const b = await readBody(req); if (!safeEq(b.adminKey, ADMIN_KEY)) return json(req, res, 401, { error: 'unauthorized' }); audit('admin_login'); return json(req, res, 200, { ok: true, expiresInDays: ADMIN_SESSION_DAYS }, { 'set-cookie': adminSessionCookie(req) }); }
    if (pathname === '/v1/admin/auth/logout' && req.method === 'POST') return json(req, res, 200, { ok: true }, { 'set-cookie': clearAdminSessionCookie(req) });
    if (pathname === '/v1/admin/auth/status' && req.method === 'GET') { if (!adminAuth(req)) return json(req, res, ADMIN_KEY ? 401 : 503, { authenticated: false, error: ADMIN_KEY ? 'unauthorized' : 'admin_key_not_configured' }); return json(req, res, 200, { authenticated: true, sessionDays: ADMIN_SESSION_DAYS }); }
    const protectedLegacy = (pathname === '/v1/session' && req.method === 'POST') || (pathname === '/v1/events' && req.method === 'POST');
    if (protectedLegacy && !apiAuth(req)) return json(req, res, API_KEY ? 401 : 503, { error: API_KEY ? 'unauthorized' : 'api_key_not_configured' });
    if (pathname === '/v1/session' && req.method === 'POST') { const p = sessionPayload(await readBody(req)); if (!p) return json(req, res, 422, { error: 'invalid_session' }); sessions.set(p.installationId, { ...sessions.get(p.installationId), ...p, lastSeen: now() }); return json(req, res, 200, { ok: true, installationId: p.installationId }); }
    if (pathname === '/v1/events' && req.method === 'POST') { const p = legacyEventPayload(await readBody(req)); if (!p) return json(req, res, 422, { error: 'invalid_event' }); legacyEvents.push({ ...p, id: crypto.randomUUID(), createdAt: now() }); if (legacyEvents.length > 10000) legacyEvents.shift(); return json(req, res, 201, { ok: true }); }
    if (pathname.startsWith('/v1/admin/') && !adminAuth(req)) return json(req, res, ADMIN_KEY ? 401 : 503, { error: ADMIN_KEY ? 'unauthorized' : 'api_key_not_configured' });

    if (pathname === '/v1/admin/operations' && req.method === 'GET') return json(req, res, 200, operations());
    if (pathname === '/v1/admin/customer-accounts' && req.method === 'GET') { const rows = customerState.accounts.map(account => ({ ...publicAccount(account, licenseProfile(account)), orders: customerState.orders.filter(o => o.accountId === account.id).length })), active = x => x.license?.status === 'active' && (!x.license.expiresAt || Date.parse(x.license.expiresAt) > now()); return json(req, res, 200, { accounts: rows, summary: { accounts: rows.length, verified: rows.filter(x => x.emailVerified).length, trials: rows.filter(x => active(x) && x.license?.plan === 'trial').length, paid: rows.filter(x => active(x) && x.license?.plan !== 'trial').length, approvedOrders: customerState.orders.filter(x => x.status === 'approved').length } }); }
    if (pathname === '/v1/admin/plans' && req.method === 'GET') return json(req, res, 200, { plans: Object.values(PLANS) });
    const planRoute = pathname.match(/^\/v1\/admin\/plans\/([^/]+)$/);
    if (planRoute && req.method === 'POST') { const updated = updatePlan(decodeURIComponent(planRoute[1]), await readBody(req)); return updated ? json(req, res, 200, { ok: true, plan: updated }) : json(req, res, 404, { error: 'plan_not_found' }); }
    if (pathname === '/v1/admin/settings' && req.method === 'GET') return json(req, res, 200, { settings: adminSettings });
    if (pathname === '/v1/admin/settings' && req.method === 'POST') { const b = await readBody(req); adminSettings = { ...adminSettings, productName: typeof b.productName === 'string' ? b.productName.trim().slice(0, 80) || adminSettings.productName : adminSettings.productName, brandShort: typeof b.brandShort === 'string' ? b.brandShort.trim().slice(0, 12) || adminSettings.brandShort : adminSettings.brandShort, whatsapp: typeof b.whatsapp === 'string' ? b.whatsapp.replace(/\D/g, '').slice(0, 20) : adminSettings.whatsapp, supportText: typeof b.supportText === 'string' ? b.supportText.trim().slice(0, 300) : adminSettings.supportText, trialEnabled: typeof b.trialEnabled === 'boolean' ? b.trialEnabled : adminSettings.trialEnabled }; persistAdminState(); audit('settings_updated'); return json(req, res, 200, { ok: true, settings: adminSettings }); }
    if (pathname === '/v1/admin/licenses' && req.method === 'GET') return json(req, res, 200, { licenses: [...licenses.values()].map(publicLicense).sort((a, b) => b.createdAt - a.createdAt) });
    if (pathname === '/v1/admin/licenses' && req.method === 'POST') { const b = await readBody(req), license = createLicense({ customerName: b.customerName, email: b.email, plan: String(b.plan || 'starter'), days: b.days }); return license ? json(req, res, 201, { ok: true, license }) : json(req, res, 422, { error: 'invalid_plan' }); }
    if (pathname === '/v1/admin/trials' && req.method === 'POST') { if (!adminSettings.trialEnabled) return json(req, res, 403, { error: 'trial_disabled' }); const b = await readBody(req), license = createLicense({ customerName: b.customerName, email: b.email, plan: 'trial', days: b.days }); return json(req, res, 201, { ok: true, license }); }
    const customerRoute = pathname.match(/^\/v1\/admin\/customers\/([^/]+)$/);
    if (customerRoute && req.method === 'GET') { const license = licenses.get(decodeURIComponent(customerRoute[1]).toUpperCase()); return license ? json(req, res, 200, customerProfile(license)) : json(req, res, 404, { error: 'license_not_found' }); }
    if (pathname === '/v1/admin/security' && req.method === 'GET') return json(req, res, 200, { events: securityEvents.slice(0, 200) });
    if (pathname === '/v1/admin/backup' && req.method === 'GET') return json(req, res, 200, { generatedAt: new Date().toISOString(), version: VERSION, settings: adminSettings, plans: PLANS, licenses: [...licenses.values()].map(publicLicense), clients: clientRows(), audit: adminAudit.slice(0, 500), security: securityEvents.slice(0, 500) });
    if (pathname === '/v1/admin/licenses/bulk' && req.method === 'POST') { const b = await readBody(req), keys = Array.isArray(b.keys) ? [...new Set(b.keys.map(x => String(x).toUpperCase()))].slice(0, 100) : []; if (!keys.length || !['activate', 'revoke', 'renew', 'reset-devices'].includes(b.action)) return json(req, res, 422, { error: 'invalid_bulk_action' }); const updated = []; for (const key of keys) { const license = licenses.get(key); if (!license) continue; if (b.action === 'activate' || b.action === 'revoke') { license.status = b.action === 'activate' ? 'active' : 'revoked'; license.updatedAt = now(); saveLicenses(); audit(b.action === 'activate' ? 'license_activated' : 'license_revoked', { licenseKey: license.key, customerName: license.customerName, bulk: true }); updated.push(publicLicense(license)); } else if (b.action === 'renew') updated.push(renewLicense(license, b.days)); else updated.push(resetLicense(license, 'devices')); } audit('bulk_action', { action: b.action, count: updated.length }); return json(req, res, 200, { ok: true, count: updated.length, licenses: updated }); }
    const renewRoute = pathname.match(/^\/v1\/admin\/licenses\/([^/]+)\/renew$/);
    if (renewRoute && req.method === 'POST') { const license = licenses.get(decodeURIComponent(renewRoute[1]).toUpperCase()); if (!license) return json(req, res, 404, { error: 'license_not_found' }); return json(req, res, 200, { ok: true, license: renewLicense(license, (await readBody(req)).days) }); }
    const actionRoute = pathname.match(/^\/v1\/admin\/licenses\/([^/]+)\/(revoke|activate|reset|reset-devices|reset-usage)$/);
    if (actionRoute && req.method === 'POST') { const license = licenses.get(decodeURIComponent(actionRoute[1]).toUpperCase()); if (!license) return json(req, res, 404, { error: 'license_not_found' }); const op = actionRoute[2]; let output; if (op === 'revoke' || op === 'activate') { license.status = op === 'activate' ? 'active' : 'revoked'; license.updatedAt = now(); saveLicenses(); audit(op === 'activate' ? 'license_activated' : 'license_revoked', { licenseKey: license.key, customerName: license.customerName }); output = publicLicense(license); } else output = resetLicense(license, op === 'reset-usage' ? 'usage' : 'devices'); return json(req, res, 200, { ok: true, license: output }); }
    if (pathname === '/v1/admin/clients' && req.method === 'GET') return json(req, res, 200, { clients: clientRows() });
    if (pathname === '/v1/admin/audit' && req.method === 'GET') return json(req, res, 200, { events: adminAudit.slice(0, 100) });
    if (pathname === '/v1/admin/metrics' && req.method === 'GET') { const ts = now(), activeSessions = [...sessions.values()].filter(s => ts - s.lastSeen < 60000), groups = {}; for (const s of activeSessions) { const key = s.platform || 'unknown'; groups[key] = (groups[key] || 0) + 1; } const lic = [...licenses.values()].map(publicLicense), devices = []; for (const license of licenses.values()) for (const d of license.devices || []) devices.push(d); const paidActive = lic.filter(x => x.plan !== 'trial' && x.status === 'active' && (!x.expiresAt || Date.parse(x.expiresAt) > ts)), trialCreated = adminAudit.filter(x => x.action === 'trial_created').length, paidCreated = adminAudit.filter(x => x.action === 'license_created').length; return json(req, res, 200, { installations: sessions.size, online: activeSessions.length, licensedOnline: devices.filter(d => ts - (d.lastSeen || 0) < 60000).length, scanners: activeSessions.filter(s => s.scanning).length, events: legacyEvents.length, licenses: lic.length, activeLicenses: lic.filter(x => x.status === 'active' && (!x.expiresAt || Date.parse(x.expiresAt) > ts)).length, paidLicenses: paidActive.length, estimatedMonthlyRevenue: paidActive.reduce((n, x) => n + cleanNumber(x.price, 0), 0), activeTrials: lic.filter(x => x.plan === 'trial' && x.status === 'active' && (!x.expiresAt || Date.parse(x.expiresAt) > ts)).length, trialSignalsUsed: lic.filter(x => x.plan === 'trial').reduce((n, x) => n + x.usedTotal, 0), revokedLicenses: lic.filter(x => x.status === 'revoked').length, expiredLicenses: lic.filter(x => x.expiresAt && Date.parse(x.expiresAt) <= ts).length, expiringSoon: lic.filter(x => x.status === 'active' && x.expiresAt && Date.parse(x.expiresAt) > ts && Date.parse(x.expiresAt) <= ts + 3 * 86400000).length, signalsToday: lic.reduce((n, x) => n + x.usedToday, 0), renewals: adminAudit.filter(x => x.action === 'license_renewed').length, blockedDeviceAttempts: securityEvents.filter(x => x.action === 'device_blocked').length, deviceChanges: [...licenses.values()].reduce((n, l) => n + (l.deviceHistory || []).length, 0), funnel: { trialsCreated: trialCreated, paidCreated, activePaid: paidActive.length, expired: lic.filter(x => x.expiresAt && Date.parse(x.expiresAt) <= ts).length }, platforms: Object.entries(groups).map(([name, online]) => ({ name, online })), version: VERSION }); }
    return json(req, res, 404, { error: 'not_found' });
  } catch (e) {
    const status = Number(e.status) || ({ too_large: 413, invalid_json: 400 }[e.message] || 400);
    return json(req, res, status, { error: e.message || 'bad_request' });
  }
});

server.listen(PORT, () => console.log(`ATS API v${VERSION} :${PORT} • admin http://localhost:${PORT}/admin/`));
