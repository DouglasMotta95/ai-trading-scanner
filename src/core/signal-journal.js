const clean = value => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
const num = value => value == null || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null;

function marketId(value = '') {
  const raw = clean(value).toUpperCase();
  if (!raw) return '';
  const otc = /(?:\(|\b|[_-])OTC(?:\)|\b)?/i.test(raw);
  const pair = raw.match(/\b([A-Z0-9]{2,20})\s*[\/_-]\s*([A-Z0-9]{2,12})/i);
  return pair ? `${pair[1]}/${pair[2]}${otc ? ' (OTC)' : ''}` : raw;
}

function sameMarket(a, b) {
  const left = marketId(a);
  return !!left && left === marketId(b);
}

function candleTime(row = {}) {
  let value = num(row?.time ?? row?.timestamp);
  if (value != null && value > 0 && value < 1e12) value *= 1000;
  return Number.isFinite(value) ? value : null;
}

function journalKey(row = {}) {
  return `${marketId(row.asset)}|${Number(row.targetStart || 0)}|${String(row.direction || '').toUpperCase()}`;
}

function targetRowsFor(candles = [], targetStart = 0, tfMs = 60_000) {
  const targetBucket = Math.floor(Number(targetStart) / tfMs) * tfMs;
  return (Array.isArray(candles) ? candles : [])
    .map(candle => ({ candle, time: candleTime(candle) }))
    .filter(item => item.time != null && item.time >= targetBucket && item.time < targetBucket + tfMs)
    .sort((a, b) => a.time - b.time);
}

function captureEntry(row, targetRows = [], now = Date.now()) {
  if (num(row.entryPrice) != null) return false;
  if (!targetRows.length) return false;
  const open = num(targetRows[0]?.candle?.open);
  if (open == null) return false;
  row.entryPrice = open;
  row.entryQuote = open;
  row.open = open;
  row.entryCapturedAt = Number(targetRows[0]?.time || now);
  row.entrySource = 'target-candle-open';
  row.status = 'ACTIVE';
  return true;
}

export function updateSignalJournal({
  previousRows = [],
  snapshot = {},
  issued = null,
  tfMs = 60_000,
  now = Date.now(),
  limit = 250
} = {}) {
  const rows = (Array.isArray(previousRows) ? previousRows : []).slice(-(limit - 1)).map(row => ({ ...row }));
  const byKey = new Map(rows.map(row => [journalKey(row), row]));

  if (issued?.direction && issued?.targetStart) {
    const key = journalKey(issued);
    if (!byKey.has(key)) {
      byKey.set(key, {
        key,
        asset: marketId(issued.asset),
        direction: String(issued.direction || '').toUpperCase(),
        targetStart: Number(issued.targetStart),
        activeUntil: Number(issued.activeUntil || Number(issued.targetStart) + tfMs),
        issuedAt: Number(issued.issuedAt || now),
        setup: clean(issued.setup || ''),
        regime: clean(issued.regime || ''),
        technicalScore: Number(issued.score || 0),
        qualityScore: Number(issued.qualityScore || 0),
        qualityFactors: issued.qualityFactors || null,
        status: 'PENDING_ENTRY',
        entryPrice: null,
        entryQuote: null,
        entryCapturedAt: null,
        entrySource: null,
        exitPrice: null,
        exitQuote: null,
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
    if (!targetStart) continue;
    const targetEnd = targetStart + tfMs;

    const targetRows = targetRowsFor(candles, targetStart, tfMs);

    // Freeze the entry quote as soon as the target/new candle exists.
    // This is intentionally independent from the later WIN/RED resolution.
    if (now >= targetStart) captureEntry(row, targetRows, now);

    if (now < targetEnd) continue;

    // If the extension missed the exact boundary (sleep/throttling), recover the
    // immutable entry from the target candle OPEN before resolving the result.
    captureEntry(row, targetRows, now);

    const entry = num(row.entryPrice);
    const close = num(targetRows.at(-1)?.candle?.close);
    if (entry == null || close == null) continue;

    const direction = String(row.direction || '').toUpperCase();
    const delta = close - entry;
    const outcome = delta === 0
      ? 'DRAW'
      : direction === 'BUY'
        ? (delta > 0 ? 'WIN' : 'RED')
        : (delta < 0 ? 'WIN' : 'RED');

    row.resolved = true;
    row.status = 'RESOLVED';
    row.outcome = outcome;
    row.exitPrice = close;
    row.exitQuote = close;
    row.close = close;
    row.resolvedAt = Number(now);
  }

  return [...byKey.values()]
    .sort((a, b) => Number(a.issuedAt || 0) - Number(b.issuedAt || 0))
    .slice(-limit);
}
