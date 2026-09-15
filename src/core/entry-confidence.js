import { assessAssetQuality } from './asset-quality.js';

const num = value => value == null || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null;
const clamp = value => Math.max(0, Math.min(100, Math.round(Number(value) || 0)));

export function assessEntryConfidence(state = {}) {
  const signal = state.signal || {};
  const analytics = signal.analytics || {};
  const quality = assessAssetQuality(state);
  const rawScore = num(signal.analysisScore ?? signal.score) ?? 0;
  const direction = ['BUY','SELL'].includes(signal.analysisDirection) ? signal.analysisDirection : null;
  const buy = direction === 'BUY';
  const directionalPower = num(buy ? analytics.buyPower : analytics.sellPower) ?? 0;
  const momentum = num(analytics.momentumScore) ?? 0;
  const strength = num(analytics.currentStrength) ?? 0;
  const continuation = num(analytics.continuationScore) ?? 0;
  const rejection = num(analytics.rejectionStrength) ?? 0;
  const qualityScore = num(quality.score) ?? 0;
  const uiState = String(signal.uiState || '');

  let score = rawScore * .46
    + Math.min(100, directionalPower) * .14
    + Math.min(100, momentum) * .10
    + Math.min(100, strength) * .10
    + Math.min(100, continuation) * .08
    + Math.min(100, rejection) * .04
    + Math.min(100, qualityScore) * .08;

  if (quality.status === 'POOR') score -= 14;
  if (quality.status === 'WATCH') score -= 5;
  if (uiState === 'POSSIBLE_BUY' || uiState === 'POSSIBLE_SELL') score += 4;
  if (uiState === 'DECIDING') score += 7;
  if (uiState === 'ENTER_BUY' || uiState === 'ENTER_SELL') score += 14;
  if (uiState === 'SKIP') score = Math.min(score, 42);
  score = clamp(score);

  const band = score >= 78 ? 'HIGH' : score >= 60 ? 'MEDIUM' : score >= 44 ? 'WATCH' : 'LOW';
  const label = band === 'HIGH' ? 'CONFIANÇA TÉCNICA ALTA'
    : band === 'MEDIUM' ? 'CONFIANÇA TÉCNICA BOA'
      : band === 'WATCH' ? 'CONFIRMAÇÃO PENDENTE'
        : 'SEM CONFIANÇA SUFICIENTE';

  return {
    score,
    band,
    label,
    direction,
    qualityScore: quality.score,
    qualityStatus: quality.status,
    calibratedProbability: null,
    note: 'Pontuação técnica interna; não representa probabilidade estatística até haver amostra real suficiente.'
  };
}
