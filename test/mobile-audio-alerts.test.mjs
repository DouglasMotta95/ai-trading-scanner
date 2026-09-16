import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../src/sidepanel/app-v2.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../src/sidepanel/index.html', import.meta.url), 'utf8');
const manifest = JSON.parse(fs.readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));

test('mobile alerts are deduplicated, haptic-capable and respect off/discrete/strong levels', () => {
  assert.equal(manifest.version, '0.11.13');
  assert.match(source, /navigator\?\.vibrate\?\./);
  assert.match(source, /function play\(kind\)/);
  assert.match(source, /play\('possible'\)/);
  assert.match(source, /play\('confirm'\)/);
  assert.match(source, /if \(key === lastSignalKey\) return/);
  assert.match(source, /prefs\.alertLevel === 'off'/);
  assert.match(source, /prefs\.alertLevel === 'strong'/);
  assert.match(source, /POSSIBLE_BUY/);
  assert.match(source, /ENTER_BUY/);
  assert.match(source, /entryTimeReady\(state\)/);
  assert.match(html, /id="alertLevel"/);
});
