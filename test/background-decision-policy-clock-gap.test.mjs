import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.chrome = {
  storage: {
    onChanged: { addListener() {} }
  }
};

const { __test__ } = await import('../src/background-decision-policy.js');

const fresh = Date.now();
const baseState = {
  license: { status: 'active' },
  scanner: 'scanning',
  connection: 'online',
  asset: 'EUR/USD (OTC)',
  price: 1.1279,
  timeframe: 'M1',
  analysisTimeframe: 'M1',
  candles: [
    { time: fresh - 60_000, open: 1.1260, high: 1.1280, low: 1.1250, close: 1.1270 },
    { time: fresh, open: 1.1270, high: 1.1282, low: 1.1268, close: 1.1279 }
  ],
  analystPreferences: {
    operationMode: 'M1',
    confirmationMode: 'SIMPLES',
    sensitivityProfile: 'MEDIO'
  },
  diagnostics: {
    focusedAsset: {
      asset: 'EUR/USD (OTC)',
      reliable: true,
      chartScoped: true,
      trustedChartFrame: true,
      visualAuthority: true,
      embeddedTrader: true,
      at: fresh
    },
    marketSession: {
      asset: 'EUR/USD (OTC)',
      confirmedAsset: 'EUR/USD (OTC)',
      dataReady: true,
      transitioning: false,
      epoch: 1,
      startedAt: fresh
    },
    marketClock: null,
    expirationGuard: {
      required: '60s',
      actual: '60s',
      source: 'user-declared',
      verified: false,
      at: fresh
    }
  },
  platformControls: {
    userDeclaredExpiration: '60s'
  },
  signal: {
    state: 'WAIT',
    uiState: 'WAIT',
    direction: 'BUY',
    analysisScore: 78,
    score: 78,
    secondsRemaining: 15,
    analytics: {
      buyPower: 78,
      sellPower: 20,
      professional: {
        contextReady: true,
        triggerReady: true
      }
    },
    reason: 'setup técnico forte'
  }
};

test('mantém a análise técnica viva durante uma falha temporária do clock exato', () => {
  const decision = __test__.baseDecision(baseState);
  assert.equal(decision.uiState, 'POSSIBLE_BUY');
  assert.equal(decision.direction, 'BUY');
  assert.equal(decision.actionable, false);
  assert.equal(decision.score, 78);
  assert.match(decision.reason, /Relógio exato da vela ainda não foi confirmado|Relógio da CasaTrade/);
});

test('nunca libera entrada sem clock exato mesmo com expiração real válida', () => {
  const state = {
    ...baseState,
    platformControls: {
      realExpiration: '60s',
      realExpirationAt: fresh,
      realExpirationSource: 'background-direct-dom',
      observed: { expiration: '60s', observedAt: { expiration: fresh }, confidence: { expiration: 120 } }
    },
    diagnostics: {
      ...baseState.diagnostics,
      expirationGuard: {
        required: '60s',
        actual: '60s',
        source: 'background-direct-dom',
        verified: true,
        at: fresh
      }
    }
  };
  const decision = __test__.baseDecision(state);
  assert.equal(decision.uiState, 'POSSIBLE_BUY');
  assert.equal(decision.actionable, false);
  assert.equal(decision.timeReady, false);
});
