/**
 * Pick the strongest available technical score without allowing a zero from a
 * blocked operational decision to hide a non-zero score from the technical engine.
 * The return value is display-only; it never grants entry authorization.
 */
export function selectTechnicalScore({
  analysisScore,
  technicalScore,
  decisionScore,
  confidenceScore
} = {}) {
  const values = [analysisScore, technicalScore, confidenceScore, decisionScore]
    .map(value => value == null || value === '' ? null : Number(value))
    .filter(value => value != null && Number.isFinite(value))
    .map(value => Math.max(0, Math.min(100, value)));
  return values.find(value => value > 0) ?? values[0] ?? 0;
}

/**
 * Technical readiness and timing authorization are deliberately independent:
 * a missing/stale platform clock may block execution but must not suppress analysis.
 */
export function canShowTechnicalAnalysis({ marketReady = false } = {}) {
  return marketReady === true;
}

export function canShowFinalEntry({
  marketReady = false,
  timingReady = false,
  decisionTimeReady = false,
  expirationReady = false,
  actionable = false
} = {}) {
  return marketReady === true
    && timingReady === true
    && decisionTimeReady === true
    && expirationReady === true
    && actionable === true;
}
