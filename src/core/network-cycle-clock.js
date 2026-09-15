const clean = value => String(value ?? '').normalize('NFKC').replace(/\s+/g, '').toUpperCase();
const finite = value => value == null || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null;

export function normalizeNetworkTime(value) {
  let time = finite(value);
  if (time == null) return null;
  if (time > 0 && time < 1e11) time *= 1000;
  return Number.isFinite(time) && time > 946684800000 ? time : null;
}

export function networkCycleSeconds(value) {
  const raw = clean(value);
  let match = raw.match(/^S(\d{1,5})$/) || raw.match(/^(\d{1,5})S$/);
  if (match && Number(match[1]) > 0) return Number(match[1]);
  match = raw.match(/^M(\d{1,4})$/) || raw.match(/^(\d{1,4})M$/);
  if (match && Number(match[1]) > 0) return Number(match[1]) * 60;
  match = raw.match(/^H(\d{1,3})$/) || raw.match(/^(\d{1,3})H$/);
  if (match && Number(match[1]) > 0) return Number(match[1]) * 3600;
  return null;
}

export function advanceNetworkCycleClock(previous = {}, input = {}) {
  const now = Number(input.now || Date.now());
  const serverTime = normalizeNetworkTime(input.timestamp);
  const duration = networkCycleSeconds(input.timeframe);
  const confidence = Math.max(0, Math.min(100, Number(input.confidence || 0)));
  const baseProbe = { serverTime, observedAt: now, count: 0, timeframe: clean(input.timeframe), confidence };
  if (serverTime == null || duration == null || duration <= 0 || confidence < 55) return { probe: baseProbe, clock: null };

  // A candle-open timestamp can look like server time near the boundary. Require the
  // structured timestamp to advance with real time before promoting it to authority.
  const drift = Math.abs(now - serverTime);
  if (drift > 7000) return { probe: baseProbe, clock: null };
  const oldServerTime = normalizeNetworkTime(previous.serverTime);
  const oldObservedAt = finite(previous.observedAt);
  const serverDelta = oldServerTime == null ? null : serverTime - oldServerTime;
  const localDelta = oldObservedAt == null ? null : now - oldObservedAt;
  const progressed = serverDelta != null && localDelta != null
    && serverDelta > 0 && serverDelta <= 5000
    && localDelta > 0 && localDelta <= 5000
    && Math.abs(serverDelta - localDelta) <= 1800;
  const count = progressed ? Math.min(8, Math.max(1, Number(previous.count || 1)) + 1) : 1;
  const probe = { ...baseProbe, count };
  if (count < 2) return { probe, clock: null };

  const durationMs = duration * 1000;
  const elapsed = ((serverTime % durationMs) + durationMs) % durationMs;
  let secondsRemaining = Math.ceil((durationMs - elapsed) / 1000);
  if (!Number.isFinite(secondsRemaining) || secondsRemaining <= 0 || secondsRemaining > duration) secondsRemaining = duration;
  return {
    probe,
    clock: {
      timeframe: clean(input.timeframe), secondsRemaining, available: true, verified: true,
      role: 'candle-close', source: 'network-server-cycle', mode: 'structured-server-time',
      confidence, serverTime, at: now
    }
  };
}
