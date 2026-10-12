const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const numberOrNull = value => value == null || value === '' || !Number.isFinite(Number(value)) ? null : Number(value);
const upper = value => clean(value).toUpperCase();

function hash(value = '') {
  let result = 2166136261;
  for (let index = 0; index < value.length; index++) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 16777619);
  }
  return (result >>> 0).toString(36);
}

function shortBlocker(decision = {}, state = {}) {
  if (decision.actionable === true || ['ENTER_BUY','ENTER_SELL'].includes(upper(decision.uiState))) return null;
  if (decision.marketIdentityReady === false) return clean(decision.marketIdentityReason || 'Identidade do ativo não confirmada.');
  if (decision.timeReady !== true) return clean(decision.reason || 'Relógio exato da CasaTrade não confirmado.');
  if (decision.expirationReady !== true) return clean(decision.reason || 'Modo/timeframe/expiração não alinhados.');
  if (decision.professionalContextReady === false) return 'Contexto/tendência/região ainda não confirmados.';
  if (decision.professionalTriggerReady === false) return 'Gatilho técnico ainda não confirmado.';
  if (Number(decision.holdRemainingMs || 0) > 0) return 'Confirmação em estabilização; aguardar o hold restante.';
  if (Number(decision.finalCandidateHits || 0) < 2 && ['WAIT','AGUARDAR'].includes(upper(decision.uiState))) return clean(decision.reason || 'Confirmações finais insuficientes.');
  return clean(decision.reason || 'Decisão final ainda não liberada.');
}

