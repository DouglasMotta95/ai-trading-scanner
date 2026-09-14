import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { detectPlatform, getPlatform, platformRegistry } from '../src/platforms/registry.js';

test('platform registry dispatches through a platform list while keeping CasaTrade as the first adapter', () => {
  const rows = platformRegistry();
  assert.ok(Array.isArray(rows));
  assert.equal(rows[0]?.id, 'casatrade');
  assert.equal(getPlatform('casatrade')?.id, 'casatrade');
  assert.equal(detectPlatform('trade.casatrade.com')?.id, 'casatrade');
  assert.equal(detectPlatform('future.example.com'), null);

  const source = fs.readFileSync(new URL('../src/platforms/registry.js', import.meta.url), 'utf8');
  assert.match(source, /const PLATFORMS = Object\.freeze\(\[CASA_TRADE\]\)/);
  assert.match(source, /PLATFORMS\.find\(platform => platformMatchesHost/);
  assert.match(source, /PLATFORMS\.find\(platform => String\(platform\?\.id/);
});

test('core signal keys no longer assume CasaTrade when platformId is absent', () => {
  const source = fs.readFileSync(new URL('../src/core/orchestrator.js', import.meta.url), 'utf8');
  assert.match(source, /snapshot\.platformId \|\| 'unknown'/);
  assert.doesNotMatch(source, /snapshot\.platformId \|\| 'casatrade'/);
});
