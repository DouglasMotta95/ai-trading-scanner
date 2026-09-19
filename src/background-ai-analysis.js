import { readScannerState, updateScannerState } from './services/scanner-state-atomic.js';
import { aiSnapshot, aiSnapshotReady, requestAiAnalysis } from './services/ai-analysis.js';

const RETRY_AFTER_MS = 12000;
const recentAttempts = new Map();
const inFlight = new Set();

const text = value => String(value ?? '').trim();
const num = value => value == null || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null;
const effectiveDecision = state => state?.professionalDecision || state?.signal || {};

function aiStage(state = {}) {
  const decision = effectiveDecision(state);
  const ui = text(decision?.uiState).toUpperCase();
  // Gemini is a second opinion only after the primary technical engine has
  // confirmed a final entry. It never runs on POSSIBLE and never unlocks entry.
  if ((ui === 'ENTER_BUY' || ui === 'ENTER_SELL') && decision?.actionable === true) return 'final';
  return null;
}

function directionOf(state = {}) {
  const decision = effectiveDecision(state);
  const ui = text(decision?.uiState).toUpperCase();
  if (ui.includes('BUY')) return 'BUY';
  if (ui.includes('SELL')) return 'SELL';
  const direction = text(decision?.direction || state.signal?.direction).toUpperCase();
  return ['BUY', 'SELL'].includes(direction) ? direction : 'WAIT';
}

function cycleKey(state = {}) {
  const decision = effectiveDecision(state);
  if (text(decision.cycleKey)) return text(decision.cycleKey);
  const signal = state.signal || {};
  const target = num(signal.targetStart);
  if (target == null) return '';
  const timeframe = text(state.analysisTimeframe || signal.timeframe || state.timeframe).toUpperCase();
  return `${text(state.asset).toUpperCase()}|${timeframe}|${Math.round(target / 1000) * 1000}`;
}

function requestKey(state = {}) {
  const stage = aiStage(state);
  const cycle = cycleKey(state);
  if (!stage || !cycle) return '';
  return `${cycle}|${stage}|${directionOf(state)}`;
}

function liveReady(state = {}) {
  if (state.analystPreferences?.geminiEnabled === false) return false;
  if (state.connection !== 'online' || state.platformId !== 'casatrade' || !state.asset || num(state.price) == null) return false;
  if (state.professionalDecision?.timeReady !== true || state.professionalDecision?.expirationReady !== true) return false;
  return aiSnapshotReady(aiSnapshot(state));
}

function shouldReusePreviousFinal(state = {}, stage = '') {
  if (stage !== 'final') return false;
  const previous = state.aiAudit;
  if (!previous || previous.status !== 'ready' || previous.cycleKey !== cycleKey(state)) return false;
  const currentDirection = directionOf(state);
  if (currentDirection === 'WAIT') return false;
  return previous.scannerDirection === currentDirection;
}

function trimAttempts() {
  if (recentAttempts.size <= 60) return;
  const rows = [...recentAttempts.entries()].sort((a, b) => Number(a[1] || 0) - Number(b[1] || 0));
  for (const [key] of rows.slice(0, Math.max(1, rows.length - 40))) recentAttempts.delete(key);
}

async function publishLoading(key, cycle, stage, scannerDirection) {
  await updateScannerState(current => ({
    ...current,
    aiAudit: {
      ...(current.aiAudit || {}),
      status: 'loading',
      requestKey: key,
      cycleKey: cycle,
      stage,
      scannerDirection,
      requestedAt: Date.now(),
      error: null
    }
  }));
}

async function publishResult(key, cycle, stage, scannerDirection, result) {
  await updateScannerState(current => {
    if (requestKey(current) !== key && current.aiAudit?.requestKey !== key) return current;
    if (cycleKey(current) !== cycle) return current;
    if (result?.ok && result.analysis) {
      return {
        ...current,
        aiAudit: {
          status: 'ready',
          requestKey: key,
          cycleKey: cycle,
          stage,
          scannerDirection,
          ...result.analysis,
          receivedAt: Date.now(),
          error: null
        }
      };
    }
    return {
      ...current,
      aiAudit: {
        ...(current.aiAudit || {}),
        status: 'error',
        requestKey: key,
        cycleKey: cycle,
        stage,
        scannerDirection,
        error: text(result?.error || 'ai_analysis_failed'),
        receivedAt: Date.now()
      }
    };
  });
}

async function publishDisabled(state = {}) {
  if (state.aiAudit?.status === 'disabled') return;
  await updateScannerState(current => ({
    ...current,
    aiAudit: { status: 'disabled', receivedAt: Date.now(), error: null }
  }));
}

async function evaluate(state = {}) {
  if (state.analystPreferences?.geminiEnabled === false) {
    await publishDisabled(state);
    return;
  }
  const stage = aiStage(state);
  if (!stage || !liveReady(state)) return;
  if (shouldReusePreviousFinal(state, stage)) return;

  const key = requestKey(state);
  const cycle = cycleKey(state);
  if (!key || !cycle || inFlight.has(key)) return;
  const lastAttempt = Number(recentAttempts.get(key) || 0);
  if (lastAttempt && Date.now() - lastAttempt < RETRY_AFTER_MS) return;
  if (state.aiAudit?.requestKey === key && ['loading', 'ready'].includes(state.aiAudit?.status)) return;

  const scannerDirection = directionOf(state);
  recentAttempts.set(key, Date.now());
  trimAttempts();
  inFlight.add(key);
  await publishLoading(key, cycle, stage, scannerDirection);
  try {
    const latest = await readScannerState();
    if (cycleKey(latest) !== cycle || latest.analystPreferences?.geminiEnabled === false) return;
    const result = await requestAiAnalysis(latest);
    await publishResult(key, cycle, stage, scannerDirection, result);
  } finally {
    inFlight.delete(key);
  }
}

chrome.storage?.onChanged?.addListener?.((changes, area) => {
  if (area !== 'local' || !changes.scannerState?.newValue) return;
  evaluate(changes.scannerState.newValue).catch(() => {});
});

readScannerState().then(state => evaluate(state)).catch(() => {});
