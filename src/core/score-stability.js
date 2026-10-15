const clean = value => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();

function normalizeTimeframe(value = '') {
  const raw = clean(value).toUpperCase().replace(/\s+/g, '');
  let match = raw.match(/^([SMH])(\d{1,5})$/);
  if (match && Number(match[2]) > 0) return `${match[1]}${Number(match[2])}`;
  match = raw.match(/^(\d{1,4})(?:M|MIN)$/);
  if (match && Number(match[1]) > 0) return `M${Number(match[1])}`;
  return null;
}

function timeframeMs(value = 'M1') {
  const timeframe = normalizeTimeframe(value) || 'M1';
  const amount = Number(timeframe.slice(1));
  if (timeframe[0] === 'S') return amount * 1000;
  if (timeframe[0] === 'M') return amount * 60_000;
  return amount * 3_600_000;
}

function epochMs(value) {
  let result = Number(value);
  if (!Number.isFinite(result) || result <= 0) return null;
  if (result < 1e12) result *= 1000;
  return result;
}

/**
 * Build a stable display-only score key for the active candle.
 * Prefer the CasaTrade candle boundary; raw live-candle timestamps are bucketed
 * by timeframe so a price tick cannot accidentally reset the smoothing window.
 */
export function scoreCycleKey({
  asset = '',
  timeframe = '',
  candle = {},
  clock = {},
  targetStart = null,
  now = Date.now()
} = {}) {
  const assetKey = clean(asset).toUpperCase();
  const tf = normalizeTimeframe(timeframe || clock.timeframe || candle.timeframe) || 'M1';
  const duration = timeframeMs(tf);
  const openAt = epochMs(clock.openAt) ?? epochMs(clock.candleOpenAt);
  const closeAt = epochMs(clock.closeAt) ?? epochMs(clock.candleCloseAt);
  const liveCandleAt = epochMs(candle.time ?? candle.timestamp);
  const targetAt = epochMs(targetStart);
  const boundary = openAt != null
    ? Math.floor(openAt / duration) * duration
    : closeAt != null
      ? Math.floor(closeAt / duration) * duration - duration
      : liveCandleAt != null
        ? Math.floor(liveCandleAt / duration) * duration
        : targetAt != null
          ? Math.floor(targetAt / duration) * duration - duration
          : Math.floor((epochMs(now) || Date.now()) / duration) * duration;
  return `${assetKey}|${tf}|${boundary}`;
}

/**
 * Smooth only the value rendered in the panel. The raw technical score continues
 * to drive the decision engine and entry gates unchanged.
 */
export function createScoreStabilizer({
  alpha = 0.20,
  sampleIntervalMs = 650,
  maxPointsPerSecond = 6,
  maxGapMs = 12_000
} = {}) {
  let previousKey = '';
  let previousScore = null;
  let previousAt = 0;

  function reset() {
    previousKey = '';
    previousScore = null;
    previousAt = 0;
  }

  function update({ key = '', rawScore = 0, ready = false, at = Date.now() } = {}) {
    const currentAt = Number.isFinite(Number(at)) ? Number(at) : Date.now();
    const raw = Math.max(0, Math.min(100, Number(rawScore) || 0));
    if (!key) {
      if (previousScore != null && currentAt >= previousAt && currentAt - previousAt <= maxGapMs) return Math.round(previousScore);
      reset();
      return 0;
    }
    if (key !== previousKey) {
      previousKey = key;
      previousScore = ready === true ? raw : null;
      previousAt = currentAt;
      return ready === true ? Math.round(raw) : 0;
    }
    if (ready !== true) {
      if (previousScore != null && currentAt >= previousAt && currentAt - previousAt <= maxGapMs) return Math.round(previousScore);
      previousScore = null;
      previousAt = currentAt;
      return 0;
    }
    if (previousScore == null || currentAt < previousAt || currentAt - previousAt > maxGapMs) {
      previousKey = key;
      previousScore = raw;
      previousAt = currentAt;
      return Math.round(raw);
    }

    const elapsed = Math.max(0, currentAt - previousAt);
    if (elapsed <= 0) return Math.round(previousScore);
    const response = 1 - Math.pow(1 - alpha, elapsed / sampleIntervalMs);
    const desiredDelta = (raw - previousScore) * response;
    const maxDelta = Math.max(0.5, maxPointsPerSecond * elapsed / 1000);
    const delta = Math.max(-maxDelta, Math.min(maxDelta, desiredDelta));
    previousScore = Math.max(0, Math.min(100, previousScore + delta));
    previousAt = currentAt;
    return Math.round(previousScore);
  }

  return { update, reset };
}
