import { getOperationMode } from './analysis.js';

const clean = value => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();

function normExp(value = '') {
  const raw = clean(value).toLowerCase().replace(/\s+/g, '');
  if (!raw || raw === 'auto') return null;
  let match = raw.match(/^(\d{1,5})(?:s|seg|segundo|segundos)$/);
  if (match) return `${Number(match[1])}s`;
  match = raw.match(/^(\d{1,4})(?:m|min|minuto|minutos)$/);
  if (match) return `${Number(match[1]) * 60}s`;
  match = raw.match(/^(\d{1,3}):(\d{2})$/);
  if (match) return `${Number(match[1]) * 60 + Number(match[2])}s`;
  return null;
}

const MANUAL_SOURCES = new Set(['user-declared', 'user-declared-match', 'operational']);
const isManualSource = value => MANUAL_SOURCES.has(clean(value).toLowerCase());

/**
 * Read the central decision policy's expiration result consistently across the
 * analysis card and manual-entry handoff. A manual value is operational fallback
 * only when the policy approved it, it matches M1/M5, and no fresh conflicting
 * live expiration or active divergence is present.
 */
export function getExpirationReadiness(state = {}, now = Date.now()) {
  const operationMode = getOperationMode(state.analystPreferences?.operationMode || 'M1');
  const required = operationMode.expiration;
  const controls = state.platformControls || {};
  const observed = controls.observed || {};
  const guard = state.diagnostics?.expirationGuard || {};
  const decision = state.professionalDecision || {};

  const observedFieldSource = clean(
    observed.sourceByField?.expiration
      || controls.realExpirationSource
      || controls.expirationSource
      || observed.source
      || ''
  );
  const observedAt = Number(observed.observedAt?.expiration || 0);
  const observedValue = normExp(observed.expiration || '');
  const realValue = normExp(controls.realExpiration || '');
  const realAt = Number(controls.realExpirationAt || 0);
  const realSource = clean(controls.realExpirationSource || '');
  const declaredAt = Number(controls.userDeclaredAt || 0);

  const realCandidates = [];
  if (realValue && realAt > 0 && !isManualSource(realSource)) {
    realCandidates.push({ value: realValue, at: realAt, source: realSource || 'real-expiration-field' });
  }
  if (observedValue && observedAt > 0 && !isManualSource(observedFieldSource)) {
    realCandidates.push({ value: observedValue, at: observedAt, source: observedFieldSource || 'observed-platform-control' });
  }
  realCandidates.sort((a, b) => b.at - a.at);
  const candidate = realCandidates[0] || null;
  const candidateAge = candidate ? now - candidate.at : Infinity;
  const realFresh = !!candidate
    && candidateAge >= 0
    && candidateAge < 15000
    && (!declaredAt || candidate.at >= declaredAt);

  const guardAt = Number(guard.at || 0);
  const guardAge = guardAt > 0 ? now - guardAt : Infinity;
  const guardFresh = guardAge >= 0 && guardAge < 10000;
  const divergence = guardFresh && guard.divergence === true;

  const guardSource = clean(guard.source || '');
  const observedManual = isManualSource(observedFieldSource) ? observedValue : null;
  const guardManual = guardFresh && isManualSource(guardSource) ? normExp(guard.actual || '') : null;
  const declared = normExp(controls.userDeclaredExpiration || observedManual || guardManual || '');

  const decisionAt = Number(decision.updatedAt || 0);
  const decisionAge = decisionAt > 0 ? now - decisionAt : Infinity;
  const decisionFresh = decisionAge >= 0 && decisionAge < 4000;
  const policyReady = decisionFresh
    && decision.expirationReady === true
    && normExp(decision.actualExpiration || '') === required;

  const conflict = divergence || (realFresh && candidate.value !== required);
  const verified = policyReady
    && !conflict
    && realFresh
    && candidate.value === required
    && guard.verified === true;
  const operationalCandidate = !realFresh
    && !conflict
    && !!declared
    && declared === required;
  const operational = policyReady && operationalCandidate;
  const ready = verified || operational;
  const actual = realFresh ? candidate.value : declared || normExp(decision.actualExpiration || '');

  let reason;
  if (divergence) {
    reason = clean(guard.reason || 'A expiração observada diverge do modo ativo.');
  } else if (realFresh && candidate.value !== required) {
    reason = `Expiração ao vivo de ${candidate.value} diverge do modo ativo (${required}).`;
  } else if (verified) {
    reason = `Expiração ${required} confirmada pela CasaTrade.`;
  } else if (operational) {
    reason = `Expiração ${required} informada e compatível; fallback operacional aprovado. A leitura direta continua não verificada.`;
  } else if (operationalCandidate) {
    reason = `Expiração ${required} informada e compatível; aguardando sincronização da decisão operacional.`;
  } else if (declared && declared !== required) {
    reason = `Expiração informada (${declared}) não coincide com o modo ativo (${required}).`;
  } else if (realFresh && candidate.value === required) {
    reason = 'A leitura direta da expiração ainda não foi aceita pelo guard operacional.';
  } else {
    reason = `Expiração real de ${required} não confirmada e nenhum fallback operacional válido.`;
  }

  return {
    ready,
    verified,
    operational,
    operationalCandidate,
    conflict,
    required,
    actual: actual || null,
    source: verified ? candidate.source : operational ? 'user-declared-match' : isManualSource(observedFieldSource) ? 'user-declared' : '',
    reason,
    realFresh,
    decisionFresh
  };
}
