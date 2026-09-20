const clean = value => String(value ?? '').trim();

export function assessEntryEvidence(signal = {}, direction = null) {
  const dir = ['BUY', 'SELL'].includes(direction) ? direction : null;
  if (!dir) return { qualifies: false, setup: null, factors: [], blocker: 'no-direction' };

  const analytics = signal.analytics || {};
  const regime = clean(signal.regime?.type).toLowerCase();
  const power = Number(dir === 'BUY' ? analytics.buyPower : analytics.sellPower) || 0;
  const currentStrength = Number(analytics.currentStrength || 0);
  const rejectionStrength = Number(analytics.rejectionStrength || 0);
  const rejection = clean(analytics.rejectionDirection).toUpperCase() === dir && rejectionStrength >= 40;
  const continuation = clean(analytics.continuationDirection).toUpperCase() === dir
    && Number(analytics.continuationScore || 0) >= 50;
  const momentum = clean(analytics.momentumDirection).toUpperCase() === dir
    && Number(analytics.momentumScore || 0) >= 40;
  const breakout = analytics.strongBreakout === true
    && clean(analytics.breakoutDirection).toUpperCase() === dir
    && Number(analytics.breakoutDistanceRatio || 0) >= .18;
  const strongCandle = currentStrength >= 50;

  const trendAligned = regime === 'uptrend'
    ? dir === 'BUY'
    : regime === 'downtrend'
      ? dir === 'SELL'
      : false;
  const counterTrend = regime === 'uptrend'
    ? dir === 'SELL'
    : regime === 'downtrend'
      ? dir === 'BUY'
      : false;

  const exhaustionRisk = analytics.exhaustionRisk === true || analytics.overextendedImpulse === true;
  if (counterTrend) {
    return { qualifies: false, setup: null, factors: [], blocker: 'counter-trend' };
  }
  if (exhaustionRisk && !rejection) {
    return { qualifies: false, setup: null, factors: [], blocker: 'exhaustion-risk' };
  }
  // Range is intentionally stricter: continuation/momentum in the middle of a
  // range is noise. A range entry needs either a real rejection or a confirmed
  // breakout; the A+ layer separately verifies that the location is at the edge.
  if (regime === 'range' && !rejection && !breakout) {
    return { qualifies: false, setup: null, factors: [], blocker: 'range-needs-rejection-or-breakout' };
  }

  const factors = [];
  if (power >= 48) factors.push('poder direcional');
  if (rejection) factors.push('rejeição');
  if (continuation) factors.push('continuação');
  if (momentum) factors.push('momentum');
  if (breakout) factors.push('rompimento');
  if (strongCandle) factors.push('força da vela');
  if (trendAligned) factors.push('tendência alinhada');
  if (regime === 'range') factors.push('range');

  const directionalTrigger = rejection || continuation || momentum || breakout;
  const supportingEvidence = power >= 48 || strongCandle || trendAligned || regime === 'range';
  const qualifies = directionalTrigger && supportingEvidence && factors.length >= 2;

  let setup = null;
  if (rejection) setup = regime === 'range' ? 'rejeição no range' : 'rejeição';
  else if (breakout) setup = regime === 'range' ? 'rompimento confirmado no range' : 'rompimento';
  else if (continuation) setup = 'continuação';
  else if (momentum && strongCandle) setup = 'momentum';
  else if (power >= 48 && strongCandle) setup = 'força direcional';

  return {
    qualifies,
    setup: qualifies ? setup : null,
    factors,
    blocker: qualifies ? null : 'insufficient-evidence'
  };
}
