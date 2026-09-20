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
