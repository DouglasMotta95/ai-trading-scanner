export const clean = value => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
export const num = value => value == null || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null;

export function normalizeAsset(value = '') {
  const raw = clean(value).toUpperCase();
  if (!raw) return '';
  const otc = /(?:\(|\b|[_-])OTC(?:\)|\b)?/i.test(raw);
  const pair = raw.match(/\b([A-Z0-9]{2,20})\s*[\/_-]\s*([A-Z0-9]{2,12})/i);
  return pair ? `${pair[1]}/${pair[2]}${otc ? ' (OTC)' : ''}` : '';
}
export const sameAsset = (a,b) => !!normalizeAsset(a) && normalizeAsset(a) === normalizeAsset(b);

export function normalizeTimeframe(value = '') {
  const raw = clean(value).toUpperCase().replace(/\s+/g,'');
  let m = raw.match(/^S(\d{1,5})$/) || raw.match(/^(\d{1,5})S$/); if (m && Number(m[1]) > 0) return `S${Number(m[1])}`;
  m = raw.match(/^M(\d{1,4})$/) || raw.match(/^(\d{1,4})(?:M|MIN)$/); if (m && Number(m[1]) > 0) return `M${Number(m[1])}`;
  m = raw.match(/^H(\d{1,3})$/) || raw.match(/^(\d{1,3})H$/); if (m && Number(m[1]) > 0) return `H${Number(m[1])}`;
  return null;
}
export function timeframeMs(value = 'M1') {
  const tf = normalizeTimeframe(value) || 'M1';
  if (tf[0] === 'S') return Number(tf.slice(1))*1000;
  if (tf[0] === 'M') return Number(tf.slice(1))*60000;
  if (tf[0] === 'H') return Number(tf.slice(1))*3600000;
  return 60000;
}
export const timeframeSeconds = value => Math.round(timeframeMs(value)/1000);

export function normalizeTimestamp(value) {
  let t = num(value);
  if (t == null || t <= 0) return null;
  if (t < 1e12) t *= 1000;
  return t > 946684800000 ? t : null;
}
export function normalizeExpiration(value = '') {
  const raw = clean(value).toLowerCase().replace(/\s+/g,'');
  let m = raw.match(/^(\d{1,5})(?:s|seg|segundo|segundos)$/); if (m) return `${Number(m[1])}s`;
  m = raw.match(/^(\d{1,4})(?:m|min|minuto|minutos)$/); if (m) return `${Number(m[1])*60}s`;
  m = raw.match(/^(\d{1,3}):(\d{2})$/); if (m) return `${Number(m[1])*60+Number(m[2])}s`;
  return null;
}
export function normalizeCandles(rows = [], limit = 240) {
  const byTime = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const time = normalizeTimestamp(row?.time ?? row?.timestamp);
    const open = num(row?.open), high = num(row?.high), low = num(row?.low), close = num(row?.close);
    if (time == null || ![open,high,low,close].every(Number.isFinite)) continue;
    byTime.set(time,{time,open,high,low,close,timeframe:normalizeTimeframe(row?.timeframe)});
  }
  return [...byTime.values()].sort((a,b)=>a.time-b.time).slice(-limit);
}
