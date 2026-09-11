import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_PORT = Number(process.env.PORT || 8787);
const INTERNAL_PORT = Number(process.env.ATS_INTERNAL_PORT || 8790);
const API_KEY = process.env.ATS_API_KEY || '';
const ADMIN_KEY = process.env.ATS_ADMIN_KEY || API_KEY;
const DATA_DIR = path.resolve(process.env.ATS_DATA_DIR || path.resolve(__dirname, '../data'));
const TELEMETRY_FILE = path.join(DATA_DIR, 'telemetry-state.json');
const ADMIN_DIR = path.resolve(__dirname, '../../apps/admin-dashboard');
const TOKEN_TTL_MS = 7 * 86400000;
const liveSessions = new Map();
const validationCache = new Map();
let liveEvents = [];
let signalHistory = [];

const now = () => Date.now();
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
const text = (v, n = 160) => typeof v === 'string' ? v.trim().slice(0, n) : '';
const num = v => Number.isFinite(Number(v)) ? Number(v) : null;
const b64 = value => Buffer.from(value).toString('base64url');
const unb64 = value => Buffer.from(value, 'base64url').toString('utf8');
const safeEq = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const tokenSecret = crypto.createHash('sha256').update(`ats-client:${API_KEY || ADMIN_KEY || 'development-only'}`).digest();
const sign = payload => crypto.createHmac('sha256', tokenSecret).update(payload).digest('base64url');

function loadTelemetry() {
  try {
    const saved = JSON.parse(fs.readFileSync(TELEMETRY_FILE, 'utf8'));
    if (Array.isArray(saved.events)) liveEvents = saved.events.slice(0, 1500);
    if (Array.isArray(saved.signals)) signalHistory = saved.signals.slice(0, 3000);
  } catch {}
}
function persistTelemetry() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(TELEMETRY_FILE, JSON.stringify({ events: liveEvents.slice(0, 1500), signals: signalHistory.slice(0, 3000) }, null, 2));
  } catch {}
}
function issueClientToken(licenseKey, installationId) {
  const data = { licenseKey, installationId, iat: now(), exp: now() + TOKEN_TTL_MS, nonce: crypto.randomBytes(8).toString('hex') };
  const payload = b64(JSON.stringify(data));
  return { token: `${payload}.${sign(payload)}`, expiresAt: data.exp };
}
function decodeClientToken(raw = '') {
  const [payload, signature] = String(raw).split('.');
  if (!payload || !signature || !safeEq(signature, sign(payload))) return null;
  try {
    const data = JSON.parse(unb64(payload));
    if (!data.licenseKey || !data.installationId || Number(data.exp) <= now()) return null;
    return data;
  } catch { return null; }
}
function bearer(req) {
  const h = String(req.headers.authorization || '');
  return h.toLowerCase().startsWith('bearer ') ? h.slice(7).trim() : '';
}
function allowOrigin(req) {
  const o = String(req.headers.origin || '');
  if (!o) return '';
  if (o.startsWith('chrome-extension://') || o.startsWith('edge-extension://')) return o;
  const allowed = String(process.env.CORS_ORIGINS || '').split(',').map(x => x.trim()).filter(Boolean);
  if (allowed.includes('*') || allowed.includes(o)) return o;
  for (const rule of allowed) {
    if (!rule.includes('*')) continue;
    const rx = new RegExp(`^${rule.split('*').map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
    if (rx.test(o)) return o;
  }
  return '';
}
function corsHeaders(req) {
  const o = allowOrigin(req);
  const h = {
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type,authorization,x-api-key,x-admin-key',
    'access-control-max-age': '600',
    'vary': 'Origin'
  };
  if (o) h['access-control-allow-origin'] = o;
  return h;
}
function json(req, res, status, data, extra = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...corsHeaders(req), ...extra });
  res.end(JSON.stringify(data));
}
function readBody(req, max = 65536) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', c => { raw += c; if (raw.length > max) { reject(new Error('too_large')); req.destroy(); } });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new Error('invalid_json')); } });
  });
}

async function internal(pathname, { method = 'GET', body = null, headers = {} } = {}) {
  const h = { 'content-type': 'application/json', ...headers };
  delete h.origin; delete h.Origin; delete h.host; delete h['content-length'];
  const r = await fetch(`http://127.0.0.1:${INTERNAL_PORT}${pathname}`, {
    method,
    headers: h,
    body: body == null || method === 'GET' || method === 'HEAD' ? undefined : JSON.stringify(body),
    redirect: 'manual'
  });
  const raw = await r.text();
  let data = null;
  try { data = raw ? JSON.parse(raw) : {}; } catch { data = raw; }
  return { status: r.status, data, headers: r.headers, raw };
}
async function proxy(req, res) {
  try {
    let body = null;
    if (!['GET','HEAD'].includes(req.method || 'GET')) body = await readBody(req, 131072);
    const headers = {};
    for (const key of ['cookie','x-admin-key','x-api-key','authorization','user-agent']) if (req.headers[key]) headers[key] = req.headers[key];
    const r = await internal(req.url, { method: req.method, body, headers });
    const out = { ...corsHeaders(req) };
    const ct = r.headers.get('content-type'); if (ct) out['content-type'] = ct;
    const loc = r.headers.get('location'); if (loc) out.location = loc;
    const cookie = r.headers.get('set-cookie'); if (cookie) out['set-cookie'] = cookie;
    const cache = r.headers.get('cache-control'); if (cache) out['cache-control'] = cache;
    res.writeHead(r.status, out); res.end(r.raw);
  } catch (e) { json(req, res, 502, { error: 'upstream_unavailable', detail: String(e?.message || e) }); }
}
async function adminOk(req) {
  try {
    const r = await internal('/v1/admin/auth/status', { headers: { cookie: req.headers.cookie || '', 'x-admin-key': req.headers['x-admin-key'] || '' } });
    return r.status === 200;
  } catch { return false; }
}
async function clientIdentity(req) {
  const raw = bearer(req), decoded = decodeClientToken(raw);
  if (!decoded) return null;
  const cached = validationCache.get(raw);
  if (cached && cached.until > now()) return cached.identity;
  try {
    const r = await internal('/v1/license/validate', { method: 'POST', body: { licenseKey: decoded.licenseKey, installationId: decoded.installationId } });
    if (r.status !== 200 || !r.data?.ok) return null;
    const identity = { ...decoded, license: r.data.license };
    validationCache.set(raw, { until: now() + 10000, identity });
    return identity;
  } catch { return null; }
}

