import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fastLiveDecision, resetFastLiveDecision } from '../src/core/live-fast-decision.js';

const background = fs.readFileSync(new URL('../src/background-fast-decision.js', import.meta.url), 'utf8');
const core = fs.readFileSync(new URL('../src/core/live-fast-decision.js', import.meta.url), 'utf8');

test('fast decision receives and prioritizes the current CasaTrade market clock', () => {
  assert.match(background, /secondsRemaining:\s*observed\.diagnostics\?\.marketClock\?\.secondsRemaining\s*\?\?\s*observed\.signal\?\.secondsRemaining/);
  assert.match(core, /Number\(context\.secondsRemaining \?\? signal\.secondsRemaining \?\? 0\)/);
  assert.match(background, /targetStart:\s*observed\.diagnostics\?\.marketClock\?\.closeAt\s*\?\?\s*observed\.signal\?\.targetStart/);
  assert.match(core, /num\(context\.targetStart\) \?\? num\(signal\.targetStart\) \?\? now \+ seconds \* 1000/);
  assert.doesNotMatch(core, /Number\(signal\.secondsRemaining \?\? context\.secondsRemaining \?\? 0\)/);
});

test('stale signal countdown cannot keep a strong setup outside the final 10 second window', () => {
  resetFastLiveDecision();
  const signal = {
    state: 'WATCH',
    uiState: 'POSSIBLE_SELL',
    analysisDirection: 'SELL',
    direction: 'SELL',
    score: 64,
    analysisScore: 64,
    secondsRemaining: 24,
    analytics: {
      sellPower: 58,
      buyPower: 42,
      momentumDirection: 'SELL',
      momentumScore: 48
    }
  };
  const context = {
    asset: 'AUD/CAD (OTC)',
    timeframe: 'M1',
    secondsRemaining: 8,
    serverTime: 100000
  };
  const first = fastLiveDecision(signal, context);
  const second = fastLiveDecision(signal, { ...context, serverTime: 101000 });
  assert.equal(first.uiState, 'WAIT');
  assert.equal(second.uiState, 'ENTER_SELL');
  assert.equal(second.state, 'CONFIRM');
});
