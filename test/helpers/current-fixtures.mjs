export const minute = 60_000;

export function bullishHistory(bucket, count = 60) {
  const rows = [];
  let price = 1.02;
  for (let i = count - 1; i >= 0; i -= 1) {
    const open = price;
    const close = open + 0.00105;
    rows.push({
      time: bucket - i * minute,
      open,
      high: close + 0.00035,
      low: open - 0.00035,
      close,
      timeframe: 'M1'
    });
    price = close;
  }
  return rows;
}

export function m1Snapshot(bucket, elapsedMs = 35_000, rows = bullishHistory(bucket), extra = {}) {
  return {
    platformId: 'casatrade',
    platformName: 'CasaTrade',
    connection: 'online',
    asset: 'EUR/USD (OTC)',
    price: rows.at(-1).close,
    timeframe: 'M1',
    analysisTimeframe: 'M1',
    expiration: '60s',
    targetExpiration: '60s',
    serverTime: bucket + elapsedMs,
    secondsRemaining: Math.max(0, Math.ceil((minute - elapsedMs) / 1000)),
    candles: rows,
    capabilities: { structuredQuotes: true, candles: true },
    ...extra
  };
}

export function lockedCycle(bucket, direction = 'BUY') {
  return {
    key: `EUR/USD (OTC)|M1|${bucket + minute}`,
    targetStart: bucket + minute,
    candidateDirection: direction,
    candidateHits: 2,
    possibleDirection: direction,
    possibleScore: 82,
    possibleSince: bucket + 30_000,
    lastPossibleStrongAt: bucket + 35_000,
    oppositeDirection: null,
    oppositeHits: 0,
    oppositeSince: null,
    lastOppositeAt: null,
    directionTransition: null,
    aPlusCandidateAllowed: true,
    aPlusWeakHits: 0,
    lastAPlusWeakAt: null,
    confirmHits: 2,
    lastHitAt: bucket + 52_000,
    locked: 'ENTER',
    direction,
    score: 82,
    setup: 'rejeição',
    reason: 'fixture final entry',
    decidedAt: bucket + 52_000,
    resolved: false
  };
}
