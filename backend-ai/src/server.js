import http from 'node:http';
import crypto from 'node:crypto';

const PORT = Number(process.env.PORT || 8788);
const GEMINI_API_KEY = String(process.env.GEMINI_API_KEY || '').trim();
const GEMINI_MODEL = String(process.env.GEMINI_MODEL || 'gemini-3.8-flash').trim();
const SESSION_SECRET = String(process.env.SESSION_SECRET || '').trim();
const ATS_API_KEY = String(process.env.ATS_API_KEY || '').trim();
const ATS_ADMIN_KEY = String(process.env.ATS_ADMIN_KEY || '').trim();
const REQUEST_TIMEOUT_MS = Math.max(2500, Math.min(12000, Number(process.env.GEMINI_TIMEOUT_MS || 6500)));
const MAX_REQUESTS_PER_MINUTE = Math.max(4, Math.min(60, Number(process.env.GEMINI_RATE_LIMIT_PER_MIN || 20)));

if (SESSION_SECRET.length < 32) throw new Error('SESSION_SECRET must be configured with at least 32 characters');

const b64decode = value => Buffer.from(value, 'base64url').toString('utf8');
const safeEq = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const tokenSecret = crypto.createHash('sha256').update(`ats-client:${SESSION_SECRET || ATS_API_KEY || ATS_ADMIN_KEY || 'development-only'}`).digest();
const tokenSign = payload => crypto.createHmac('sha256', tokenSecret).update(payload).digest('base64url');
const now = () => Date.now();
const num = value => value == null || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null;
const text = (value, max = 180) => String(value ?? '').normalize('NFKC').replace(/[\u0000-\u001f\u007f-\u009f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value) || 0));

function decodeClientToken(raw = '') {
  const [payload, signature] = String(raw).split('.');
  if (!payload || !signature || !safeEq(signature, tokenSign(payload))) return null;
  try {
    const data = JSON.parse(b64decode(payload));
    if (!data.licenseKey || !data.installationId || Number(data.exp) <= now()) return null;
    return data;
  } catch {
    return null;
  }
}

function bearer(req) {
  const h = String(req.headers.authorization || '');
  return h.toLowerCase().startsWith('bearer ') ? h.slice(7).trim() : '';
}

const buckets = new Map();
function allowed(identity) {
  const key = String(identity?.installationId || 'unknown');
  const minute = Math.floor(now() / 60000);
  if (buckets.size > 2000) {
    for (const [bucketKey, row] of buckets) if (Number(row?.minute) < minute - 1) buckets.delete(bucketKey);
  }
  const previous = buckets.get(key);
  if (!previous || previous.minute !== minute) {
    buckets.set(key, { minute, count: 1 });
    return true;
  }
  previous.count += 1;
  return previous.count <= MAX_REQUESTS_PER_MINUTE;
}

function corsHeaders(req) {
  const origin = String(req.headers.origin || '');
  const extensionOrigin = origin.startsWith('chrome-extension://') || origin.startsWith('edge-extension://') ? origin : '';
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'access-control-allow-headers': 'content-type,authorization',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-max-age': '600',
    'vary': 'Origin'
  };
  if (extensionOrigin) headers['access-control-allow-origin'] = extensionOrigin;
  return headers;
}

function json(req, res, status, data) {
  res.writeHead(status, corsHeaders(req));
  res.end(status === 204 ? '' : JSON.stringify(data));
}

