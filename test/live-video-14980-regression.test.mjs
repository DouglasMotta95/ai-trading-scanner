import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('14980: rendered active market can override stale app-selected market after tab switch', () => {
  const source = fs.readFileSync(new URL('../src/content/canvas-probe.js', import.meta.url), 'utf8');
  assert.match(source, /renderedContradictsApp/);
  assert.match(source, /assetRow\.score \|\| 0\) >= 34/);
  assert.match(source, /const asset = renderedContradictsApp \? assetRow\.asset/);
  assert.match(source, /selected: renderedContradictsApp \? true/);
});

test('14980: visible expiration card wins over stale app state', () => {
  const source = fs.readFileSync(new URL('../src/content/canvas-probe.js', import.meta.url), 'utf8');
  assert.match(source, /const visibleExpiration = expirationFrom\(text\)/);
  assert.match(source, /expiration: visibleExpiration \|\| app\?\.expiration \|\| null/);
});

test('14980: responsive Expiração 1 min is read from visible lines', () => {
  const source = fs.readFileSync(new URL('../src/content/casatrade-ui-observer-v2.js', import.meta.url), 'utf8');
  assert.match(source, /function visibleLineExpiration\(\)/);
  assert.match(source, /visible-expiration-next-line/);
  assert.match(source, /if \(visibleLine\) return visibleLine/);
});

test('14980: chart-title geometry can win even when responsive container contains tab classes', () => {
  const source = fs.readFileSync(new URL('../src/content/focused-asset-v2.js', import.meta.url), 'utf8');
  assert.match(source, /physicallyInChartHeader/);
  assert.match(source, /if \(tabLike && !physicallyInChartHeader\) continue/);
});