function parseDuration(data = {}) {
  const explicit = num(data.durationMs);
  if (explicit != null) return clamp(explicit, 5000, 3600000);
  const source = text(data.expiration || data.timeframe || '', 24).toLowerCase().replace(/\s+/g, '');
  let m = source.match(/^(\d+)s$/); if (m) return clamp(Number(m[1]) * 1000, 5000, 3600000);
  m = source.match(/^(\d+)m(?:in)?$/); if (m) return clamp(Number(m[1]) * 60000, 5000, 3600000);
  m = source.match(/^s(\d+)$/); if (m) return clamp(Number(m[1]) * 1000, 5000, 3600000);
  m = source.match(/^m(\d+)$/); if (m) return clamp(Number(m[1]) * 60000, 5000, 3600000);
  m = source.match(/^h(\d+)$/); if (m) return clamp(Number(m[1]) * 3600000, 5000, 3600000);
  return 60000;
}
function resolveSignals(session) {
  const currentPrice = num(session.price);
  if (currentPrice == null || !session.asset) return false;
  let changed = false;
  for (const s of signalHistory) {
    if (s.outcome !== 'pending' || s.installationId !== session.installationId || s.asset !== session.asset || now() < s.expiresAt) continue;
    if (num(s.entryPrice) == null) continue;
    const delta = currentPrice - s.entryPrice;
    s.exitPrice = currentPrice;
    s.resolvedAt = now();
    s.resultSource = 'scanner_feed_after_expiry';
    if (delta === 0) s.outcome = 'draw';
    else if (s.direction === 'BUY') s.outcome = delta > 0 ? 'win' : 'loss';
    else if (s.direction === 'SELL') s.outcome = delta < 0 ? 'win' : 'loss';
    else s.outcome = 'unknown';
    changed = true;
  }
  if (changed) persistTelemetry();
  return changed;
}
function heartbeatPayload(b = {}, identity) {
  const score = num(b.score);
  return {
    installationId: identity.installationId,
    licenseKey: identity.licenseKey,
    customerName: text(identity.license?.customerName || '', 120),
    plan: text(identity.license?.plan || '', 40),
    platformId: text(b.platformId || '', 64), platformName: text(b.platformName || '', 80),
    connection: text(b.connection || '', 24), scanning: !!b.scanning,
    asset: text(b.asset || '', 64), marketType: text(b.marketType || '', 40),
    timeframe: text(b.timeframe || '', 24), expiration: text(b.expiration || '', 24),
    price: num(b.price), serverTime: num(b.serverTime),
    signalState: text(b.signalState || '', 24), direction: ['BUY','SELL'].includes(b.direction) ? b.direction : null,
    score: score == null ? null : clamp(score, 0, 100), grade: text(b.grade || '', 24), confirmations: text(b.confirmations || '', 32),
    regime: text(b.regime || '', 40), provisional: !!b.provisional,
    feedQuality: num(b.feedQuality) == null ? null : clamp(num(b.feedQuality), 0, 100), structured: !!b.structured,
    latency: num(b.latency), version: text(b.version || '', 32),
    lastSeen: now()
  };
}
function eventPayload(b = {}, identity) {
  const type = text(b.type || '', 64);
  const data = b.data && typeof b.data === 'object' && !Array.isArray(b.data) ? b.data : {};
  if (!type || JSON.stringify(data).length > 16384) return null;
  return {
    id: crypto.randomUUID(), at: now(), type,
    installationId: identity.installationId, licenseKey: identity.licenseKey,
    customerName: text(identity.license?.customerName || '', 120), plan: text(identity.license?.plan || '', 40),
    data
  };
}
function recordSignal(evt) {
  const d = evt.data || {}, direction = text(d.direction || '', 8).toUpperCase(), entryPrice = num(d.entryPrice);
  if (!['BUY','SELL'].includes(direction) || !text(d.asset || '', 64) || entryPrice == null) return;
  const signalId = text(d.signalId || '', 96) || crypto.randomUUID();
  if (signalHistory.some(x => x.signalId === signalId)) return;
  const durationMs = parseDuration(d), entryAt = evt.at;
  signalHistory.unshift({
    signalId, installationId: evt.installationId, licenseKey: evt.licenseKey, customerName: evt.customerName, plan: evt.plan,
    platformId: text(d.platformId || '', 64), platformName: text(d.platformName || '', 80), asset: text(d.asset || '', 64),
    direction, entryPrice, score: clamp(num(d.score) || 0, 0, 100), grade: text(d.grade || '', 24),
    timeframe: text(d.timeframe || '', 24), expiration: text(d.expiration || '', 24), durationMs,
    regime: text(d.regime || '', 40), confirmations: text(d.confirmations || '', 32), feedQuality: clamp(num(d.feedQuality) || 0, 0, 100),
    entryAt, expiresAt: entryAt + durationMs, outcome: 'pending', exitPrice: null, resolvedAt: null, resultSource: null
  });
  signalHistory = signalHistory.slice(0, 3000); persistTelemetry();
}
function operations() {
  const ts = now();
  const sessions = [...liveSessions.values()].map(s => ({ ...s, online: ts - s.lastSeen < 20000 })).sort((a, b) => b.lastSeen - a.lastSeen);
  const resolved = signalHistory.filter(s => ['win','loss','draw'].includes(s.outcome));
  const wins = resolved.filter(s => s.outcome === 'win').length, losses = resolved.filter(s => s.outcome === 'loss').length, draws = resolved.filter(s => s.outcome === 'draw').length;
  const decisive = wins + losses;
  return {
    version: '0.8.0', generatedAt: ts,
    summary: {
      onlineClients: sessions.filter(s => s.online).length,
      scanningClients: sessions.filter(s => s.online && s.scanning).length,
      confirmedSignals: signalHistory.length,
      pendingSignals: signalHistory.filter(s => s.outcome === 'pending').length,
      wins, losses, draws,
      observedAccuracy: decisive ? Math.round((wins / decisive) * 1000) / 10 : null
    },
    sessions: sessions.slice(0, 250),
    signals: signalHistory.slice(0, 250),
    events: liveEvents.slice(0, 250)
  };
}