function readBody(req, max = 49152) {
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

function candle(value = {}) {
  const open = num(value.open), high = num(value.high), low = num(value.low), close = num(value.close);
  if ([open, high, low, close].some(v => v == null)) return null;
  return { open, high, low, close, time: num(value.time ?? value.timestamp) };
}

function sanitizeSnapshot(body = {}) {
  const rows = Array.isArray(body.candles) ? body.candles.map(candle).filter(Boolean).slice(-10) : [];
  const current = candle(body.currentCandle || {});
  const signal = body.signal && typeof body.signal === 'object' ? body.signal : {};
  const analytics = signal.analytics && typeof signal.analytics === 'object' ? signal.analytics : {};
  const regime = signal.regime && typeof signal.regime === 'object' ? signal.regime : {};
  const waitingFor = signal.waitingFor && typeof signal.waitingFor === 'object' ? signal.waitingFor : {};
  return {
    asset: text(body.asset, 64),
    marketType: text(body.marketType, 40),
    timeframe: text(body.timeframe, 24),
    expiration: text(body.expiration, 24),
    price: num(body.price),
    secondsRemaining: num(body.secondsRemaining),
    targetStart: num(body.targetStart),
    currentCandle: current,
    candles: rows,
    signal: {
      state: text(signal.state, 24),
      uiState: text(signal.uiState, 32),
      phase: text(signal.phase, 24),
      direction: ['BUY', 'SELL'].includes(String(signal.direction || '').toUpperCase()) ? String(signal.direction).toUpperCase() : null,
      analysisDirection: ['BUY', 'SELL'].includes(String(signal.analysisDirection || '').toUpperCase()) ? String(signal.analysisDirection).toUpperCase() : null,
      score: num(signal.score),
      analysisScore: num(signal.analysisScore),
      setup: text(signal.setup, 80),
      reason: text(signal.reason, 260),
      waitingFor: {
        direction: ['BUY', 'SELL'].includes(String(waitingFor.direction || '').toUpperCase()) ? String(waitingFor.direction).toUpperCase() : null,
        text: text(waitingFor.text, 220),
        level: num(waitingFor.level)
      },
      regime: {
        type: text(regime.type, 40),
        efficiency: num(regime.efficiency),
        slope: num(regime.slope)
      },
      analytics: {
        buyPower: num(analytics.buyPower),
        sellPower: num(analytics.sellPower),
        currentStrength: num(analytics.currentStrength),
        rejectionStrength: num(analytics.rejectionStrength),
        rejectionDirection: text(analytics.rejectionDirection, 16),
        continuationDirection: text(analytics.continuationDirection, 16),
        continuationScore: num(analytics.continuationScore),
        momentumDirection: text(analytics.momentumDirection, 16),
        momentumScore: num(analytics.momentumScore),
        breakoutHigh: num(analytics.breakoutHigh),
        breakoutLow: num(analytics.breakoutLow),
        support: num(analytics.support),
        resistance: num(analytics.resistance)
      }
    },
    clock: {
      verified: body.clock?.verified === true,
      role: text(body.clock?.role, 32),
      source: text(body.clock?.source, 48)
    }
  };
}

function snapshotReady(snapshot) {
  return !!snapshot.asset && snapshot.price != null && snapshot.candles.length >= 2 && snapshot.clock.verified === true;
}

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['reinforce', 'caution', 'insufficient'] },
    alignment: { type: 'string', enum: ['aligned', 'conflict', 'neutral'] },
    direction: { type: 'string', enum: ['BUY', 'SELL', 'WAIT'] },
    modelConfidence: { type: 'integer', minimum: 0, maximum: 100 },
    confidenceAdjustment: { type: 'integer', minimum: -10, maximum: 10 },
    summary: { type: 'string' },
    evidence: { type: 'array', items: { type: 'string' }, maxItems: 3 },
    risks: { type: 'array', items: { type: 'string' }, maxItems: 3 }
  },
  required: ['verdict', 'alignment', 'direction', 'modelConfidence', 'confidenceAdjustment', 'summary', 'evidence', 'risks']
};

function prompt(snapshot) {
  return [
    'Você é uma camada secundária de auditoria técnica para um scanner de mercado de curtíssimo prazo.',
    'Analise SOMENTE os dados estruturados recebidos. Não invente preço, candle, indicador, notícia ou contexto externo.',
    'O motor técnico local continua sendo a autoridade principal. Sua função é verificar coerência, apontar conflito e resumir risco.',
    'Nunca execute operação, nunca ordene compra/venda e nunca trate confiança como probabilidade garantida de acerto.',
    'Se os dados forem insuficientes ou contraditórios, use verdict="insufficient" e direction="WAIT".',
    'Use verdict="reinforce" apenas quando direção, candles recentes, força/momentum/rejeição/continuação e regime estiverem coerentes.',
    'Use verdict="caution" quando houver divergência, exaustão, baixa força, conflito com regime, rompimento fraco ou risco de reversão.',
    'confidenceAdjustment é apenas um ajuste explicativo entre -10 e +10 pontos e NÃO altera automaticamente o sinal do scanner.',
    'Responda exclusivamente no JSON do schema.',
    `SNAPSHOT=${JSON.stringify(snapshot)}`
  ].join('\n');
}

