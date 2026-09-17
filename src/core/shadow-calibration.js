import { assessAssetQuality } from './asset-quality.js';

const num = value => value == null || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null;
const clean = value => String(value ?? '').trim();
const assetId = value => {
  const raw = clean(value).normalize('NFKC').toUpperCase().replace(/\s+/g, ' ').trim();
  if (!raw) return '';
  const otc = /(?:\(|\b|[_-])OTC(?:\)|\b)?/i.test(raw);
  const pair = raw.match(/\b([A-Z0-9]{2,20})\s*[\/_-]\s*([A-Z0-9]{2,12})/i);
  return pair ? `${pair[1]}/${pair[2]}${otc ? '(OTC)' : ''}` : raw.replace(/\s+/g, '');
};
const sameAsset = (a, b) => !!assetId(a) && assetId(a) === assetId(b);

function candleTime(row = {}) {
  let time = num(row.time ?? row.timestamp);
  if (time != null && time > 0 && time < 1e12) time *= 1000;
  return time;
}

function lossReason(row = {}) {
  const regime = clean(row.regime).toLowerCase();
  const waitingType = clean(row.waitingType).toLowerCase();
  const setup = clean(row.setup).toLowerCase();
  if (regime === 'range' || /lateral|range/.test(clean(row.reason).toLowerCase())) return 'MERCADO LATERAL';
  if (Number(row.lossOfStrength || 0) >= 55) return 'PERDA DE FORÇA';
  if (Number(row.momentumScore || 0) < 35) return 'MOMENTUM FRACO';
  if (Number(row.currentStrength || 0) < 45) return 'VELA FRACA';
  if (waitingType === 'breakout' || /breakout|romp/.test(setup)) return 'ROMPIMENTO FALHOU';
  if (waitingType === 'rejection' || /rejei/.test(setup)) return 'REJEIÇÃO FALHOU';
  return 'SETUP FALHOU';
}

export function shadowRecordFromState(state = {}) {
  const cycle = state.decisionCycle || {};
  if (!['ENTER', 'SKIP'].includes(cycle.locked)) return null;
  const asset = clean(state.asset || state.diagnostics?.marketSession?.asset || '');
  const timeframe = clean(state.analysisTimeframe || state.timeframe || '').toUpperCase();
  const targetStart = num(cycle.targetStart);
  if (!asset || !timeframe || targetStart == null) return null;
  const signal = state.signal || {};
  const analytics = signal.analytics || {};
  const quality = assessAssetQuality(state);
  const shadowDirection = ['BUY','SELL'].includes(cycle.direction) ? cycle.direction
    : ['BUY','SELL'].includes(signal.analysisDirection) ? signal.analysisDirection
      : ['BUY','SELL'].includes(cycle.candidateDirection) ? cycle.candidateDirection : null;
  return {
    key: `${assetId(asset)}|${timeframe}|${Math.round(targetStart)}`,
    asset, timeframe, targetStart: Math.round(targetStart),
    decision: cycle.locked, direction: cycle.direction || null, shadowDirection,
    score: Number(cycle.score ?? signal.analysisScore ?? signal.score ?? 0),
    setup: cycle.setup || signal.setup || null,
    regime: signal.regime?.type || null,
    waitingType: signal.waitingFor?.type || null,
    qualityScore: quality.score,
    qualityStatus: quality.status,
    buyPower: Number(analytics.buyPower || 0),
    sellPower: Number(analytics.sellPower || 0),
    currentStrength: Number(analytics.currentStrength || 0),
    momentumScore: Number(analytics.momentumScore || 0),
    lossOfStrength: Number(analytics.lossOfStrength || 0),
    reason: clean(cycle.reason || signal.reason || ''),
    createdAt: Number(cycle.decidedAt || Date.now()),
    result: null, resolvedAt: null, open: null, close: null, outcomeReason: null
  };
}

