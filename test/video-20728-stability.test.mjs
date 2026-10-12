import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');

test('manual execution does not expire a valid observed expiration after an arbitrary 7-second timer', () => {
  const source = read('src/background-control.js');
  const readiness = read('src/core/expiration-readiness.js');
  const start = source.indexOf('function exactTradeReady(');
  const end = source.indexOf('\nasync function manualIntent(', start);
  assert.ok(start >= 0 && end > start, 'exactTradeReady source block exists');
  const body = source.slice(start, end);
  assert.match(body, /getExpirationReadiness\(state\)/);
  assert.match(body, /if \(!expiration\.ready \|\| expiration\.actual !== operationMode\.expiration\) return false;/);
  assert.doesNotMatch(body, /Date\.now\(\)\s*-\s*expirationAt\s*<\s*7000/);
  assert.match(body, /clock\.verified !== true/);
  assert.match(body, /clockBoundToFocus\(clock, focus\)/);
  assert.match(readiness, /const policyReady = decisionFresh/);
  assert.match(readiness, /const operational = policyReady && operationalCandidate/);
  assert.match(readiness, /const conflict = divergence \|\| \(realFresh && candidate\.value !== required\)/);
});

test('pre-signal stability remains display-only and bounded', () => {
  const source = read('src/core/live-fast-decision.js');
  assert.match(source, /CANDIDATE_JITTER_GRACE_MS = 3500/);
  assert.match(source, /function recentCandidate\(/);
  assert.match(source, /PRÉ-SINAL MANTIDO POR ESTABILIDADE/);
  assert.match(source, /candidateTrackers\.clear\(\)/);
  assert.match(source, /FAST_DECISION\.confirmHits/);
});

test('manifest and package versions identify the stability patch consistently', () => {
  const manifest = JSON.parse(read('manifest.json'));
  const pkg = JSON.parse(read('package.json'));
  assert.equal(manifest.version, '0.12.10');
  assert.equal(pkg.version, manifest.version);
  assert.equal(manifest.version_name, '0.12.10-operation-lock-candle-results');
});