function normalizeResult(data = {}) {
  const verdict = ['reinforce', 'caution', 'insufficient'].includes(data.verdict) ? data.verdict : 'insufficient';
  const alignment = ['aligned', 'conflict', 'neutral'].includes(data.alignment) ? data.alignment : 'neutral';
  const direction = ['BUY', 'SELL', 'WAIT'].includes(data.direction) ? data.direction : 'WAIT';
  return {
    verdict,
    alignment,
    direction,
    modelConfidence: Math.round(clamp(data.modelConfidence, 0, 100)),
    confidenceAdjustment: Math.round(clamp(data.confidenceAdjustment, -10, 10)),
    summary: text(data.summary, 220) || 'Sem leitura adicional confiável.',
    evidence: Array.isArray(data.evidence) ? data.evidence.map(v => text(v, 150)).filter(Boolean).slice(0, 3) : [],
    risks: Array.isArray(data.risks) ? data.risks.map(v => text(v, 150)).filter(Boolean).slice(0, 3) : []
  };
}

async function callGemini(snapshot) {
  if (!GEMINI_API_KEY) throw Object.assign(new Error('gemini_not_configured'), { status: 503 });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const startedAt = now();
  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': GEMINI_API_KEY
      },
      signal: controller.signal,
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt(snapshot) }] }],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 420,
          responseMimeType: 'application/json',
          responseSchema: RESPONSE_SCHEMA
        }
      })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(`gemini_http_${response.status}`), { status: 502 });
    const raw = (payload.candidates?.[0]?.content?.parts || []).map(part => String(part?.text || '')).join('').trim();
    if (!raw) throw Object.assign(new Error('gemini_empty_response'), { status: 502 });
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch { throw Object.assign(new Error('gemini_invalid_json'), { status: 502 }); }
    return { ...normalizeResult(parsed), model: GEMINI_MODEL, generatedAt: now(), latencyMs: now() - startedAt };
  } catch (error) {
    if (error?.name === 'AbortError') throw Object.assign(new Error('gemini_timeout'), { status: 504 });
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return json(req, res, 204, {});
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname === '/health' && req.method === 'GET') {
    return json(req, res, 200, { ok: true, service: 'ats-gemini-gateway', configured: !!GEMINI_API_KEY, model: GEMINI_MODEL });
  }
  if (pathname !== '/v1/ai/analyze' || req.method !== 'POST') return json(req, res, 404, { ok: false, error: 'not_found' });

  const identity = decodeClientToken(bearer(req));
  if (!identity) return json(req, res, 401, { ok: false, error: 'client_token_invalid' });
  if (!allowed(identity)) return json(req, res, 429, { ok: false, error: 'ai_rate_limited' });

  try {
    const snapshot = sanitizeSnapshot(await readBody(req));
    if (!snapshotReady(snapshot)) return json(req, res, 422, { ok: false, error: 'insufficient_market_data' });
    const analysis = await callGemini(snapshot);
    return json(req, res, 200, { ok: true, analysis });
  } catch (error) {
    const status = Number(error?.status) || (error?.message === 'too_large' ? 413 : error?.message === 'invalid_json' ? 400 : 500);
    const safe = ['gemini_not_configured', 'gemini_timeout', 'gemini_empty_response', 'gemini_invalid_json', 'too_large', 'invalid_json'].includes(String(error?.message || '')) || /^gemini_http_\d+$/.test(String(error?.message || ''));
    console.error('ai-analysis', String(error?.message || error));
    return json(req, res, status, { ok: false, error: safe ? String(error.message) : 'ai_analysis_failed' });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`ats-gemini-gateway listening on ${PORT} model=${GEMINI_MODEL} configured=${!!GEMINI_API_KEY}`);
});
