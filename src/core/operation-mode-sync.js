const clean = value => String(value ?? '').normalize('NFKC').trim().toLowerCase().replace(/\s+/g, '');

function normalizedExpiration(value = '') {
  const raw = clean(value);
  if (['60s','60sec','60secs','1m','1min','1minute','1minutes','1minuto','1minutos','60seg','60segundos'].includes(raw)) return '60s';
  if (['300s','300sec','300secs','5m','5min','5minute','5minutes','5minuto','5minutos','300seg','300segundos'].includes(raw)) return '300s';
  return null;
}

/**
 * The scanner's canonical operation contract is deliberately one-to-one:
 * 1 minute expiration => M1; 5 minute expiration => M5.
 * Short OTC expiration choices remain valid user inputs but do not silently
 * change the canonical M1/M5 mode.
 */
export function operationModeForExpiration(value = '') {
  const expiration = normalizedExpiration(value);
  if (expiration === '60s') return Object.freeze({ timeframe: 'M1', expiration: '60s', durationSeconds: 60 });
  if (expiration === '300s') return Object.freeze({ timeframe: 'M5', expiration: '300s', durationSeconds: 300 });
  return null;
}

export function trustedModeFromObservedControls(snapshot = {}, now = Date.now()) {
  if (String(snapshot.source || '') !== 'casatrade-expiration-probe-v3') return null;
  const observedAt = Number(typeof snapshot.observedAt === 'object' ? snapshot.observedAt?.expiration || 0 : snapshot.observedAt || 0);
  const age = now - observedAt;
  if (!(observedAt > 0 && age >= -1000 && age < 15000)) return null;
  if (Number(snapshot.confidence?.expiration || 0) < 110) return null;
  return operationModeForExpiration(snapshot.expiration || '');
}