export function mergeShadowRecord(rows = [], record = null, limit = 500) {
  const list = Array.isArray(rows) ? rows.slice() : [];
  if (!record?.key) return list.slice(-limit);
  const index = list.findIndex(row => row?.key === record.key);
  if (index >= 0) list[index] = {
    ...list[index], ...record,
    result: list[index].result || record.result || null,
    resolvedAt: list[index].resolvedAt || record.resolvedAt || null,
    outcomeReason: list[index].outcomeReason || record.outcomeReason || null
  };
  else list.push(record);
  return list.sort((a, b) => Number(a.targetStart || 0) - Number(b.targetStart || 0)).slice(-limit);
}

export function resolveShadowRows(rows = [], state = {}) {
  const candles = Array.isArray(state.candles) ? state.candles : [];
  const asset = clean(state.asset || '');
  const timeframe = clean(state.analysisTimeframe || state.timeframe || '').toUpperCase();
  if (!asset || !timeframe || !candles.length) return { rows: Array.isArray(rows) ? rows : [], resolved: [] };
  const resolved = [];
  const next = (Array.isArray(rows) ? rows : []).map(row => {
    if (row?.result || !sameAsset(row?.asset, asset) || clean(row?.timeframe).toUpperCase() !== timeframe) return row;
    if (!['BUY','SELL'].includes(row?.shadowDirection)) return row;
    const candle = candles.find(item => {
      const time = candleTime(item);
      return time != null && Math.round(time) === Math.round(Number(row.targetStart));
    });
    if (!candle) return row;
    const open = num(candle.open), close = num(candle.close);
    if (open == null || close == null) return row;
    const result = close === open ? 'DRAW'
      : row.shadowDirection === 'BUY' ? (close > open ? 'WIN' : 'LOSS') : (close < open ? 'WIN' : 'LOSS');
    const out = { ...row, open, close, result, resolvedAt: Date.now(), outcomeReason: result === 'LOSS' ? lossReason(row) : null };
    resolved.push(out);
    return out;
  });
  return { rows: next, resolved };
}

function grouped(list = [], keyFn) {
  const map = new Map();
  for (const row of list) {
    const key = clean(keyFn(row) || 'OUTRO') || 'OUTRO';
    const current = map.get(key) || { key, entries: 0, wins: 0, losses: 0 };
    current.entries += 1;
    if (row.result === 'WIN') current.wins += 1;
    if (row.result === 'LOSS') current.losses += 1;
    current.winRate = current.wins + current.losses ? Math.round((current.wins / (current.wins + current.losses)) * 1000) / 10 : null;
    map.set(key, current);
  }
  return [...map.values()].sort((a, b) => b.entries - a.entries || (b.winRate || 0) - (a.winRate || 0));
}

export function shadowMetrics(rows = []) {
  const list = Array.isArray(rows) ? rows : [];
  const entries = list.filter(row => row.decision === 'ENTER' && ['WIN','LOSS'].includes(row.result));
  const skips = list.filter(row => row.decision === 'SKIP' && ['WIN','LOSS'].includes(row.result));
  const entryWins = entries.filter(row => row.result === 'WIN').length;
  const entryLosses = entries.filter(row => row.result === 'LOSS').length;
  const missedWins = skips.filter(row => row.result === 'WIN').length;
  const avoidedLosses = skips.filter(row => row.result === 'LOSS').length;
  const resolved = list.filter(row => row.result).length;
  const sampleStatus = resolved >= 200 ? 'ROBUSTA' : resolved >= 50 ? 'ÚTIL' : resolved >= 20 ? 'INICIAL' : 'PEQUENA';
  const lossesByReason = grouped(entries.filter(row => row.result === 'LOSS'), row => row.outcomeReason).map(row => ({ reason: row.key, count: row.entries }));
  return {
    total: list.length,
    resolved,
    sampleStatus,
    entries: entries.length,
    entryWins, entryLosses,
    entryWinRate: entries.length ? Math.round((entryWins / entries.length) * 1000) / 10 : null,
    skips: skips.length,
    skippedWouldWin: missedWins,
    skippedWouldLose: avoidedLosses,
    skipMissRate: skips.length ? Math.round((missedWins / skips.length) * 1000) / 10 : null,
    byAsset: grouped(entries, row => row.asset).slice(0, 8),
    bySetup: grouped(entries, row => row.setup || 'SEM SETUP').slice(0, 8),
    lossesByReason: lossesByReason.slice(0, 6)
  };
}
