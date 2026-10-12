import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appendDecisionAudit,
  buildDecisionAudit,
  updateDecisionAuditDelivery
} from '../src/core/decision-audit.js';

const sample = (overrides = {}) => ({
  scanner: 'scanning',
  connection: 'online',
  asset: 'USD/XOF (OTC)',
  analysisTimeframe: 'M1',
  diagnostics: {
    marketClock: {
      source: 'trader-dom-countdown',
      secondsRemaining: 12,
      openAt: 1_900_000_000_000
    }
  },
  signal: {
    state: 'WATCH',
    uiState: 'POSSIBLE_BUY',
    direction: 'BUY',
    analysisScore: 80,
    analytics: {
      buyPower: 64,
      sellPower: 31,
      currentStrength: 62,
      continuationDirection: 'BUY',
      continuationScore: 58,
      momentumDirection: 'BUY',
      momentumScore: 48,
      pullbackContinuation: {
        observed: true,
        qualified: true,
        direction: 'BUY',
        score: 90,
        notStretched: true,
        roomToLevel: 0.8
      },
      professional: { contextReady: true, triggerReady: true }
    }
  },
  professionalDecision: {
    uiState: 'WAIT',
    actionable: false,
    direction: null,
    score: 80,
    cycleKey: 'USD/XOF (OTC)|M1|1900000000000',
    timeframe: 'M1',
    actualExpiration: '60s',
    secondsRemaining: 12,
    timeReady: true,
    expirationReady: true,
    marketIdentityReady: true,
    professionalContextReady: true,
    professionalTriggerReady: false,
    confluence: 2,
    signalPolicy: { finalPower: 59, minimumConfluence: 2 },
    finalCandidateHits: 1,
    reason: 'AGUARDAR — gatilho técnico ainda não confirmado.'
  },
  ...overrides
});

test('decision audit captures score/direction, pattern/trigger, blocker, deadline and delivery', () => {
  const state = sample();
  const row = buildDecisionAudit(state, state.professionalDecision, 1_900_000_000_000);
  assert.equal(row.scoreDirection.score, 80);
  assert.equal(row.scoreDirection.direction, '—', 'policy has not confirmed a direction yet');
  assert.equal(row.pattern.qualified, true);
  assert.equal(row.pattern.triggerReady, false);
  assert.match(row.blockerReason, /gatilho técnico/i);
  assert.equal(row.timing.timeframe, undefined, 'timeframe is represented in the timing object from the row root');
  assert.equal(row.timeframe, 'M1');
  assert.equal(row.timing.secondsRemaining, 12);
  assert.equal(row.delivery.status, 'pending');
  assert.equal(row.checks.length, 9);
});

test('audit records a true technical direction even while policy decision waits', () => {
  const state = sample();
  state.professionalDecision = {
    ...state.professionalDecision,
    uiState: 'POSSIBLE_BUY',
    direction: 'BUY',
    actionable: false,
    reason: 'COMPRA — pré-sinal; gatilho final pendente.'
  };
  const row = buildDecisionAudit(state, state.professionalDecision, 1_900_000_000_000);
  assert.equal(row.scoreDirection.direction, 'BUY');
  assert.equal(row.decision.uiState, 'POSSIBLE_BUY');
  assert.ok(row.blockerReason);
});

test('append audit keeps bounded history and deduplicates unchanged decision signatures', () => {
  let history = {};
  for (let i = 0; i < 55; i++) {
    const state = sample();
    state.professionalDecision = {
      ...state.professionalDecision,
      score: 40 + i,
      reason: 'score changed ' + i,
      secondsRemaining: 12
    };
    const row = buildDecisionAudit(state, state.professionalDecision, 1000 + i);
    history = appendDecisionAudit(history, row, 40);
  }
  assert.equal(history.events.length, 40);
  const before = history;
  const repeat = buildDecisionAudit({
    ...sample(),
    professionalDecision: {
      ...sample().professionalDecision,
      score: 94,
      reason: 'score changed 54',
      secondsRemaining: 12
    }
  }, {
    ...sample().professionalDecision,
    score: 94,
    reason: 'score changed 54',
    secondsRemaining: 12
  }, 9999);
  assert.equal(appendDecisionAudit(history, repeat, 40), before);
});

test('delivery status updates latest and matching event without rewriting other cycles', () => {
  const row = buildDecisionAudit(sample(), sample().professionalDecision, 1234);
  const history = appendDecisionAudit({}, row, 40);
  const updated = updateDecisionAuditDelivery(history, { id: row.id, cycleKey: row.cycleKey }, {
    status: 'failed', stage: 'pre', attempted: true, notification: 'failed', sound: 'failed', reason: 'Canais indisponíveis', at: 2000
  });
  assert.equal(updated.latest.delivery.status, 'failed');
  assert.equal(updated.latest.delivery.notification, 'failed');
  assert.equal(updated.events[0].delivery.reason, 'Canais indisponíveis');
  assert.equal(updated.latest.delivery.auditId, undefined, 'audit module merges only delivery data supplied by caller');
});
