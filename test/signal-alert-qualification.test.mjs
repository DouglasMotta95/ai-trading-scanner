import test from 'node:test';
import assert from 'node:assert/strict';
import { qualifiedDecision } from '../src/core/signal-alert-qualification.js';

const makeState = (overrides = {}) => ({
  scanner: 'scanning',
  connection: 'online',
  asset: 'USD/XOF (OTC)',
  professionalDecision: {
    timeReady: true,
    expirationReady: true,
    timeframe: 'M1',
    actualExpiration: '60s',
    secondsRemaining: 22,
    cycleKey: 'USD/XOF (OTC)|M1|2000',
    uiState: 'POSSIBLE_BUY',
    direction: 'BUY'
  },
  ...overrides
});

test('emits a pre-signal notification for valid M1 + 60s', () => {
  const event = qualifiedDecision(makeState());
  assert.equal(event?.stage, 'pre');
  assert.equal(event?.label, 'COMPRA');
  assert.match(event?.message || '', /USD\/XOF \(OTC\).*M1/);
});

test('emits a pre-signal notification for valid M5 + 300s', () => {
  const state = makeState({ professionalDecision: {
    ...makeState().professionalDecision,
    timeframe: 'M5',
    actualExpiration: '300s',
    cycleKey: 'USD/XOF (OTC)|M5|2000',
    uiState: 'POSSIBLE_SELL',
    direction: 'SELL'
  }});
  const event = qualifiedDecision(state);
  assert.equal(event?.stage, 'pre');
  assert.equal(event?.label, 'VENDA');
  assert.match(event?.message || '', /USD\/XOF \(OTC\).*M5/);
});

test('emits a final notification only for direction-matched ENTER in M1 and M5', () => {
  for (const [timeframe, actualExpiration, uiState, direction] of [
    ['M1','60s','ENTER_BUY','BUY'],
    ['M5','300s','ENTER_SELL','SELL']
  ]) {
    const state=makeState({professionalDecision:{
      ...makeState().professionalDecision,timeframe,actualExpiration,secondsRemaining:7,uiState,direction,
      cycleKey: 'final|' + timeframe
    }});
    assert.equal(qualifiedDecision(state)?.stage,'final');
  }
});

test('never sends a final notification for AGUARDAR or contradictory direction', () => {
  const base=makeState();
  const wait=makeState({professionalDecision:{...base.professionalDecision,secondsRemaining:5,uiState:'WAIT'}});
  const mismatch=makeState({professionalDecision:{...base.professionalDecision,secondsRemaining:5,uiState:'ENTER_SELL',direction:'BUY'}});
  assert.equal(qualifiedDecision(wait),null);
  assert.equal(qualifiedDecision(mismatch),null);
});

test('keeps alerts blocked unless connection, clock, expiration and mode match', () => {
  const base=makeState();
  assert.equal(qualifiedDecision(makeState({connection:'offline'})),null);
  assert.equal(qualifiedDecision(makeState({professionalDecision:{...base.professionalDecision,timeReady:false}})),null);
  assert.equal(qualifiedDecision(makeState({professionalDecision:{...base.professionalDecision,expirationReady:false}})),null);
  assert.equal(qualifiedDecision(makeState({professionalDecision:{...base.professionalDecision,timeframe:'M5',actualExpiration:'60s'}})),null);
  assert.equal(qualifiedDecision(makeState({professionalDecision:{...base.professionalDecision,secondsRemaining:40}})),null);
});
