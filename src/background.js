import { processSnapshot, resetOrchestrator } from './core/orchestrator.js';
import { readScannerState, updateScannerState } from './services/scanner-state-atomic.js';

// Single owner of technical analysis.
// All acquisition modules only update scannerState. This loop coalesces those
// updates and is the only runtime path allowed to invoke the technical orchestrator.
const ANALYSIS_CADENCE_MS = 450;
const BURST_COALESCE_MS = 80;
const CLOCK_FRESH_MS = 3200;
const ALLOWED_CLOCK_SOURCES = new Set(['trader-dom-countdown', 'network-server-cycle', 'platform-cycle-derived']);

const clean = value => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
const num = value => value == null || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null;
const normTf = value => {
  const raw = clean(value).toUpperCase().replace(/\s+/g, '');
  let match = raw.match(/^([SMH])(\d{1,5})$/);
  if (match && Number(match[2]) > 0) return `${match[1]}${Number(match[2])}`;
  match = raw.match(/^(\d{1,4})(?:M|MIN)$/);
  if (match && Number(match[1]) > 0) return `M${Number(match[1])}`;
  return null;
};
const marketId = value => {
  const raw = clean(value).toUpperCase();
  if (!raw) return '';
  const otc = /(?:\(|\b|[_-])OTC(?:\)|\b)?/i.test(raw);
  const pair = raw.match(/\b([A-Z0-9]{2,20})\s*[\/_-]\s*([A-Z0-9]{2,12})/i);
  return pair ? `${pair[1]}/${pair[2]}${otc ? ' (OTC)' : ''}` : raw;
};
const sameMarket = (a, b) => !!marketId(a) && marketId(a) === marketId(b);
const activeAccess = state => {
  const status = clean(state?.license?.status).toLowerCase();
  return ['active', 'valid'].includes(status)
    || state?.license?.devMode === true
    || state?.license?.plan === 'OWNER_DEV'
    || state?.diagnostics?.access?.ownerDev === true
    || state?.diagnostics?.access?.state === 'owner_dev';
};

function historyFor(state = {}, asset = '') {
  const history = state.marketHistory || {};
  const key = Object.keys(history).find(value => sameMarket(value, asset));
  const rows = key && Array.isArray(history[key]) ? history[key] : Array.isArray(state.candles) ? state.candles : [];
  return rows.filter(row => [row?.open, row?.high, row?.low, row?.close].every(value => num(value) != null)).slice(-180);
}

function candleTime(row = {}) {
  let value = num(row?.time ?? row?.timestamp);
  if (value != null && value > 0 && value < 1e12) value *= 1000;
  return Number.isFinite(value) ? value : null;
}

function journalKey(row = {}) {
  return `${marketId(row.asset)}|${Number(row.targetStart || 0)}|${String(row.direction || '').toUpperCase()}`;
}

function resolveSignalJournal(current = {}, snapshot = {}, issued = null, tfMs = 60000) {
  const now = Date.now();
  const rows = (Array.isArray(current.signalJournal) ? current.signalJournal : []).slice(-249).map(row => ({ ...row }));
  const byKey = new Map(rows.map(row => [journalKey(row), row]));

  if (issued?.direction && issued?.targetStart) {
    const key = journalKey(issued);
    if (!byKey.has(key)) {
      byKey.set(key, {
        key,
        asset: marketId(issued.asset),
        direction: issued.direction,
        targetStart: Number(issued.targetStart),
        activeUntil: Number(issued.activeUntil || Number(issued.targetStart) + tfMs),
        issuedAt: Number(issued.issuedAt || now),
        setup: clean(issued.setup || ''),
        regime: clean(issued.regime || ''),
        technicalScore: Number(issued.score || 0),
        qualityScore: Number(issued.qualityScore || 0),
        qualityFactors: issued.qualityFactors || null,
        resolved: false,
        outcome: null
      });
    }
  }

  const candles = Array.isArray(snapshot.candles) ? snapshot.candles : [];
  for (const row of byKey.values()) {
    if (row.resolved === true) continue;
    if (!sameMarket(row.asset, snapshot.asset)) continue;
    const targetStart = Number(row.targetStart || 0);
    if (!targetStart || now < targetStart + tfMs) continue;
    const target = candles.find(candle => {
      const time = candleTime(candle);
      return time != null && Math.floor(time / tfMs) * tfMs === Math.floor(targetStart / tfMs) * tfMs;
    });
    if (!target) continue;
    const open = num(target.open), close = num(target.close);
    if (open == null || close == null) continue;
    const direction = String(row.direction || '').toUpperCase();
    const delta = close - open;
    const outcome = delta === 0
      ? 'DRAW'
      : direction === 'BUY'
        ? (delta > 0 ? 'WIN' : 'LOSS')
        : (delta < 0 ? 'WIN' : 'LOSS');
    row.resolved = true;
    row.outcome = outcome;
    row.open = open;
    row.close = close;
    row.resolvedAt = now;
  }

  return [...byKey.values()]
    .sort((a,b) => Number(a.issuedAt || 0) - Number(b.issuedAt || 0))
    .slice(-250);
}

