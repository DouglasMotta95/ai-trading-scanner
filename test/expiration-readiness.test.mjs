import test from 'node:test';
import assert from 'node:assert/strict';
import { getExpirationReadiness } from '../src/core/expiration-readiness.js';

const now = 1791817090000;
const operationalState = () => ({
  analystPreferences: { operationMode: 'M1' },
  platformControls: {
    userDeclaredExpiration: '60s',
    userDeclaredAt: now - 25000,
    expirationSource: 'user-declared',
    observed: {
      expiration: '60s',
      source: 'user-declared',
      sourceByField: { expiration: 'user-declared' },
      observedAt: { expiration: now - 25000 }
    }
  },
  diagnostics: {
    expirationGuard: {
      required: '60s',
      actual: '60s',
      source: 'user-declared',
      verified: false,
      ready: false,
      divergence: false,
      at: now - 20000
    }
  },
  professionalDecision: {
    actualExpiration: '60s',
    expirationReady: true,
    updatedAt: now - 500
  }
});

test('matching manual expiration is reported as operational only when the central decision policy approved it', () => {
  const result = getExpirationReadiness(operationalState(), now);
  assert.equal(result.ready, true);
  assert.equal(result.verified, false);
  assert.equal(result.operational, true);
  assert.equal(result.actual, '60s');
});

test('an explicit matching manual expiration is accepted even when the live DOM probe disagrees', () => {
  const state = operationalState();
  state.platformControls.realExpiration = '5s';
  state.platformControls.realExpirationAt = now - 1500;
  state.platformControls.realExpirationSource = 'casatrade-expiration-probe-v3';
  state.professionalDecision.actualExpiration = '60s';
  state.professionalDecision.expirationReady = true;
  const result = getExpirationReadiness(state, now);
  assert.equal(result.ready, true);
  assert.equal(result.conflict, false);
  assert.equal(result.operational, true);
  assert.equal(result.actual, '60s');
});

test('an incompatible live expiration blocks when no matching manual value was declared', () => {
  const state = operationalState();
  delete state.platformControls.userDeclaredExpiration;
  delete state.platformControls.observed;
  state.platformControls.realExpiration = '5s';
  state.platformControls.realExpirationAt = now - 1500;
  state.platformControls.realExpirationSource = 'casatrade-expiration-probe-v3';
  state.diagnostics.expirationGuard.source = 'casatrade-expiration-probe-v3';
  state.diagnostics.expirationGuard.actual = '5s';
  const result = getExpirationReadiness(state, now);
  assert.equal(result.ready, false);
  assert.equal(result.conflict, true);
});

test('an unapproved or stale decision cannot authorize the operational fallback', () => {
  const state = operationalState();
  state.professionalDecision.expirationReady = false;
  assert.equal(getExpirationReadiness(state, now).ready, false);
  state.professionalDecision.expirationReady = true;
  state.professionalDecision.updatedAt = now - 6000;
  assert.equal(getExpirationReadiness(state, now).ready, false);
});

test('a fresh matching real expiration can pass only with the guard verification flag', () => {
  const state = operationalState();
  state.platformControls.realExpiration = '60s';
  state.platformControls.realExpirationAt = now - 1500;
  state.platformControls.realExpirationSource = 'casatrade-expiration-probe-v3';
  state.diagnostics.expirationGuard.verified = true;
  const result = getExpirationReadiness(state, now);
  assert.equal(result.ready, true);
  assert.equal(result.verified, true);
  assert.equal(result.operational, false);
});
