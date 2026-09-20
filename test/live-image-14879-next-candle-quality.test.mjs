import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { assessEntryEvidence } from '../src/core/entry-evidence.js';
const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');

test('14879: legacy technical confirmation cannot bypass A+ next-candle quality',()=>{
  const o=read('src/core/orchestrator.js');
  const start=o.indexOf("if (signal.state === 'CONFIRM'");
  const block=o.slice(start,start+2400);
  assert.match(block,/decisionQuality/);
  assert.match(block,/aPlusAssessment/);
  assert.match(block,/aPlus\.finalAllowed/);
});

test('14879: stretched impulse remains an explicit anti-chase blocker',()=>{
  const result = assessEntryEvidence({
    regime: { type: 'uptrend' },
    analytics: {
      buyPower: 65,
      currentStrength: 72,
      continuationDirection: 'BUY',
      continuationScore: 70,
      momentumDirection: 'BUY',
      momentumScore: 68,
      exhaustionRisk: true,
      overextendedImpulse: true,
      rejectionDirection: null,
      rejectionStrength: 0
    }
  }, 'BUY');
  assert.equal(result.qualifies, false);
  assert.equal(result.blocker, 'exhaustion-risk');
});
