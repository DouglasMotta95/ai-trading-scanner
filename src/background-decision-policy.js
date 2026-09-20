import { readScannerState, updateScannerState } from './services/scanner-state-atomic.js';

// Product policy layer. The technical engine can keep collecting evidence with an
// estimated clock, but the user-facing decision is never promoted while CasaTrade
// time is not authoritative. This also owns Normal/A+ confluence and the stable hold.
const EXACT_CLOCK_SOURCES = new Set(['trader-dom-countdown', 'network-server-cycle']);
const CLOCK_FRESH_MS = 3000;
const FOCUS_FRESH_MS = 5500;
const DEFAULT_PREFS = Object.freeze({ mode: 'A_PLUS', operatingTimeframe: 'M1', geminiEnabled: true, holdSeconds: 3, preferredExpiration: '60s' });

const num = value => value == null || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null;
const text = value => String(value ?? '').trim();
const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value) || 0));
const marketId = value => {
  const raw = text(value).normalize('NFKC').toUpperCase().replace(/\s+/g, ' ');
  if (!raw) return '';
  const otc = /(?:\(|\b|[_-])OTC(?:\)|\b)?/i.test(raw);
  const pair = raw.match(/\b([A-Z0-9]{2,20})\s*[\/_-]\s*([A-Z0-9]{2,12})/i);
  return pair ? `${pair[1]}/${pair[2]}${otc ? ' (OTC)' : ''}` : raw;
};
const sameMarket = (a, b) => !!marketId(a) && marketId(a) === marketId(b);
const normTf = value => {
  const raw = text(value).toUpperCase().replace(/\s+/g, '');
  let match = raw.match(/^([SMH])(\d{1,5})$/);
  if (match && Number(match[2]) > 0) return `${match[1]}${Number(match[2])}`;
  match = raw.match(/^(\d{1,4})(?:M|MIN)$/);
  if (match && Number(match[1]) > 0) return `M${Number(match[1])}`;
  match = raw.match(/^(\d{1,5})S$/);
  if (match && Number(match[1]) > 0) return `S${Number(match[1])}`;
  return null;
};
const normExp = value => {
  const raw = text(value).toLowerCase().replace(/\s+/g, '');
  let match = raw.match(/^(\d{1,5})(?:s|seg|segundo|segundos)$/);
  if (match) return `${Number(match[1])}s`;
  match = raw.match(/^(\d{1,4})(?:m|min|minuto|minutos)$/);
  if (match) return `${Number(match[1]) * 60}s`;
  match = raw.match(/^(\d{1,3}):(\d{2})$/);
  if (match) return `${Number(match[1]) * 60 + Number(match[2])}s`;
  return null;
};

function preferences(state = {}) {
  const raw = state.analystPreferences || {};
  const operatingTimeframe = normTf(raw.operatingTimeframe) === 'M1' ? 'M1' : 'M5';
  return {
    mode: 'A_PLUS',
    operatingTimeframe,
    geminiEnabled: raw.geminiEnabled !== false,
    holdSeconds: 3,
    preferredExpiration: operatingTimeframe === 'M1' ? '60s' : '300s'
  };
}

function focusReady(state = {}) {
  const focus = state.diagnostics?.focusedAsset || null;
  if (!focus?.asset || !state.asset) return false;
  return focus.reliable === true
    && focus.chartScoped === true
    && focus.trustedChartFrame === true
    && (focus.embeddedTrader === true || focus.casaTradeFrame === true)
    && sameMarket(focus.asset, state.asset)
    && Number(focus.at || 0) > 0
    && Date.now() - Number(focus.at) < FOCUS_FRESH_MS;
}

