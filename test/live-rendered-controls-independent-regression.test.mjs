import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');

test('rendered expiration is published even without a local market quote', () => {
  const source = read('src/content/canvas-probe.js');
  assert.match(source, /function publishRenderedControls/);
  assert.match(source, /publishRenderedControls\(rows, now\)/);
  const publishIndex = source.indexOf('publishRenderedControls(rows, now)');
  const quoteGateIndex = source.indexOf('if (!asset || price == null) return', publishIndex);
  assert.ok(publishIndex >= 0 && quoteGateIndex > publishIndex, 'controls must publish before asset/price gate');
  assert.match(source, /rendered-controls-independent/);
});

test('rendered control relay forwards both expiration and timeframe', () => {
  const source = read('src/content/embedded-feed-bridge.js');
  assert.match(source, /const networkExpiration = normalizeExp\(payload\.controls\?\.expiration\)/);
  assert.match(source, /const networkTimeframe = normalizeTf\(payload\.controls\?\.timeframe\)/);
  assert.match(source, /ATS_PLATFORM_CONTROLS_OBSERVED/);
  assert.match(source, /timeframe: networkTimeframe \|\| null/);
});

test('rendered probe v5 bypasses stale MAIN-world v4 guard after extension update', () => {
  const source = read('src/content/canvas-probe.js');
  assert.match(source, /__ATS_RENDERED_MARKET_PROBE_V5__/);
  assert.match(source, /ATS_CT_RENDER_OBSERVATION_V5/);
  assert.match(source, /__atsMarketTextHookedV5/);
  assert.doesNotMatch(source, /if \(window\.__ATS_RENDERED_MARKET_PROBE_V4__\) return/);
});
