import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('background accepts snapshots only from registered CasaTrade senders', () => {
  const background = read('src/background.js');
  assert.match(background, /const platform = detectPlatform\(host\)/);
  assert.match(background, /if \(!platform \|\| !sameTarget\(scannerState, sender\)\)/);
  assert.match(background, /connection: 'online'/);
});

test('manual trade flow remains confirmation-only', () => {
  const background = read('src/background.js');
  assert.match(background, /signal_not_confirmed/);
  assert.match(background, /platform_not_aligned/);
  assert.match(background, /ATS_HIGHLIGHT_TRADE/);
  assert.doesNotMatch(background, /ATS_EXECUTE_TRADE/);
});
