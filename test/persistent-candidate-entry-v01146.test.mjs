import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');

test('v0.11.46 arms a persistent candidate without changing the technical thresholds', () => {
  const src = read('src/core/orchestrator.js');
  assert.match(src, /CANDIDATE_PERSISTENCE_MIN_SCORE = 55/);
  assert.match(src, /CANDIDATE_PERSISTENCE_MIN_RATIO = 0\.70/);
  assert.match(src, /CANDIDATE_PERSISTENCE_MIN_SAMPLES = 4/);
  assert.match(src, /CANDIDATE_PERSISTENCE_MAX_GAP_MS = 3500/);
  assert.match(src, /strongOpposite/);
  assert.match(src, /phase: armed \? 'ARMED' : 'POSSIBLE'/);
});

test('v0.11.46 can confirm the next candle from sustained candidate persistence', () => {
  const src = read('src/core/orchestrator.js');
  assert.match(src, /confirmationMode = 'PERSISTENCE'/);
  assert.match(src, /candidate dominante em/);
  assert.match(src, /persistenceDirection && canShowPossible/);
  assert.match(src, /enterSignal\(signal, cycle, persistenceDirection, score, cycle\.reason, 'PERSISTENCE', persistence\)/);
});

test('professional decision policy accepts persistence evidence but keeps time and expiration gates', () => {
  const src = read('src/background-decision-policy.js');
  assert.match(src, /persistenceCandidate/);
  assert.match(src, /Number\(persistenceEvidence\.sampleCount \|\| 0\) >= 4/);
  assert.match(src, /Number\(persistenceEvidence\.ratio \|\| 0\) >= 0\.70/);
  assert.match(src, /Number\(persistenceEvidence\.averageScore \|\| 0\) >= 55/);
  assert.match(src, /persistenceEvidence\.strongOpposite !== true/);
  assert.match(src, /const finalQuality = strongFinalQuality \|\| persistenceFinalQuality/);
  assert.match(src, /if \(!expiration\.ready\)/);
});

test('build is v0.11.46', () => {
  const manifest = JSON.parse(read('manifest.json'));
  const pkg = JSON.parse(read('package.json'));
  assert.equal(manifest.version, '0.11.46');
  assert.equal(manifest.version_name, '0.11.46-persistent-candidate-entry');
  assert.equal(pkg.version, '0.11.46');
});