function consolidatedSnapshot(state = {}) {
  if (!activeAccess(state) || state.scanner !== 'scanning' || state.connection !== 'online') return null;
  const asset = marketId(state.asset);
  const price = num(state.price);
  const focus = state.diagnostics?.focusedAsset || null;
  const clock = state.diagnostics?.marketClock || null;
  if (!asset || price == null || !focus?.asset || !sameMarket(focus.asset, asset)) return null;
  if (focus.reliable !== true || focus.chartScoped !== true || focus.trustedChartFrame !== true) return null;
  if (!clock || clock.available === false || (!clock.verified && clock.operational !== true)) return null;
  if (!ALLOWED_CLOCK_SOURCES.has(clean(clock.source))) return null;
  if (!sameMarket(clock.asset, asset)) return null;
  if (Number(clock.frameId) !== Number(focus.frameId)) return null;
  if (clean(clock.frameHost).toLowerCase() !== clean(focus.frameHost).toLowerCase()) return null;
  if (Number(clock.at || 0) <= 0 || Date.now() - Number(clock.at) > CLOCK_FRESH_MS) return null;

  const secondsRemaining = num(clock.secondsRemaining);
  if (secondsRemaining == null || secondsRemaining < 0) return null;
  const timeframe = normTf(clock.timeframe || state.analysisTimeframe || state.timeframe);
  if (!timeframe) return null;
  const candles = historyFor(state, asset);
  if (candles.length < 2) return null;

  return {
    platformId: state.platformId || 'casatrade',
    platformName: state.platformName || 'CasaTrade',
    connection: 'online',
    asset,
    price,
    timeframe,
    analysisTimeframe: timeframe,
    expiration: state.platformControls?.observed?.expiration || state.targetExpiration || state.expiration || clock.expiration || null,
    targetExpiration: state.platformControls?.observed?.expiration || state.targetExpiration || state.expiration || clock.expiration || null,
    secondsRemaining,
    serverTime: Date.now(),
    candles,
    capabilities: {
      ...(state.capabilities || {}),
      structuredQuotes: true,
      candles: true
    },
    diagnostics: {
      capture: 'central-consolidated-state',
      clockQuality: clock.verified === true ? 'exact' : 'fallback',
      feedQuality: Number(state.diagnostics?.acquisition?.feedQuality || 0)
    }
  };
}

function rawInputSignature(state = {}, snapshot = null) {
  if (!snapshot) return '';
  const clock = state.diagnostics?.marketClock || {};
  const rows = snapshot.candles || [];
  const tail = rows.slice(-3).map(row => [
    Number(row?.time ?? row?.timestamp ?? 0),
    Number(row?.open ?? 0), Number(row?.high ?? 0), Number(row?.low ?? 0), Number(row?.close ?? 0)
  ]);
  return JSON.stringify([
    snapshot.asset, snapshot.price, snapshot.timeframe, snapshot.expiration,
    snapshot.secondsRemaining, Number(clock.at || 0), clean(clock.source),
    Number(state.lastSeen || 0), tail
  ]);
}

let analysisTimer = null;
let analysisRunning = false;
let pendingForce = false;
let pendingAfterRun = false;
let lastRunAt = 0;
let lastInputSignature = '';
let lastMarketKey = '';
let revision = 0;