function serveLocal(res, file, type) {
  try {
    const data = fs.readFileSync(path.join(ADMIN_DIR, file));
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store, max-age=0' }); res.end(data); return true;
  } catch { return false; }
}
async function serveInjectedAdmin(req, res) {
  try {
    const r = await internal('/admin/');
    if (r.status !== 200 || typeof r.raw !== 'string') return proxy(req, res);
    let html = r.raw;
    const headExtras = '<link rel="stylesheet" href="/admin/crm.css?v=0.8.0"><link rel="stylesheet" href="/admin/live.css?v=0.8.0">';
    const bodyExtras = '<script src="/admin/crm.js?v=0.8.0"></script><script src="/admin/live.js?v=0.8.0"></script>';
    if (!html.includes('/admin/crm.css')) html = html.replace('</head>', `${headExtras}</head>`);
    if (!html.includes('/admin/crm.js')) html = html.replace('</body>', `${bodyExtras}</body>`);
    else if (!html.includes('/admin/live.js')) html = html.replace('</body>', '<script src="/admin/live.js?v=0.8.0"></script></body>');
    html = html.replace(/v=0\.6\.0/g, 'v=0.8.0');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store, max-age=0' }); res.end(html);
  } catch { proxy(req, res); }
}

loadTelemetry();
const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
  env: { ...process.env, PORT: String(INTERNAL_PORT) }, stdio: ['ignore', 'pipe', 'pipe']
});
child.stdout.on('data', d => process.stdout.write(`[core] ${d}`));
child.stderr.on('data', d => process.stderr.write(`[core] ${d}`));
child.on('exit', code => { console.error(`ATS core exited with code ${code}`); process.exit(code || 1); });

