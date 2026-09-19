import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('current runtime accepts market data only through registered CasaTrade acquisition owners', () => {
  const entry = read('src/background-entry.js');
  const market = read('src/background-market-session.js');
  assert.match(entry, /background-market-session\.js/);
  assert.match(market, /senderMeta/);
  assert.match(market, /if \(!info\.trusted\) return null/);
});

test('manual trade flow remains confirmation-only', () => {
  const control = read('src/background-control.js');
  const handoff = read('src/content/trade-handoff-v2.js');
  assert.match(control, /signal_not_confirmed/);
  assert.match(control, /ATS_HIGHLIGHT_TRADE/);
  assert.doesNotMatch(control, /ATS_EXECUTE_TRADE/);
  assert.doesNotMatch(handoff, /\.click\s*\(/);
});