function scheduleAnalysis(force = false) {
  pendingForce ||= force;
  if (analysisRunning) {
    pendingAfterRun = true;
    return;
  }
  if (analysisTimer) return;
  const sinceLast = Date.now() - lastRunAt;
  const cadenceDelay = Math.max(0, ANALYSIS_CADENCE_MS - sinceLast);
  const delay = Math.max(BURST_COALESCE_MS, cadenceDelay);
  analysisTimer = setTimeout(() => {
    analysisTimer = null;
    const runForced = pendingForce;
    pendingForce = false;
    runCentralAnalysis(runForced).catch(() => {});
  }, delay);
}

async function runCentralAnalysis(force = false) {
  if (analysisRunning) {
    scheduleAnalysis(force);
    return;
  }
  analysisRunning = true;
  let needsConfirmationFollowup = false;
  try {
    await updateScannerState(current => {
      const snapshot = consolidatedSnapshot(current);
      if (!snapshot) return current;

      const inputSignature = rawInputSignature(current, snapshot);
      if (!force && inputSignature === lastInputSignature) return current;

      const session = current.diagnostics?.marketSession || {};
      const focus = current.diagnostics?.focusedAsset || {};
      const marketKey = [
        snapshot.asset,
        snapshot.analysisTimeframe,
        Number(session.epoch || 0)
      ].join('|');
      // Frame id/host are transport ownership details, not market identity.
      // Reset only when asset, timeframe or real market-session epoch changes.
      if (lastMarketKey && lastMarketKey !== marketKey) resetOrchestrator();
      lastMarketKey = marketKey;

      const processed = processSnapshot(snapshot, current);
      lastInputSignature = inputSignature;
      lastRunAt = Date.now();
      revision += 1;

      const processedUi = clean(processed?.signal?.uiState).toUpperCase();
      const processedDirection = processedUi === 'ENTER_BUY'
        ? 'BUY'
        : processedUi === 'ENTER_SELL'
          ? 'SELL'
          : null;
      const tfMs = snapshot.analysisTimeframe?.startsWith('M')
        ? Math.max(1, Number(snapshot.analysisTimeframe.slice(1)) || 1) * 60_000
        : 60_000;
      const signalTargetStart = num(processed?.signal?.targetStart);
      const existingAdvice = current.entryAdvice || null;
      const existingAdviceActive = existingAdvice
        && sameMarket(existingAdvice.asset, snapshot.asset)
        && Number(existingAdvice.activeUntil || 0) > Date.now();
      const entryAdvice = processedDirection && signalTargetStart
        ? {
            asset: snapshot.asset,
            direction: processedDirection,
            setup: clean(processed?.signal?.setup || ''),
            regime: clean(processed?.signal?.regime?.type || ''),
            score: Number(processed?.signal?.analysisScore ?? processed?.signal?.score ?? 0),
            qualityScore: Number(processed?.signal?.aPlus?.score || processed?.signal?.qualityScore || 0),
            qualityFactors: processed?.signal?.aPlus?.factors || null,
            targetStart: signalTargetStart,
            issuedAt: Date.now(),
            activeUntil: signalTargetStart + tfMs,
            source: 'orchestrator-final-signal'
          }
        : existingAdviceActive
          ? existingAdvice
          : null;
      const signalJournal = resolveSignalJournal(current, snapshot, entryAdvice, tfMs);

      const next = {
        ...current,
        ...processed,
        entryAdvice,
        signalJournal,
        // Raw acquisition state remains authoritative.
        asset: current.asset,
        price: current.price,
        timeframe: current.timeframe || snapshot.timeframe,
        analysisTimeframe: current.analysisTimeframe || snapshot.analysisTimeframe,
        expiration: current.expiration,
        targetExpiration: current.targetExpiration,
        candles: current.candles,
        currentCandle: current.currentCandle || processed?.currentCandle || null,
        marketHistory: current.marketHistory,
        lastSeen: current.lastSeen,
        connection: current.connection,
        platformControls: current.platformControls,
        diagnostics: {
          ...(current.diagnostics || {}),
          ...(processed?.diagnostics || {}),
          focusedAsset: current.diagnostics?.focusedAsset || null,
          marketClock: current.diagnostics?.marketClock || null,
          marketSession: current.diagnostics?.marketSession || null,
          analysisLoop: {
            owner: 'background.js',
            revision,
            cadenceMs: ANALYSIS_CADENCE_MS,
            inputSignature,
            at: lastRunAt
          }
        }
      };

      const seconds = num(snapshot.secondsRemaining);
      const locked = clean(next.decisionCycle?.locked).toUpperCase();
      const confirmed = next.signal?.state === 'CONFIRM' || ['ENTER_BUY', 'ENTER_SELL'].includes(clean(next.signal?.uiState).toUpperCase());
      needsConfirmationFollowup = seconds != null && seconds > 0 && seconds <= 10 && !confirmed && locked !== 'WAIT';
      return next;
    });
  } finally {
    analysisRunning = false;
  }

  if (pendingAfterRun) {
    pendingAfterRun = false;
    scheduleAnalysis(pendingForce);
  }
  if (needsConfirmationFollowup) scheduleAnalysis(true);
}

