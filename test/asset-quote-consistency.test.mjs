import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');

const readers = [
  'src/content/focused-asset-v2.js',
  'src/content/focused-asset-alias-bridge.js',
  'src/content/focused-asset-protocol.js',
  'src/content/standalone-instrument-probe.js',
  'src/content/quetta-fallback-frame-bridge.js',
  'src/content/network-probe.js',
  'src/content/casatrade-data-inspector.js',
  'src/content/worker-probe.js',
  'src/content/canvas-probe.js',
  'src/content/opaque-frame-recovery.js',
  'src/background-market-session.js',
  'src/background-augment.js',
  'src/platforms/registry.js',
  'src/core/market-session-guard.js'
];

test('every active and fallback asset reader accepts XOF and XAF quotes', () => {
  const missing = [];
  for (const path of readers) {
    const source = read(path);
    if (!source.includes('XOF') || !source.includes('XAF')) missing.push(path);
  }
  assert.deepEqual(missing, [], 'stale quote allowlists would silently reject USD/XOF (OTC) and USD/XAF (OTC)');
});

test('core market validators normalize slash and compact XOF/XAF symbols consistently', async () => {
  const guard = await import('../src/core/market-session-guard.js');
  const registry = await import('../src/platforms/registry.js');
  for (const [raw, expected] of [
    ['USD/XOF (OTC)', 'USD/XOF (OTC)'],
    ['USDXOF OTC', 'USD/XOF (OTC)'],
    ['USD/XAF (OTC)', 'USD/XAF (OTC)'],
    ['USDXAF OTC', 'USD/XAF (OTC)']
  ]) {
    assert.equal(guard.canonicalMarket(raw), expected, 'market guard: ' + raw);
    assert.equal(registry.canonicalAsset(raw), expected, 'platform registry: ' + raw);
  }
});
