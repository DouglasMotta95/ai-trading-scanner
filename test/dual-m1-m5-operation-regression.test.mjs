import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');

test('dual mode UI exposes M1 and M5 with matching expiration plans', () => {
  const html = read('src/sidepanel/index.html');
  assert.match(html, /id="operatingTimeframe"/);
  assert.match(html, /M1 • expiração 1 min/);
  assert.match(html, /M5 • expiração 5 min/);
  assert.match(html, /id="heroExpirationPlan"/);
});

test('M5 is the default operating mode for this build', () => {
  const app = read('src/sidepanel/app-v2.js');
  assert.match(app, /operatingTimeframe: 'M5'/);
  assert.match(app, /requiredExpirationForTimeframe/);
  assert.match(app, /return normalizeOperatingTimeframe\(value\) === 'M1' \? '60s' : '300s'/);
});

test('preference message persists operation plan and clears stale signal on timeframe change', () => {
  const control = read('src/background-control.js');
  assert.match(control, /async function setAnalystPreferences/);
  assert.match(control, /operatingTimeframe/);
  assert.match(control, /preferredExpiration/);
  assert.match(control, /entryAdvice: null/);
  assert.match(control, /ATS_SET_ANALYST_PREFERENCES/);
});

test('central analyzer refuses to analyze a chart timeframe different from selected mode', () => {
  const background = read('src/background.js');
  assert.match(background, /const desiredTimeframe = operatingTimeframe\(state\)/);
  assert.match(background, /if \(!timeframe \|\| timeframe !== desiredTimeframe\) return null/);
});

test('M1 and M5 use different final entry windows', () => {
  const orchestrator = read('src/core/orchestrator.js');
  const legacy = read('src/core/orchestrator-legacy.js');
  assert.match(orchestrator, /timeframe === 'M1'.*decision: 10/);
  assert.match(orchestrator, /timeframe === 'M5'.*decision: 20/);
  assert.match(legacy, /analysisTimeframe\).*=== 'M5' \? 20 : 10/);
  assert.match(legacy, /analysisTimeframe\).*=== 'M5' \? 90 : 30/);
});

test('M5 clock boundary aggregates the whole 5-minute bucket instead of last raw candle', () => {
  const clock = read('src/content/market-cycle-clock-v4.js');
  assert.match(clock, /const currentBucket = Math\.floor\(now \/ durationMs\) \* durationMs/);
  assert.match(clock, /const bucketRows = normalized\.filter/);
  assert.match(clock, /aggregatedSamples: bucketRows\.length/);
});

test('A+ profile maps M5 operation to M15 context and 5-minute expiration', () => {
  const engine = read('src/core/high-confidence.js');
  assert.match(engine, /M5: Object\.freeze\(\{/);
  assert.match(engine, /contextTimeframe: 'M15'/);
  assert.match(engine, /requiredExpiration: '300s'/);
  assert.match(engine, /enterScore: 80/);
});

test('manual trade intent carries the selected timeframe expiration', () => {
  const control = read('src/background-control.js');
  const start = control.indexOf('async function manualIntent');
  const end = control.indexOf('\nfunction normalizeOperatingTimeframe', start);
  const block = end > start ? control.slice(start,end) : control.slice(start,start+4000);
  assert.match(block, /expirationForOperatingTimeframe\(operatingTimeframe\)/);
});

test('journal resolves the whole target duration rather than a single one-minute row', () => {
  const background = read('src/background.js');
  assert.match(background, /targetRows = candles/);
  assert.match(background, /item\.time >= targetBucket && item\.time < targetBucket \+ tfMs/);
  assert.match(background, /const first = targetRows\[0\]\.candle/);
  assert.match(background, /const last = targetRows\.at\(-1\)\.candle/);
});
