import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcRoot = path.join(root, 'src');
const centralWriter = path.normalize(path.join(srcRoot, 'services', 'scanner-state-atomic.js'));

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return entry.isFile() && entry.name.endsWith('.js') ? [full] : [];
  });
}

test('scannerState has exactly one storage gateway across src', () => {
  const files = walk(srcRoot);
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    if (path.normalize(file) === centralWriter) {
      assert.match(source, /const originalGet = chrome\.storage\.local\.get\.bind\(chrome\.storage\.local\)/);
      assert.match(source, /const originalSet = chrome\.storage\.local\.set\.bind\(chrome\.storage\.local\)/);
      assert.match(source, /let scannerStateWriteQueue = Promise\.resolve\(\)/);
      assert.match(source, /export async function readScannerState\(\)/);
      assert.match(source, /export function updateScannerState\(mutator\)/);
      assert.match(source, /await originalSet\(\{ scannerState: next \}\)/);
      continue;
    }

    assert.doesNotMatch(
      source,
      /chrome\.storage\.local\.set\s*\(\s*\{\s*scannerState\b/,
      `${path.relative(root, file)} writes scannerState directly`
    );
    assert.doesNotMatch(
      source,
      /chrome\.storage\.local\.get\s*\([^)]*scannerState/,
      `${path.relative(root, file)} reads scannerState directly`
    );
    assert.doesNotMatch(
      source,
      /\bupdates\.scannerState\s*=/,
      `${path.relative(root, file)} writes scannerState through an updates object`
    );
    assert.doesNotMatch(
      source,
      /\bset\s*\(\s*\{\s*scannerState\b/,
      `${path.relative(root, file)} contains another scannerState storage writer`
    );
  }
});
