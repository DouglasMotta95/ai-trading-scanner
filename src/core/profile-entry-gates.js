import { getSignalPolicy, getOperationMode } from './analysis.js';

const clean = value => String(value ?? '').trim().toUpperCase();
const numberOrNull = value => value == null || value === '' || !Number.isFinite(Number(value)) ? null : Number(value);

/**
 * Shared profile gate for all decision paths. This evaluates directional eligibility
 * only; callers must also validate connection, active asset, clock and expiration.
 */
export function evaluateProfileEntryGate({
  profile = 'MEDIO', direction = null, score = 0, buyPower = 0, sellPower = 0,
  power = null, secondsRemaining = null, timeframe = 'M1', analytics = {}
} = {}) {
  const policy = getSignalPolicy(profile);
  const side = clean(direction);
  const numericScore = Math.max(0, Math.min(100, Number.isFinite(Number(score)) ? Number(score) : 0));
  const directionalPower = numberOrNull(power) ?? numberOrNull(side === 'BUY' ? buyPower : side === 'SELL' ? sellPower : null) ?? 0;
  const seconds = numberOrNull(secondsRemaining);
  const operation = getOperationMode(timeframe);
  const finalWindowSeconds = operation.timeframe === 'M5' ? 15 : 10;
  const validDirection = side === 'BUY' || side === 'SELL';
  const opposite = side === 'BUY' ? 'SELL' : 'BUY';
  // Direction is not clear when two independent, strong signals point the other way.
  // This conflict check is not an additional confluence minimum.
  const opposingEvidence = [
    clean(analytics.momentumDirection) === opposite && Number(analytics.momentumScore || 0) >= 70,
    clean(analytics.continuationDirection) === opposite && Number(analytics.continuationScore || 0) >= 70,
    clean(analytics.rejectionDirection) === opposite && Number(analytics.rejectionStrength || 0) >= 70
  ].filter(Boolean).length;
  const directionClear = validDirection && opposingEvidence < 2;
  const candidate = directionClear && numericScore >= policy.possibleScore && directionalPower >= 45;
  const inPreparationWindow = seconds != null && seconds > 0 && seconds <= 30;
  const inFinalWindow = seconds != null && seconds > 0 && seconds <= finalWindowSeconds;
  const finalEligible = candidate && numericScore >= policy.finalScore && inFinalWindow;
  return {
    profile: policy.profile, direction: validDirection ? side : null, score: numericScore, power: directionalPower,
    possibleScore: policy.possibleScore, finalScore: policy.finalScore, finalWindowSeconds,
    opposingEvidence, directionClear, candidate, inPreparationWindow, inFinalWindow, finalEligible
  };
}
