import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');

test('manual execution does not expire a valid observed expiration after an arbitrary 7-second timer', () => {
  const source = read('src/background-control.js');
  const start = source.indexOf('function exactTradeReady(');
  const end = source.indexOf('\nasync function manualIntent(', start);
  assert.ok(start >= 0 && end > start, 'exactTradeReady source block exists');
  const body = source.slice(start, end);
  assert.match(body, /const controlsFresh = expirationAt > 0;/);
  assert.doesNotMatch(body, /Date\.now\(\)\s*-\s*expirationAt\s*<\s*7000/);
  assert.match(body, /if \(!actualExpiration \|\| !controlsFresh\) return false;/);
  assert.match(body, /clock\.verified !== true/);
  assert.match(body, /clockBoundToFocus\(clock, focus\)/);
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
  assert.equal(manifest.version, '0.11.93');
  assert.equal(pkg.version, manifest.version);
  assert.equal(manifest.version_name, '0.11.93-video-20730-mode-evidence');
});