export function buildDecisionAudit(state = {}, decision = {}, now = Date.now()) {
  const signal = state.signal || {};
  const analytics = signal.analytics || {};
  const professional = analytics.professional || {};
  const pattern = decision.pullbackContinuation || analytics.pullbackContinuation || {};
  const direction = upper(decision.direction || signal.direction || signal.analysisDirection) || null;
  const score = Number(numberOrNull(decision.score ?? signal.analysisScore ?? signal.score) || 0);
  const timeframe = upper(decision.timeframe || state.analysisTimeframe || state.timeframe || state.analystPreferences?.operationMode || '—');
  const secondsRemaining = numberOrNull(decision.secondsRemaining ?? state.diagnostics?.marketClock?.secondsRemaining);
  const clock = state.diagnostics?.marketClock || {};
  const cycleKey = clean(decision.cycleKey || state.decisionCycle?.key || '');
  const targetStart = numberOrNull(state.decisionCycle?.targetStart ?? signal.targetStart ?? clock.openAt ?? clock.candleOpenAt);
  const expiration = clean(decision.actualExpiration || state.platformControls?.realExpiration || state.platformControls?.userDeclaredExpiration || '—');
  const power = numberOrNull(direction === 'BUY' ? analytics.buyPower : direction === 'SELL' ? analytics.sellPower : null);
  const finalHits = Number(decision.finalCandidateHits || 0);
  const actionable = decision.actionable === true || ['ENTER_BUY','ENTER_SELL'].includes(upper(decision.uiState));
  const uiState = upper(decision.uiState || 'WAIT');
  const blocker = shortBlocker(decision, state);
  const checks = [
    { key: 'identidade', ok: decision.marketIdentityReady === true, detail: clean(decision.marketIdentityReason || (decision.marketIdentityReady ? 'Ativo e gráfico confirmados.' : 'Ativo/gráfico ainda não confirmado.')) },
    { key: 'relógio', ok: decision.timeReady === true, detail: clean(decision.timeReady ? 'Relógio exato confirmado.' : decision.reason || 'Relógio exato pendente.') },
    { key: 'expiração', ok: decision.expirationReady === true, detail: clean(decision.expirationReady ? `Expiração ${expiration} compatível.` : 'Timeframe/expiração ainda não alinhados.') },
    { key: 'contexto', ok: decision.professionalContextReady === true, detail: clean(decision.professionalContextReady ? 'Contexto aprovado.' : 'Contexto/tendência/região pendentes.') },
    { key: 'gatilho', ok: decision.professionalTriggerReady === true, detail: clean(decision.professionalTriggerReady ? 'Gatilho técnico aprovado.' : 'Gatilho técnico pendente.') },
    { key: 'poder direcional', ok: power != null && power >= Number(decision.signalPolicy?.finalPower ?? 0), detail: power == null ? 'Direção/poder não disponível.' : `${Math.round(power)} de poder direcional.` },
    { key: 'confluência', ok: Number(decision.confluence || 0) >= Number(decision.signalPolicy?.minimumConfluence || 0), detail: `${Number(decision.confluence || 0)} fatores; mínimo ${Number(decision.signalPolicy?.minimumConfluence || 0)}.` },
    { key: 'estabilidade', ok: finalHits >= 2 || actionable, detail: `${finalHits} confirmações finais acumuladas.` },
    { key: 'prazo', ok: secondsRemaining != null && secondsRemaining > 0, detail: secondsRemaining == null ? 'Countdown indisponível.' : `${secondsRemaining}s restantes.` }
  ];
  const deliveryEligible = ['POSSIBLE_BUY','POSSIBLE_SELL','ENTER_BUY','ENTER_SELL'].includes(uiState)
    && !!direction && decision.timeReady === true && decision.expirationReady === true
    && numberOrNull(secondsRemaining) != null && Number(secondsRemaining) > 0;
  const bucket = secondsRemaining == null ? 'na' : Math.floor(Number(secondsRemaining) / 5);
  const signature = JSON.stringify({
    cycleKey, uiState, direction, score: Math.round(score), blocker,
    timeframe, expiration, timeReady: !!decision.timeReady,
    expirationReady: !!decision.expirationReady, context: !!decision.professionalContextReady,
    trigger: !!decision.professionalTriggerReady, hits: finalHits, actionable,
    bucket, pattern: pattern.qualified === true ? direction : null,
    patternScore: Number(pattern.score || 0),
    scanner: clean(state.scanner), connection: clean(state.connection)
  });
  const id = `${cycleKey || 'no-cycle'}|${hash(signature)}`;
  return {
    id, signature, at: now, cycleKey, asset: clean(state.asset || signal.asset || '—'),
    timeframe, expiration,
    scoreDirection: {
      score, direction: direction || '—', power, confluence: Number(decision.confluence || 0),
      buyPower: numberOrNull(analytics.buyPower), sellPower: numberOrNull(analytics.sellPower)
    },
    pattern: {
      name: clean(pattern.qualified ? 'Pullback + retomada' : signal.setup || decision.setup || 'Padrão em avaliação'),
      observed: pattern.observed === true, qualified: pattern.qualified === true,
      direction: upper(pattern.direction || '') || null, score: numberOrNull(pattern.score),
      notStretched: pattern.notStretched === true, roomToLevel: numberOrNull(pattern.roomToLevel),
      currentStrength: numberOrNull(analytics.currentStrength),
      rejectionDirection: upper(analytics.rejectionDirection || '') || null,
      rejectionStrength: numberOrNull(analytics.rejectionStrength),
      continuationDirection: upper(analytics.continuationDirection || '') || null,
      continuationScore: numberOrNull(analytics.continuationScore),
      momentumDirection: upper(analytics.momentumDirection || '') || null,
      momentumScore: numberOrNull(analytics.momentumScore),
      contextReady: decision.professionalContextReady === true || professional.contextReady === true,
      triggerReady: decision.professionalTriggerReady === true || professional.triggerReady === true
    },
    checks, blocker,
    decision: { uiState, actionable, technicalUiState: upper(signal.uiState || signal.state || '—'), finalCandidateHits: finalHits, holdRemainingMs: Number(decision.holdRemainingMs || 0) },
    timing: {
      secondsRemaining, targetStart,
      targetAt: secondsRemaining == null ? null : now + Math.max(0, Number(secondsRemaining)) * 1000,
      entryWindowSeconds: timeframe === 'M5' ? 20 : timeframe === 'M1' ? 15 : null,
      clockSource: clean(decision.timeSource || clock.source || '—'),
      timeReady: decision.timeReady === true,
      expirationReady: decision.expirationReady === true
    },
    blockerReason: blocker,
    delivery: {
      status: deliveryEligible ? 'pending' : 'not_eligible',
      reason: deliveryEligible ? 'Aguardando resultado do módulo de notificação.' : blocker || 'A decisão atual não gera alerta de entrada.',
      attempted: false, notification: 'not_attempted', sound: 'not_attempted', at: null
    }
  };
}

export function appendDecisionAudit(previous = {}, row = {}, maxEvents = 40) {
  if (!row?.id || !row?.signature) return previous || { latest: null, events: [] };
  const latest = previous?.latest || null;
  const same = latest?.signature === row.signature;
  if (same) return previous;
  const events = Array.isArray(previous?.events) ? previous.events : [];
  return {
    latest: row,
    events: [...events, row].slice(-Math.max(5, Number(maxEvents) || 40)),
    updatedAt: row.at
  };
}

export function updateDecisionAuditDelivery(previous = {}, match = {}, delivery = {}) {
  const audit = previous && typeof previous === 'object' ? previous : {};
  const matches = row => !!row && (!match.cycleKey || row.cycleKey === match.cycleKey)
    && (!match.uiState || row.decision?.uiState === match.uiState)
    && (!match.id || row.id === match.id);
  const merge = row => ({ ...row, delivery: { ...(row.delivery || {}), ...delivery, at: Number(delivery.at || Date.now()) } });
  const events = Array.isArray(audit.events) ? audit.events.map(row => matches(row) ? merge(row) : row) : [];
  const latest = matches(audit.latest) ? merge(audit.latest) : audit.latest || null;
  return { ...audit, latest, events, updatedAt: Date.now() };
}
