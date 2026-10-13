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
  assert.doesNotMatch(body, /clock\.verified !== true/);
  assert.match(body, /clockBoundToFocus\(clock, focus\)/);
  assert.match(readiness, /const policyReady = decisionFresh/);
  assert.match(readiness, /const operationalCandidate = manualAccepted && !conflict/);
  assert.match(readiness, /const operational = operationalCandidate \|\|/);
  assert.match(readiness, /const conflict = !manualAccepted && \(divergence/);
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
  assert.equal(manifest.version, '0.12.11');
  assert.equal(pkg.version, manifest.version);
  assert.equal(manifest.version_name, '0.12.11-expiration-countdown-profile-fix');
});


test('video 20942: manual M1 expiration and running countdown cannot deadlock the decision', () => {
  const readiness = read('src/core/expiration-readiness.js');
  const policy = read('src/background-decision-policy.js');
  const panel = read('src/sidepanel/app-v2.js');
  assert.match(readiness, /const conflict = !manualAccepted/);
  assert.match(policy, /EXPIRAÇÃO MANUAL ACEITA – usando 1 min/);
  assert.ok(panel.includes('if (manual === operation.expiration && (!currentTf || currentTf === operation.timeframe))'));
  assert.ok(policy.includes('observedCloseAt != null ? observedCloseAt - tfMs'));
  assert.ok(panel.includes('observedCloseAt != null ? observedCloseAt - tfMs'));
});

test('asset switch retains global expiration selection and the market-keyed candle cache', () => {
  const session = read('src/background-market-session.js');
  assert.match(session, /const sessionBase = state;/);
  assert.ok(session.includes('marketHistory: nextMarketHistory'));
  assert.ok(session.includes('Array.isArray(cachedTargetHistory) ? { [toAsset]: cachedTargetHistory } : {}'));
});

test('white-panel recovery has a storage-backed visible emergency view', () => {
  const recovery = read('src/sidepanel/boot-guard.js');
  assert.match(recovery, /atsPanelEmergencyFallback/);
  assert.match(recovery, /scannerState/);
});