export function exactCasaTradeTime(state = {}) {
  const focus = state.diagnostics?.focusedAsset || null;
  const clock = state.diagnostics?.marketClock || null;
  if (!focusReady(state) || !clock) return { ready: false, reason: 'Ativo/gráfico ainda não confirmado.' };
  if (clock.available === false || clock.verified !== true || clock.role !== 'candle-close') {
    return { ready: false, reason: 'Relógio exato da vela ainda não foi confirmado.' };
  }
  if (!EXACT_CLOCK_SOURCES.has(text(clock.source))) return { ready: false, reason: 'Fonte de tempo não autoritativa.' };
  if (!sameMarket(clock.asset, state.asset)) return { ready: false, reason: 'Relógio pertence a outro ativo.' };
  if (Number(clock.frameId) !== Number(focus.frameId)) return { ready: false, reason: 'Relógio pertence a outro gráfico.' };
  if (text(clock.frameHost).toLowerCase() !== text(focus.frameHost).toLowerCase()) return { ready: false, reason: 'Relógio pertence a outro frame.' };
  if (Date.now() - Number(clock.at || 0) >= CLOCK_FRESH_MS) return { ready: false, reason: 'Relógio da CasaTrade ficou desatualizado.' };
  if (num(clock.secondsRemaining) == null) return { ready: false, reason: 'Countdown da CasaTrade indisponível.' };

  const liveTf = normTf(clock.timeframe);
  const stateTf = normTf(state.analysisTimeframe || state.timeframe);
  const controlTf = normTf(state.platformControls?.observed?.timeframe);
  const expectedTf = preferences(state).operatingTimeframe;
  if (!liveTf) return { ready: false, reason: 'Timeframe real ainda não foi confirmado.' };
  if (liveTf !== expectedTf) return { ready: false, reason: `Ajuste o timeframe da CasaTrade para ${expectedTf}.` };
  if (stateTf && liveTf !== stateTf) return { ready: false, reason: 'Timeframe interno divergiu do gráfico.' };
  if (controlTf && liveTf !== controlTf) return { ready: false, reason: 'Timeframe visível divergiu do clock da vela.' };
  return { ready: true, timeframe: liveTf, secondsRemaining: Number(clock.secondsRemaining), source: clock.source };
}

export function CasaTradeExpiration(state = {}, timeframe = null) {
  const controls = state.platformControls || {};
  const expirationAt = Number(controls.expirationCheckedAt || controls.observed?.observedAt?.expiration || 0);
  const observed = normExp(controls.observed?.expiration);
  const fresh = expirationAt > 0 && !!observed;
  const startedAt = Number(state.diagnostics?.marketSession?.startedAt || state.diagnostics?.target?.connectedAt || 0);
  const waiting = startedAt > 0 && Date.now() - startedAt < 5000;
  if (!observed || !fresh) return {
    ready: false,
    actual: null,
    reason: waiting
      ? 'Lendo expiração real da CasaTrade'
      : 'Não foi possível ler a expiração — verifique o seletor na CasaTrade'
  };
  const tf = normTf(timeframe || state.analysisTimeframe || state.timeframe) || preferences(state).operatingTimeframe;
  const required = tf === 'M1' ? '60s' : '300s';
  if (observed !== required) {
    return { ready: false, actual: observed, required, reason: `Ajuste a expiração da CasaTrade para ${tf === 'M1' ? '1 minuto' : '5 minutos'}` };
  }
  return { ready: true, actual: observed, required, reason: `Expiração de ${tf === 'M1' ? '1 minuto' : '5 minutos'} lida diretamente da CasaTrade.` };
}

function completeCandles(state = {}) {
  return (Array.isArray(state.candles) ? state.candles : []).filter(row =>
    [row?.open, row?.high, row?.low, row?.close].every(value => num(value) != null)
  );
}

function signalDirection(signal = {}) {
  const ui = text(signal.uiState).toUpperCase();
  if (ui.includes('BUY')) return 'BUY';
  if (ui.includes('SELL')) return 'SELL';
  const direction = text(signal.analysisDirection || signal.direction).toUpperCase();
  return ['BUY', 'SELL'].includes(direction) ? direction : null;
}

function confluence(signal = {}, direction = null) {
  if (!direction) return { count: 0, factors: [] };
  const a = signal.analytics || {};
  const factors = [];
  const power = Number(direction === 'BUY' ? a.buyPower : a.sellPower) || 0;
  if (power >= 50) factors.push(direction === 'BUY' ? 'poder comprador' : 'poder vendedor');
  if (Number(a.currentStrength || 0) >= 62) factors.push('força da vela');
  if (text(a.rejectionDirection).toUpperCase() === direction && Number(a.rejectionStrength || 0) >= 50) factors.push('rejeição');
  if (text(a.continuationDirection).toUpperCase() === direction && Number(a.continuationScore || 0) >= 60) factors.push('continuação');
  if (text(a.momentumDirection).toUpperCase() === direction && Number(a.momentumScore || 0) >= 45) factors.push('momentum');
  const setup = text(signal.setup).toLowerCase();
  if (/romp|breakout|support|resist|suporte|resistência|resistencia/.test(setup)) factors.push('estrutura');
  return { count: new Set(factors).size, factors: [...new Set(factors)] };
}