const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (req.method === 'OPTIONS') return json(req, res, 204, {});

  if (pathname === '/admin/') return serveInjectedAdmin(req, res);
  if (pathname === '/admin/live.js') return serveLocal(res, 'live.js', 'text/javascript; charset=utf-8') || json(req, res, 404, { error: 'not_found' });
  if (pathname === '/admin/live.css') return serveLocal(res, 'live.css', 'text/css; charset=utf-8') || json(req, res, 404, { error: 'not_found' });

  if (pathname === '/health') {
    try {
      const r = await internal('/health');
      return json(req, res, r.status, { ...(r.data || {}), version: '0.8.0', gateway: 'secure-client-telemetry', operations: true });
    } catch { return json(req, res, 503, { ok: false, version: '0.8.0', error: 'core_starting' }); }
  }

  if (['/v1/license/activate','/v1/license/validate','/v1/license/consume'].includes(pathname) && req.method === 'POST') {
    try {
      const b = await readBody(req);
      const r = await internal(pathname, { method: 'POST', body: b });
      if (r.status === 200 && r.data?.ok && (pathname === '/v1/license/activate' || pathname === '/v1/license/validate')) {
        const t = issueClientToken(String(b.licenseKey || '').trim().toUpperCase(), String(b.installationId || '').trim());
        return json(req, res, 200, { ...r.data, clientToken: t.token, clientTokenExpiresAt: t.expiresAt });
      }
      return json(req, res, r.status, r.data);
    } catch (e) { return json(req, res, e.message === 'too_large' ? 413 : 400, { error: e.message || 'bad_request' }); }
  }

  if (pathname === '/v1/client/heartbeat' && req.method === 'POST') {
    const identity = await clientIdentity(req);
    if (!identity) return json(req, res, 401, { ok: false, error: 'client_token_invalid' });
    try {
      const p = heartbeatPayload(await readBody(req, 32768), identity);
      liveSessions.set(identity.installationId, p); resolveSignals(p);
      return json(req, res, 200, { ok: true, acceptedAt: now() });
    } catch (e) { return json(req, res, 422, { ok: false, error: e.message || 'invalid_heartbeat' }); }
  }

  if (pathname === '/v1/client/events' && req.method === 'POST') {
    const identity = await clientIdentity(req);
    if (!identity) return json(req, res, 401, { ok: false, error: 'client_token_invalid' });
    try {
      const evt = eventPayload(await readBody(req, 32768), identity);
      if (!evt) return json(req, res, 422, { ok: false, error: 'invalid_event' });
      liveEvents.unshift(evt); liveEvents = liveEvents.slice(0, 1500);
      if (evt.type === 'signal_confirmed') recordSignal(evt); else persistTelemetry();
      return json(req, res, 201, { ok: true, eventId: evt.id });
    } catch (e) { return json(req, res, 422, { ok: false, error: e.message || 'invalid_event' }); }
  }

  if (pathname === '/v1/admin/operations' && req.method === 'GET') {
    if (!(await adminOk(req))) return json(req, res, 401, { error: 'unauthorized' });
    return json(req, res, 200, operations());
  }

  return proxy(req, res);
});

server.listen(PUBLIC_PORT, () => console.log(`ATS v0.8.0 gateway :${PUBLIC_PORT} -> core :${INTERNAL_PORT}`));
