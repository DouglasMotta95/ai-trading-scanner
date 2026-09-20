export const MARKET_SWITCH_TIMING = Object.freeze({
  staleFocusProtectionMs: 1200,
  recentSelectionProtectionMs: 1200,
  resyncKickMs: 120,
  resyncFollowupMs: 700
});

export function isWithinSwitchGuard(ageMs = Infinity, limitMs = MARKET_SWITCH_TIMING.staleFocusProtectionMs) {
  const age = Number(ageMs);
  const limit = Number(limitMs);
  return Number.isFinite(age) && age >= 0 && Number.isFinite(limit) && age < limit;
}

export function resyncSchedule() {
  return [0, MARKET_SWITCH_TIMING.resyncKickMs, MARKET_SWITCH_TIMING.resyncFollowupMs];
}

export function protocolTakeoverAllowed({
  oldFocusAgeMs = Infinity,
  recentSelectionAgeMs = Infinity,
  incomingExplicit = false,
  incomingStable = false
} = {}) {
  if (!incomingExplicit || !incomingStable) return false;
  if (isWithinSwitchGuard(oldFocusAgeMs, MARKET_SWITCH_TIMING.staleFocusProtectionMs)) return false;
  if (isWithinSwitchGuard(recentSelectionAgeMs, MARKET_SWITCH_TIMING.recentSelectionProtectionMs)) return false;
  return true;
}

export function realSelectionAgeMs({
  now = Date.now(),
  focus = null,
  selectionLock = null
} = {}) {
  const current = Number(now);
  const focusInteractionAt = focus?.interactionHint === true
    ? Number(focus?.interactionAt || 0)
    : 0;
  const lockAt = selectionLock?.source === 'user-selection'
    ? Number(selectionLock?.at || 0)
    : 0;
  const protectedAt = Math.max(focusInteractionAt, lockAt);
  if (!Number.isFinite(current) || !Number.isFinite(protectedAt) || protectedAt <= 0 || current < protectedAt) return Infinity;
  return current - protectedAt;
}

export function shouldRefreshVisualSelectionLock({
  userSelected = false,
  source = ''
} = {}) {
  return userSelected === true || String(source || '').trim() === 'user-selected-transition';
}