function shortReason(direction, factors = [], fallback = '') {
  if (factors.length >= 2) {
    const labels = factors.slice(0, 2).join(' + ');
    return `${labels.charAt(0).toUpperCase()}${labels.slice(1)} alinhados para ${direction === 'BUY' ? 'compra' : 'venda'}.`;
  }
  const cleanFallback = text(fallback).replace(/^Aguardando\s+/i, '').replace(/\.$/, '');
  return cleanFallback ? `${cleanFallback}.` : 'Confluência técnica ainda insuficiente.';
}

function cycleKey(state = {}, signal = {}) {
  const asset = marketId(state.asset || '');
  const timeframe = normTf(state.analysisTimeframe || state.timeframe || signal.timeframe) || 'UNCONFIRMED';
  const target = num(signal.targetStart) ?? num(state.decisionCycle?.targetStart) ?? num(state.diagnostics?.marketClock?.closeAt);
  return `${asset}|${timeframe}|${target == null ? 'pending' : Math.round(target / 1000) * 1000}`;
}

function simpleEntryTiming(state = {}, signal = {}) {
  const now = Date.now();
  const clock = state.diagnostics?.marketClock || {};
  const timeframe = normTf(clock.timeframe || state.analysisTimeframe || state.timeframe || signal.timeframe)
    || preferences(state).operatingTimeframe;
  const durationSeconds = timeframe === 'M5' ? 300 : 60;
  const clockSeconds = num(clock.secondsRemaining);
  const clockFresh = clockSeconds != null
    && clockSeconds >= 0
    && clockSeconds <= durationSeconds + 2
    && Number(clock.at || 0) > 0
    && now - Number(clock.at) < 6000;
  if (clockFresh) {
    return {
      ready: true,
      secondsRemaining: clockSeconds,
      source: text(clock.source || 'market-clock'),
      timeframe
    };
  }

  const signalSeconds = num(signal.secondsRemaining);
  if (signalSeconds != null && signalSeconds >= 0 && signalSeconds <= durationSeconds + 2) {
    return {
      ready: true,
      secondsRemaining: signalSeconds,
      source: 'technical-signal-clock',
      timeframe
    };
  }

  const candidates = [
    state.currentCandle,
    signal.currentCandle,
    Array.isArray(state.candles) ? state.candles.at(-1) : null
  ].filter(Boolean);
  for (const row of candidates) {
    let openAt = num(row?.time ?? row?.timestamp);
    if (openAt != null && openAt > 0 && openAt < 1e12) openAt *= 1000;
    if (!Number.isFinite(openAt)) continue;
    const closeAt = openAt + durationSeconds * 1000;
    if (now < openAt - 1500 || now > closeAt + 1500) continue;
    const secondsRemaining = Math.max(0, Math.min(durationSeconds, Math.ceil((closeAt - now) / 1000)));
    return { ready: true, secondsRemaining, source: 'current-candle-boundary', timeframe };
  }

  return { ready: false, secondsRemaining: null, source: null, timeframe };
}