function observeState(state = {}) {
  const snapshot = consolidatedSnapshot(state);
  if (!snapshot) return;
  const signature = rawInputSignature(state, snapshot);
  if (signature !== lastInputSignature) scheduleAnalysis(false);
}

globalThis.__ATS_RUN_CENTRAL_ANALYSIS__ = runCentralAnalysis;
globalThis.__ATS_SCHEDULE_CENTRAL_ANALYSIS__ = scheduleAnalysis;

chrome.storage?.onChanged?.addListener?.((changes, area) => {
  if (area !== 'local' || !changes.scannerState?.newValue) return;
  observeState(changes.scannerState.newValue);
});

readScannerState().then(observeState).catch(() => {});

const HEALTH_CHECK_MS = 1000;
const RECOVERY_AFTER_MS = 4500;
const RECOVERY_COOLDOWN_MS = 10000;
let lastRecoveryAt = 0;

function acquisitionGaps(state = {}) {
  const gaps = [];
  const focus = state.diagnostics?.focusedAsset || {};
  const clock = state.diagnostics?.marketClock || {};
  const controls = state.platformControls || {};
  const rows = historyFor(state, state.asset || '');
  if (!state.asset || focus.reliable !== true || !sameMarket(focus.asset, state.asset)) gaps.push('ativo');
  if (num(state.price) == null) gaps.push('preço');
  if (rows.length < 10) gaps.push('histórico 10 velas');
  const clockFresh = clock.available !== false
    && Number.isFinite(Number(clock.secondsRemaining))
    && Number(clock.at || 0) > 0
    && Date.now() - Number(clock.at) < CLOCK_FRESH_MS;
  if (!clockFresh) gaps.push('countdown');
  // Expiration is no longer a product gate in the simplified signal flow.
  return gaps;
}

async function recoverAcquisition() {
  const state = await readScannerState().catch(() => null);
  if (!state || !activeAccess(state) || !state.targetTabId) return;
  if (!['scanning','idle'].includes(clean(state.scanner))) return;

  const startedAt = Number(state.diagnostics?.target?.connectedAt || state.diagnostics?.marketSession?.startedAt || 0);
  if (!startedAt || Date.now() - startedAt < RECOVERY_AFTER_MS) return;

  const gaps = acquisitionGaps(state);
  if (!gaps.length) return;

  await updateScannerState(current => ({
    ...current,
    diagnostics: {
      ...(current.diagnostics || {}),
      health: {
        state: 'recovering',
        missing: gaps,
        at: Date.now()
      },
      acquisition: {
        ...(current.diagnostics?.acquisition || {}),
        stage: 'recovering_live_readers',
        reason: `Recuperando leitura real: ${gaps.join(', ')}.`,
        at: Date.now()
      }
    }
  })).catch(() => {});

  if (Date.now() - lastRecoveryAt < RECOVERY_COOLDOWN_MS) return;
  const inject = globalThis.__ATS_INJECT_MODERN_PIPELINE__;
  if (typeof inject !== 'function') return;
  lastRecoveryAt = Date.now();
  await inject(Number(state.targetTabId)).catch(() => false);
}

setInterval(() => recoverAcquisition().catch(() => {}), HEALTH_CHECK_MS);

