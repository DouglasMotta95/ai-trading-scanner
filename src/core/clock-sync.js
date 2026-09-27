export function normalizeEpochMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n < 1e12 ? n * 1000 : n;
}

export function clockSync(serverTime, receivedAt = Date.now()) {
  const server = normalizeEpochMs(serverTime);
  const received = normalizeEpochMs(receivedAt) ?? Date.now();
  if (!Number.isFinite(server)) return { synced: false, offsetMs: 0 };
  return { synced: true, offsetMs: server - received };
}

export function platformNow(sync = {}) {
  return Date.now() + (sync.synced ? sync.offsetMs : 0);
}

export function candleCountdown(timeframeMs, sync = {}) {
  const tf = Number(timeframeMs);
  if (!Number.isFinite(tf) || tf <= 0) return { remainingMs: 0, seconds: 0 };
  const now = platformNow(sync);
  const remaining = tf - (now % tf);
  return { remainingMs: remaining, seconds: Math.ceil(remaining / 1000) };
}