function baseDecision(state = {}) {
  const pref = preferences(state);
  const signal = state.signal || {};
  const now = Date.now();
  const timing = simpleEntryTiming(state, signal);
  const rows = completeCandles(state);
  const ui = text(signal.uiState).toUpperCase();
  const direction = ui.includes('BUY') ? 'BUY' : ui.includes('SELL') ? 'SELL' : null;
  const score = Number(signal.analysisScore ?? signal.score ?? 0) || 0;
  const cycle = cycleKey(state, signal);
  const factors = confluence(signal, direction);
  const previous = state.professionalDecision || {};
  const sameCycleDirection = previous.cycleKey === cycle && previous.direction === direction;
  const possibleSince = sameCycleDirection && Number(previous.possibleSince || 0) > 0
    ? Number(previous.possibleSince)
    : now;

  const common = {
    profile: pref.mode,
    holdSeconds: pref.holdSeconds,
    cycleKey: cycle,
    score,
    confluence: factors.count,
    factors: factors.factors,
    timeReady: timing.ready,
    expirationReady: true,
    actualExpiration: null,
    timeSource: timing.source,
    timeframe: timing.timeframe || normTf(state.analysisTimeframe || state.timeframe) || 'M1',
    secondsRemaining: timing.secondsRemaining,
    possibleSince,
    holdRemainingMs: 0,
    updatedAt: now
  };

  if (!state.asset || num(state.price) == null || !focusReady(state)) {
    return {
      ...common,
      uiState: 'ANALYZING_MARKET',
      direction: null,
      actionable: false,
      alert: 'silent',
      possibleSince: null,
      reason: 'Identificando o ativo e a cotação do gráfico atual.'
    };
  }

  if (rows.length < 2) {
    return {
      ...common,
      uiState: 'BUILDING_PATTERN',
      direction: null,
      actionable: false,
      alert: 'silent',
      possibleSince: null,
      reason: 'Montando o padrão com as velas reais da CasaTrade.'
    };
  }

  // Single authority rule: professionalDecision mirrors the orchestrator signal.
  // It must never invent a POSSÍVEL from score, erase one because score dipped,
  // or choose a direction independently from state.signal.
  if (ui === 'ENTER_BUY' || ui === 'ENTER_SELL') {
    return {
      ...common,
      uiState: ui,
      direction,
      actionable: true,
      alert: 'strong',
      reason: text(signal.reason || `ENTRAR AGORA: ${direction === 'BUY' ? 'COMPRA' : 'VENDA'}.`)
    };
  }

  if (ui === 'POSSIBLE_BUY' || ui === 'POSSIBLE_SELL') {
    return {
      ...common,
      uiState: ui,
      direction,
      actionable: false,
      alert: 'discrete',
      reason: text(signal.reason || `POSSÍVEL ${direction === 'BUY' ? 'COMPRA' : 'VENDA'} — aguardando confirmação final na janela operacional.`)
    };
  }

  if (ui === 'ANALYZING_MARKET' || ui === 'BUILDING_PATTERN' || ui === 'DECIDING') {
    return {
      ...common,
      uiState: ui,
      direction: null,
      actionable: false,
      alert: 'silent',
      possibleSince: null,
      reason: text(signal.reason || 'Analisando o padrão da vela atual.')
    };
  }

  return {
    ...common,
    uiState: 'WAIT',
    direction: null,
    actionable: false,
    alert: 'silent',
    possibleSince: null,
    reason: text(signal.reason || 'AGUARDAR — nenhum padrão confirmado para esta vela.')
  };
}

function signature(value = {}) {
  return JSON.stringify({
    uiState: value.uiState || null,
    direction: value.direction || null,
    actionable: !!value.actionable,
    profile: value.profile || null,
    holdSeconds: value.holdSeconds || null,
    cycleKey: value.cycleKey || null,
    score: value.score || 0,
    confluence: value.confluence || 0,
    factors: value.factors || [],
    timeReady: !!value.timeReady,
    expirationReady: !!value.expirationReady,
    actualExpiration: value.actualExpiration || null,
    timeSource: value.timeSource || null,
    timeframe: value.timeframe || null,
    secondsRemaining: value.secondsRemaining ?? null,
    possibleSince: value.possibleSince || null,
    holdRemainingBucket: value.holdRemainingMs == null ? null : Math.ceil(Number(value.holdRemainingMs) / 250),
    reason: value.reason || ''
  });
}

let writing = false;
async function evaluate(state = {}) {
  if (writing) return;
  const decision = baseDecision(state);
  if (signature(decision) === signature(state.professionalDecision || {})) return;
  writing = true;
  try {
    await updateScannerState(current => {
      const next = baseDecision(current);
      if (signature(next) === signature(current.professionalDecision || {})) return current;
      return { ...current, professionalDecision: next };
    });
  } finally {
    writing = false;
  }
}

chrome.storage?.onChanged?.addListener?.((changes, area) => {
  if (area !== 'local' || !changes.scannerState?.newValue) return;
  evaluate(changes.scannerState.newValue).catch(() => {});
});

setInterval(() => readScannerState().then(evaluate).catch(() => {}), 500);
readScannerState().then(evaluate).catch(() => {});
