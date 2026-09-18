import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');

test('live market-session keeps the previously working feed/clock path intact', () => {
  const source = read('src/background-market-session.js');
  const start = source.indexOf('async function applyFeed');
  const end = source.indexOf('\nasync function applyChartPrice', start);
  const applyFeed = source.slice(start, end);
  assert.match(applyFeed, /const clock = usableClock\(state, info\)/);
  assert.match(applyFeed, /if \(clock\) processed = processLiveSnapshot/);
  assert.match(applyFeed, /marketClock: state\.diagnostics\?\.marketClock \|\| null/);
  assert.doesNotMatch(applyFeed, /observedExpiration/);
  assert.doesNotMatch(applyFeed, /platformControls = observedExpiration/);
});

test('package version is bumped so Android extension hosts cannot reuse the previous cached build', () => {
  const manifest = JSON.parse(read('manifest.json'));
  assert.equal(manifest.version, '0.11.14');
  assert.equal(manifest.version_name, '0.11.14-live-pipeline-restore');
});
